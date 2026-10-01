// ---------- Integraciones con software contable ----------
//
// Este módulo concentra todo lo específico de cada software contable
// (por ahora, Alegra) detrás de una interfaz pareja, para que agregar
// Siigo (o cualquier otro) más adelante sea sumar un adaptador nuevo,
// no reescribir server.js. server.js solo debería llamar a las
// funciones de más abajo (cifrar/descifrar, probarConexion, enviarFactura),
// nunca construir un payload de Alegra directamente.
//
// IMPORTANTE -- esto todavía no se probó contra una cuenta real de
// Alegra (no tenemos credenciales de prueba). Los nombres de endpoint y
// campos están tomados de developer.alegra.com, pero antes de confiar
// esto con datos de un cliente real, hay que conectar UNA cuenta de
// Alegra de verdad y mandar una factura de prueba -- si Alegra rechaza
// el payload, el error que devuelve dice exactamente qué campo no le
// gustó (ver alegraFetch, que siempre incluye el cuerpo del error de
// Alegra tal cual).

const crypto = require('crypto');

// ---------- Cifrado del token guardado (AES-256-GCM) ----------
//
// El token de Alegra de un contador es una credencial real con permiso
// de escritura sobre su contabilidad -- nunca se guarda en texto plano.
// La llave sale de INTEGRACIONES_ENCRYPTION_KEY (64 caracteres hex = 32
// bytes). Si falta, cifrar/descifrar lanzan un error claro en vez de
// fallar en silencio o guardar el token sin proteger.

function obtenerLlaveCifrado() {
  const hex = process.env.INTEGRACIONES_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    const err = new Error(
      'Falta configurar INTEGRACIONES_ENCRYPTION_KEY (64 caracteres hex, ej. generado con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))") -- sin esto no se pueden conectar integraciones de forma segura.'
    );
    err.status = 503;
    err.publicMessage = 'Las integraciones no están configuradas todavía en este servidor (falta una llave de cifrado). Contacta al administrador.';
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

function cifrar(texto) {
  const key = obtenerLlaveCifrado();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const cifrado = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${cifrado.toString('hex')}`;
}

function descifrar(valor) {
  const key = obtenerLlaveCifrado();
  const [ivHex, tagHex, dataHex] = String(valor).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Formato de token cifrado inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const texto = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return texto.toString('utf8');
}

// ---------- Adaptador de Alegra ----------

const ALEGRA_BASE = 'https://api.alegra.com/api/v1';

function alegraAuthHeader(cred) {
  return 'Basic ' + Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
}

// Todas las llamadas a Alegra pasan por aquí -- si Alegra rechaza algo,
// el error incluye el cuerpo de respuesta de Alegra tal cual (suele
// decir exactamente qué campo no le gustó), en vez de un mensaje
// genérico que no ayuda a diagnosticar.
async function alegraFetch(cred, method, path, body) {
  const res = await fetch(`${ALEGRA_BASE}${path}`, {
    method,
    headers: {
      Authorization: alegraAuthHeader(cred),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');

  if (!res.ok) {
    const detalle = typeof data === 'string' ? data : JSON.stringify(data);
    const err = new Error(`Alegra respondió ${res.status} en ${method} ${path}: ${detalle}`);
    err.status = res.status === 401 || res.status === 403 ? 401 : 502;
    err.publicMessage = res.status === 401 || res.status === 403
      ? 'Alegra rechazó las credenciales -- revisa el correo y el token e intenta conectar de nuevo.'
      : `Alegra no aceptó la información enviada: ${detalle}`.slice(0, 500);
    err.alegraBody = data;
    throw err;
  }

  return data;
}

// Llamada mínima, de solo lectura, para confirmar que el correo + token
// funcionan antes de guardarlos -- no crea ni modifica nada en la
// cuenta del contador.
async function alegraProbarConexion(cred) {
  await alegraFetch(cred, 'GET', '/contacts?limit=1');
  return true;
}

async function alegraObtenerImpuestos(cred) {
  const data = await alegraFetch(cred, 'GET', '/taxes');
  return Array.isArray(data) ? data : [];
}

async function alegraObtenerRetenciones(cred) {
  const data = await alegraFetch(cred, 'GET', '/retentions');
  return Array.isArray(data) ? data : [];
}

// Busca, entre las definiciones de impuesto/retención YA configuradas
// en la cuenta de Alegra del contador, la que más se acerque al
// porcentaje que Kárdex IA calculó a partir de los valores en pesos de
// la factura. Los ids de impuesto/retención son específicos de cada
// cuenta de Alegra -- nunca se puede asumir uno fijo.
function emparejarPorPorcentaje(lista, porcentajeObjetivo, tolerancia = 0.75) {
  let mejor = null;
  let mejorDiff = Infinity;
  for (const item of lista) {
    const pct = Number(item.percentage);
    if (isNaN(pct)) continue;
    const diff = Math.abs(pct - porcentajeObjetivo);
    if (diff <= tolerancia && diff < mejorDiff) {
      mejor = item;
      mejorDiff = diff;
    }
  }
  return mejor;
}

// Las retenciones colombianas en Alegra traen un campo "type" (u otro
// similar) que agrupa Fuente/IVA/ICA -- como el valor exacto que usa
// cada cuenta no está documentado de forma confiable, se filtra por
// palabra clave de forma tolerante (mayúsculas/minúsculas, con o sin
// tilde) en vez de comparar un valor exacto que podría no coincidir.
const RETENCION_KEYWORDS = {
  fuente: ['fuente', 'renta'],
  iva: ['iva'],
  ica: ['ica'],
};

function emparejarRetencion(retenciones, tipoKardex, porcentajeObjetivo) {
  const keywords = RETENCION_KEYWORDS[tipoKardex] || [];
  const candidatas = retenciones.filter((r) => {
    const texto = `${r.type || ''} ${r.name || ''}`.toLowerCase();
    return keywords.some((k) => texto.includes(k));
  });
  // Si la cuenta de Alegra no tiene ninguna retención del TIPO que se
  // busca (p.ej. no hay ninguna "ReteIVA" configurada), NO se debe caer
  // a buscar por porcentaje entre retenciones de otro tipo -- eso podría
  // emparejar por coincidencia numérica una ReteIVA con una ReteICA que
  // por casualidad tenga un porcentaje parecido, clasificando mal la
  // retención en la contabilidad real del contador. Sin candidatas del
  // tipo correcto, no hay match: se reporta en avisos y se revisa a mano.
  if (candidatas.length === 0) return null;
  return emparejarPorPorcentaje(candidatas, porcentajeObjetivo, 0.75);
}

// DD/MM/AAAA (formato que usa Kárdex IA en toda la app) -> AAAA-MM-DD
// (lo que espera la API de Alegra). Si la fecha no viene completa, usa
// hoy -- es mejor una fecha de hoy revisable que una llamada que falla
// por completo.
function convertirFechaAlegra(fechaDDMMAAAA) {
  const m = String(fechaDDMMAAAA || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return new Date().toISOString().slice(0, 10);
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Busca un proveedor existente en Alegra por NIT exacto; si no existe,
// lo crea. Evita duplicar el mismo proveedor cada vez que se envía una
// factura nueva de alguien con quien ya se trabajó antes.
async function alegraBuscarOCrearProveedor(cred, { nombre, nit }) {
  const nitLimpio = String(nit || '').replace(/[^\d]/g, '');
  if (nitLimpio) {
    const encontrados = await alegraFetch(cred, 'GET', `/contacts?identification=${encodeURIComponent(nitLimpio)}&type=provider`);
    if (Array.isArray(encontrados) && encontrados.length > 0) {
      return encontrados[0].id;
    }
  }

  const creado = await alegraFetch(cred, 'POST', '/contacts', {
    name: nombre || `Proveedor ${nitLimpio || 'sin NIT'}`,
    identification: nitLimpio || undefined,
    type: ['provider'],
  });
  return creado.id;
}

// Orquesta todo el envío de una factura ya guardada en Kárdex IA hacia
// Alegra como "factura de proveedor" (bill): busca/crea el proveedor,
// intenta emparejar IVA y retenciones con lo que YA está configurado en
// la cuenta de Alegra del contador, arma el payload, y lo envía.
//
// Nunca inventa un impuesto o retención que no pudo emparejar con
// certeza -- si no encuentra una coincidencia razonable, la omite y la
// reporta en "avisos" para que el contador la revise a mano en Alegra,
// en vez de mandar un monto que podría quedar mal clasificado en su
// contabilidad real.
async function alegraEnviarFactura(cred, invoiceRow) {
  const avisos = [];

  const providerId = await alegraBuscarOCrearProveedor(cred, {
    nombre: invoiceRow.nombre_razon_social,
    nit: invoiceRow.nit_cc,
  });

  const subtotal = Number(invoiceRow.valor_sin_iva) || 0;
  const valorIva = Number(invoiceRow.valor_iva) || 0;

  let itemTax = [];
  if (valorIva > 0 && subtotal > 0) {
    const impuestos = await alegraObtenerImpuestos(cred);
    const pctIva = Math.round((valorIva / subtotal) * 1000) / 10; // 1 decimal
    const match = emparejarPorPorcentaje(impuestos, pctIva);
    if (match) {
      itemTax = [{ id: match.id }];
    } else {
      avisos.push(`No se pudo emparejar el IVA (~${pctIva}%) con ningún impuesto configurado en tu cuenta de Alegra -- se envió sin IVA, revísalo manualmente allá.`);
    }
  }

  const retencionesFactura = [
    { key: 'rete_fuente', tipo: 'fuente', label: 'Rete Fuente' },
    { key: 'rete_iva', tipo: 'iva', label: 'ReteIVA' },
    { key: 'rete_ica', tipo: 'ica', label: 'ReteICA' },
  ];
  let billRetentions = [];
  const retencionesConValor = retencionesFactura.filter((r) => (Number(invoiceRow[r.key]) || 0) > 0 && subtotal > 0);
  if (retencionesConValor.length > 0) {
    const retencionesDisponibles = await alegraObtenerRetenciones(cred);
    for (const r of retencionesConValor) {
      const valor = Number(invoiceRow[r.key]) || 0;
      const pct = Math.round((valor / subtotal) * 1000) / 10;
      const match = emparejarRetencion(retencionesDisponibles, r.tipo, pct);
      if (match) {
        billRetentions.push({ id: match.id });
      } else {
        avisos.push(`No se pudo emparejar ${r.label} (~${pct}%) con ninguna retención configurada en tu cuenta de Alegra -- no se incluyó, revísala manualmente allá.`);
      }
    }
  }

  const numeroFactura = [invoiceRow.letras_fe, invoiceRow.numeros_fe].filter(Boolean).join('-');
  const payload = {
    date: convertirFechaAlegra(invoiceRow.fecha_factura),
    dueDate: convertirFechaAlegra(invoiceRow.fecha_factura),
    provider: providerId,
    purchases: {
      items: [
        {
          description: invoiceRow.concepto || invoiceRow.nombre_razon_social || 'Factura cargada desde Kárdex IA',
          price: subtotal,
          quantity: 1,
          tax: itemTax,
        },
      ],
    },
    observations: `Cargada automáticamente desde Kárdex IA${numeroFactura ? ` -- factura ${numeroFactura}` : ''}.`,
  };
  if (billRetentions.length > 0) payload.retentions = billRetentions;

  const bill = await alegraFetch(cred, 'POST', '/bills', payload);

  return { billId: bill?.id != null ? String(bill.id) : '', avisos };
}

// ---------- Adaptador de Siigo ----------
//
// IMPORTANTE -- igual que con Alegra, esto no se probó todavía contra
// una cuenta real de Siigo. Lo que sigue tiene distinto nivel de
// confianza según la parte:
//   - Autenticación, catálogo de impuestos/retenciones (misma tabla que
//     se consulta para ambos), y el emparejamiento por porcentaje: bien
//     documentado, misma lógica ya probada con Alegra.
//   - Tipo de comprobante y forma de pago: Siigo los exige, pero son
//     específicos de cada cuenta -- por eso NUNCA se adivinan, se le
//     piden al contador que los elija de su propia lista real (ver
//     siigoObtenerOpcionesConfiguracion) la primera vez que conecta.
//   - El renglón de la factura (`items[]`): Siigo pide un `code` de
//     producto/cuenta ya registrado, y Kárdex IA no mantiene catálogo
//     de productos -- se usa la subcuenta del PUC que el contador ya
//     elige por cada factura (`subcuenta_gasto`) como `type: "Account"`.
//     Esto es lo más razonable con los datos que hay, pero NO está
//     confirmado en la documentación pública que Siigo acepte una
//     cuenta así sin que exista un producto -- es lo primero a validar
//     con una cuenta de prueba real.
//   - Creación del proveedor (`POST /v1/customers`): el payload usa los
//     campos que sí confirma la documentación (identification,
//     check_digit, type) más un par de campos típicos (person_type,
//     id_type, name) que no se pudieron confirmar al 100% -- si Siigo
//     rechaza la creación, el error de Siigo (ver siigoFetch) dice
//     exactamente qué campo falta o no le gustó.

const SIIGO_BASE = 'https://api.siigo.com';
// Identificador de la integración -- Siigo lo exige en cada llamada
// (header Partner-Id) para saber qué software está llamando. Es un
// valor que uno mismo declara (no un ID que Siigo asigna).
const SIIGO_PARTNER_ID = 'KardexIA';

// Autentica usuario + clave de acceso (access_key, la credencial que
// el contador genera él mismo en Siigo Nube -> Alianzas -> Mi
// Credencial API) y devuelve el token temporal (24h) para el resto de
// llamadas. Se autentica de nuevo en cada operación en vez de guardar
// el token entre llamadas -- más simple y seguro que manejar su
// expiración, y el costo (una llamada extra) es insignificante frente
// a que el contador manda facturas una por una, no en lote automático.
async function siigoAutenticar(cred) {
  const res = await fetch(`${SIIGO_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Partner-Id': SIIGO_PARTNER_ID },
    body: JSON.stringify({ username: cred.email, access_key: cred.token }),
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  if (!res.ok || !data || !data.access_token) {
    const detalle = typeof data === 'string' ? data : JSON.stringify(data);
    const err = new Error(`Siigo respondió ${res.status} en POST /auth: ${detalle}`);
    err.status = (res.status === 401 || res.status === 403) ? 401 : 502;
    err.publicMessage = (res.status === 401 || res.status === 403)
      ? 'Siigo rechazó las credenciales -- revisa el usuario y la clave de acceso (access key) e intenta conectar de nuevo.'
      : `Siigo no aceptó la autenticación: ${detalle}`.slice(0, 500);
    throw err;
  }
  return data.access_token;
}

// Todas las llamadas autenticadas a Siigo pasan por aquí -- igual que
// alegraFetch, si Siigo rechaza algo el error incluye su respuesta tal
// cual, para poder diagnosticar rápido qué campo no le gustó.
async function siigoFetch(token, method, path, body) {
  const res = await fetch(`${SIIGO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Partner-Id': SIIGO_PARTNER_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  if (!res.ok) {
    const detalle = typeof data === 'string' ? data : JSON.stringify(data);
    const err = new Error(`Siigo respondió ${res.status} en ${method} ${path}: ${detalle}`);
    err.status = (res.status === 401 || res.status === 403) ? 401 : 502;
    err.publicMessage = (res.status === 401 || res.status === 403)
      ? 'Siigo rechazó la solicitud (credenciales o permisos) -- revisa la conexión en Integraciones.'
      : `Siigo no aceptó la información enviada: ${detalle}`.slice(0, 500);
    throw err;
  }
  return data;
}

async function siigoProbarConexion(cred) {
  await siigoAutenticar(cred);
  return true;
}

// Trae, de la cuenta real del contador, la lista de tipos de
// comprobante (filtrando por "FC" -- Factura de Compra, la
// convención estándar en software contable colombiano) y de formas de
// pago -- para que el contador elija cuál usar, en vez de que Kárdex
// IA adivine un ID que solo tiene sentido en SU cuenta de Siigo.
async function siigoObtenerOpcionesConfiguracion(cred) {
  const token = await siigoAutenticar(cred);
  const [tiposDocumentoRaw, formasPagoRaw] = await Promise.all([
    siigoFetch(token, 'GET', '/v1/document-types?type=FC').catch(() => []),
    siigoFetch(token, 'GET', '/v1/payment-types').catch(() => []),
  ]);
  const tiposDocumento = (Array.isArray(tiposDocumentoRaw) ? tiposDocumentoRaw : [])
    .filter((t) => t && t.active !== false)
    .map((t) => ({ id: t.id, nombre: t.name || t.code || `#${t.id}` }));
  const formasPago = (Array.isArray(formasPagoRaw) ? formasPagoRaw : [])
    .filter((t) => t && t.active !== false)
    .map((t) => ({ id: t.id, nombre: t.name || `#${t.id}` }));
  return { tiposDocumento, formasPago };
}

function siigoValidarConfiguracion(configuracion) {
  return !!(configuracion && configuracion.tipoDocumentoId && configuracion.formaPagoId);
}

// Busca un proveedor existente en Siigo por NIT; si no existe (o si la
// búsqueda falla -- ver nota arriba, no está confirmado al 100% el
// endpoint de búsqueda), lo crea. Nunca bloquea el envío de la
// factura por esto -- en el peor caso queda un proveedor duplicado en
// Siigo, que se puede fusionar después a mano; no es un dato de plata
// mal clasificado.
async function siigoBuscarOCrearProveedor(token, { nombre, nit, dv, tipoDoc }) {
  const nitLimpio = String(nit || '').replace(/[^\d]/g, '');
  if (!nitLimpio) return null;

  try {
    const encontrados = await siigoFetch(token, 'GET', `/v1/customers?identification=${encodeURIComponent(nitLimpio)}`);
    const lista = Array.isArray(encontrados) ? encontrados : (Array.isArray(encontrados?.results) ? encontrados.results : []);
    if (lista.length > 0) return lista[0].id;
  } catch (e) {
    // Sigue e intenta crear -- ver nota de la función.
  }

  const nuevo = await siigoFetch(token, 'POST', '/v1/customers', {
    type: 'Supplier',
    person_type: 'Company',
    id_type: { code: tipoDoc || '31' },
    identification: nitLimpio,
    check_digit: dv || undefined,
    name: [nombre || 'Proveedor sin nombre'],
  });
  return nuevo?.id;
}

// Orquesta el envío de una factura ya guardada en Kárdex IA hacia
// Siigo como factura de compra (`POST /v1/purchases`). Misma regla que
// con Alegra: nunca inventa un impuesto/retención que no pudo
// emparejar con certeza -- lo omite y lo reporta en `avisos`.
async function siigoEnviarFactura(cred, invoiceRow, configuracion) {
  const avisos = [];

  if (!siigoValidarConfiguracion(configuracion)) {
    const err = new Error('Falta configurar el tipo de comprobante y la forma de pago de Siigo para este contador.');
    err.status = 400;
    err.publicMessage = 'Termina de configurar Siigo (tipo de comprobante y forma de pago) en Integraciones antes de enviar facturas.';
    throw err;
  }

  const subcuenta = String(invoiceRow.subcuenta_gasto || '').trim();
  if (!subcuenta || subcuenta === 'inventario') {
    const err = new Error('La subcuenta del gasto de esta factura es de inventario -- Siigo exige un producto ya registrado en su catálogo para ese caso.');
    err.status = 400;
    err.publicMessage = 'Esta factura quedó como "Inventario -- mercancía para reventa". Siigo requiere que ese producto ya exista en su catálogo (Kárdex IA no lo gestiona) -- regístralo directamente en Siigo, o cambia la subcuenta del gasto de esta factura antes de enviarla.';
    throw err;
  }

  const token = await siigoAutenticar(cred);

  const nitLimpio = String(invoiceRow.nit_cc || '').replace(/[^\d]/g, '');
  await siigoBuscarOCrearProveedor(token, {
    nombre: invoiceRow.nombre_razon_social,
    nit: invoiceRow.nit_cc,
    dv: invoiceRow.dv,
    tipoDoc: invoiceRow.tipo_doc,
  });

  const subtotal = Number(invoiceRow.valor_sin_iva) || 0;
  const valorIva = Number(invoiceRow.valor_iva) || 0;
  const valorConIva = Number(invoiceRow.valor_con_iva) || (subtotal + valorIva);

  const necesitaCatalogo = (valorIva > 0 && subtotal > 0)
    || ['rete_fuente', 'rete_iva', 'rete_ica'].some((k) => (Number(invoiceRow[k]) || 0) > 0);
  let catalogoImpuestos = [];
  if (necesitaCatalogo) {
    const data = await siigoFetch(token, 'GET', '/v1/taxes');
    catalogoImpuestos = Array.isArray(data) ? data : [];
  }

  let itemTax = [];
  if (valorIva > 0 && subtotal > 0) {
    const pctIva = Math.round((valorIva / subtotal) * 1000) / 10;
    const match = emparejarPorPorcentaje(catalogoImpuestos, pctIva);
    if (match) {
      itemTax = [{ id: match.id }];
    } else {
      avisos.push(`No se pudo emparejar el IVA (~${pctIva}%) con ningún impuesto configurado en tu cuenta de Siigo -- se envió sin IVA, revísalo manualmente allá.`);
    }
  }

  const retencionesFactura = [
    { key: 'rete_fuente', tipo: 'fuente', label: 'Rete Fuente' },
    { key: 'rete_iva', tipo: 'iva', label: 'ReteIVA' },
    { key: 'rete_ica', tipo: 'ica', label: 'ReteICA' },
  ];
  const retenciones = [];
  for (const r of retencionesFactura) {
    const valor = Number(invoiceRow[r.key]) || 0;
    if (valor <= 0 || subtotal <= 0) continue;
    const pct = Math.round((valor / subtotal) * 1000) / 10;
    const match = emparejarRetencion(catalogoImpuestos, r.tipo, pct);
    if (match) {
      retenciones.push(match.id);
    } else {
      avisos.push(`No se pudo emparejar ${r.label} (~${pct}%) con ninguna retención configurada en tu cuenta de Siigo -- no se incluyó, revísala manualmente allá.`);
    }
  }

  const numeroFactura = [invoiceRow.letras_fe, invoiceRow.numeros_fe].filter(Boolean).join('-');
  const payload = {
    document: { id: configuracion.tipoDocumentoId },
    date: convertirFechaAlegra(invoiceRow.fecha_factura),
    supplier: { identification: nitLimpio, branch_office: 0 },
    provider_invoice: { prefix: invoiceRow.letras_fe || 'FE', number: invoiceRow.numeros_fe || '0' },
    observations: `Cargada automáticamente desde Kárdex IA${numeroFactura ? ` -- factura ${numeroFactura}` : ''}.`,
    items: [{
      type: 'Account',
      code: subcuenta,
      description: invoiceRow.concepto || invoiceRow.nombre_razon_social || 'Factura cargada desde Kárdex IA',
      quantity: 1,
      price: subtotal,
      taxes: itemTax,
    }],
    payments: [{ id: configuracion.formaPagoId, value: valorConIva }],
  };
  if (retenciones.length > 0) payload.retentions = retenciones;

  const compra = await siigoFetch(token, 'POST', '/v1/purchases', payload);

  return { billId: compra?.id != null ? String(compra.id) : '', avisos };
}

// ---------- Registro de proveedores soportados ----------
//
// server.js nunca debería importar nada de Alegra o Siigo
// directamente -- solo usa este registro por nombre, así agregar el
// próximo proveedor es sumar una entrada nueva, no tocar las rutas
// existentes. `obtenerOpcionesConfiguracion`/`validarConfiguracion` son
// opcionales -- solo los definen los proveedores que necesitan que el
// contador elija algo de su propia cuenta antes de poder enviar (hoy,
// Siigo); server.js los usa solo si existen.
const PROVEEDORES = {
  alegra: {
    nombre: 'Alegra',
    probarConexion: alegraProbarConexion,
    enviarFactura: alegraEnviarFactura,
  },
  siigo: {
    nombre: 'Siigo',
    probarConexion: siigoProbarConexion,
    enviarFactura: siigoEnviarFactura,
    obtenerOpcionesConfiguracion: siigoObtenerOpcionesConfiguracion,
    validarConfiguracion: siigoValidarConfiguracion,
  },
};

module.exports = {
  cifrar,
  descifrar,
  PROVEEDORES,
};
