'use strict';

// Cartera / conciliación bancaria -- lee extractos de banco (PDF vía IA,
// o CSV nativo sin depender de ninguna librería npm) y PROPONE qué
// movimiento del banco corresponde a qué factura pendiente. Sigue la
// misma filosofía del resto de Kárdex IA: nunca marca algo como pagado
// solo -- solo sugiere, con un nivel de confianza, y el contador
// siempre confirma con un clic (o lo corrige a mano).

// ---------- Lectura del extracto con IA (PDF) ----------

const EXTRACTO_PROMPT = `Eres un asistente contable colombiano. Vas a leer un extracto bancario (de cualquier banco colombiano: Bancolombia, Davivienda, BBVA, Banco de Bogotá, Banco Agrario, etc.), tal como llega adjunto en el correo del banco.

Tu tarea es extraer CADA MOVIMIENTO (fila) de la tabla de transacciones del extracto -- no el resumen ni el saldo inicial/final, solo los movimientos individuales -- y devolver SOLO un arreglo JSON válido, sin texto adicional, sin markdown, sin backticks:

[
  {
    "fecha": "fecha del movimiento en formato DD/MM/AAAA. Si el extracto no trae el año en cada fila (algunos bancos solo ponen día/mes), infiere el año del encabezado o periodo del extracto",
    "descripcion": "la descripción u observación del movimiento tal como aparece (nombre de quien pagó/recibió, referencia, tipo de transacción), sin resumir ni traducir",
    "valor": "el valor del movimiento en pesos colombianos ENTEROS, siempre positivo (ver regla de formato abajo)",
    "tipo": "'credito' si el dinero ENTRÓ a la cuenta (abono, consignación, transferencia recibida), 'debito' si el dinero SALIÓ de la cuenta (retiro, pago, transferencia enviada, comisión)"
  }
]

REGLA DE FORMATO PARA EL VALOR (muy importante, es el error más común):
Los extractos colombianos escriben los montos con PUNTO como separador de miles y COMA para los centavos (ej: "1.350.000,00" significa un millón trescientos cincuenta mil pesos). Devuelve el valor como un ENTERO en pesos, redondeando los centavos, SIN puntos, SIN comas.

Ignora por completo: el saldo inicial, el saldo final, los totales o subtotales de resumen, encabezados de página, pie de página con información legal del banco, y cualquier fila que no sea un movimiento individual con su propia fecha y valor.

Si el extracto tiene varias páginas, procesa todas las páginas y devuelve todos los movimientos en un solo arreglo, en el mismo orden en que aparecen.

Si genuinamente no logras identificar ningún movimiento (el archivo no parece ser un extracto bancario), devuelve un arreglo vacío [].`;

// ---------- Lectura del extracto en CSV (sin depender de ninguna librería externa) ----------
//
// Nota deliberada: esto NO lee archivos .xlsx binarios (Excel real).
// Parsearlos bien requeriría una librería (ej. la conocida "xlsx" /
// SheetJS) que este entorno no pudo instalar para probarla en serio --
// se documenta como trabajo futuro. La mayoría de bancos colombianos sí
// permiten exportar el extracto como CSV además de PDF, así que este
// parser cubre ese caso sin depender de nada externo.

const COLUMNAS_FECHA = ['fecha', 'fecha movimiento', 'fecha transaccion', 'fecha transacción'];
const COLUMNAS_DESCRIPCION = ['descripcion', 'descripción', 'detalle', 'concepto', 'observacion', 'observación', 'referencia', 'nota'];
const COLUMNAS_VALOR = ['valor', 'monto', 'importe'];
const COLUMNAS_DEBITO = ['debito', 'débito', 'debitos', 'débitos', 'cargo', 'cargos', 'valor debito', 'valor débito'];
const COLUMNAS_CREDITO = ['credito', 'crédito', 'creditos', 'créditos', 'abono', 'abonos', 'valor credito', 'valor crédito'];

function normalizarEncabezado(s) {
  return String(s || '').trim().toLowerCase();
}

// Parser de CSV mínimo pero correcto: respeta comillas dobles (comas y
// saltos de línea dentro de un campo entrecomillado, "" como comilla
// escapada). Acepta tanto coma como punto y coma como separador, porque
// Excel en español suele exportar con punto y coma.
function parsearFilasCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let dentroComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else { dentroComillas = false; }
      } else {
        campo += c;
      }
    } else {
      if (c === '"') dentroComillas = true;
      else if (c === ',' || c === ';') { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (c === '\r') { /* ignorar, \n cierra la fila */ }
      else campo += c;
    }
  }
  if (campo.length > 0 || fila.length > 0) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(c => c.trim() !== ''));
}

function parsearValorMonetario(str) {
  if (str === undefined || str === null) return null;
  let s = String(str).trim();
  if (!s) return null;
  const negativo = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()\-]/g, '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const ultimoComa = s.lastIndexOf(',');
  const ultimoPunto = s.lastIndexOf('.');
  if (ultimoComa > -1 && ultimoPunto > -1) {
    if (ultimoComa > ultimoPunto) { s = s.replace(/\./g, '').replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (ultimoComa > -1) {
    const decimales = s.length - ultimoComa - 1;
    s = decimales === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ultimoPunto > -1) {
    const decimales = s.length - ultimoPunto - 1;
    if (decimales !== 2) s = s.replace(/\./g, '');
  }
  const n = Math.round(Number(s));
  if (isNaN(n)) return null;
  return negativo ? -Math.abs(n) : n;
}

// Los bancos exportan la fecha en formatos distintos (AAAA-MM-DD,
// DD/MM/AAAA, DD-MM-AAAA...) -- se normaliza siempre a DD/MM/AAAA para
// que coincida con el formato que ya usa el resto de Kárdex IA.
function normalizarFechaCSV(fecha) {
  const f = String(fecha || '').trim();
  let m = f.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = f.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return f; // si no se reconoce el formato, se deja tal cual -- mejor que inventar
}

// Recibe el texto plano de un CSV (ya decodificado) y devuelve los
// movimientos detectados. Lanza un error con .publicMessage si no logra
// identificar las columnas necesarias -- preferimos avisar claro a
// adivinar mal una columna de dinero.
function parseCSVExtracto(texto) {
  const filas = parsearFilasCSV(texto);
  if (filas.length < 2) {
    const err = new Error('El archivo CSV no tiene filas suficientes.');
    err.publicMessage = 'El archivo no parece tener datos -- revisa que sea el CSV exportado del extracto, con encabezados y al menos un movimiento.';
    throw err;
  }

  const encabezados = filas[0].map(normalizarEncabezado);
  const idx = (lista) => encabezados.findIndex(h => lista.includes(h));

  const iFecha = idx(COLUMNAS_FECHA);
  const iDescripcion = idx(COLUMNAS_DESCRIPCION);
  const iValor = idx(COLUMNAS_VALOR);
  const iDebito = idx(COLUMNAS_DEBITO);
  const iCredito = idx(COLUMNAS_CREDITO);

  if (iFecha === -1 || iDescripcion === -1 || (iValor === -1 && iDebito === -1 && iCredito === -1)) {
    const err = new Error('No se reconocieron las columnas del CSV.');
    err.publicMessage = 'No logramos reconocer las columnas del CSV (se necesita al menos fecha, descripción, y una columna de valor o de débito/crédito). Revisa que el archivo sea el extracto exportado directo del banco, con encabezados en la primera fila. Si tu extracto solo viene en PDF, súbelo como PDF -- Kárdex IA también lee extractos en PDF.';
    throw err;
  }

  const movimientos = [];
  for (let r = 1; r < filas.length; r++) {
    const fila = filas[r];
    const fecha = (fila[iFecha] || '').trim();
    const descripcion = (fila[iDescripcion] || '').trim();
    if (!fecha && !descripcion) continue;

    let valor = null, tipo = null;
    const vDebito = iDebito > -1 ? parsearValorMonetario(fila[iDebito]) : null;
    const vCredito = iCredito > -1 ? parsearValorMonetario(fila[iCredito]) : null;
    if (vDebito) { valor = Math.abs(vDebito); tipo = 'debito'; }
    else if (vCredito) { valor = Math.abs(vCredito); tipo = 'credito'; }
    else if (iValor > -1) {
      const v = parsearValorMonetario(fila[iValor]);
      if (v) { valor = Math.abs(v); tipo = v < 0 ? 'debito' : 'credito'; }
    }
    if (!valor || !tipo) continue; // fila sin valor reconocible -- probablemente una fila de resumen

    movimientos.push({ fecha: normalizarFechaCSV(fecha), descripcion, valor, tipo });
  }

  if (movimientos.length === 0) {
    const err = new Error('No se extrajo ningún movimiento del CSV.');
    err.publicMessage = 'Se reconocieron las columnas pero no se pudo leer ningún movimiento válido -- revisa el archivo.';
    throw err;
  }

  return movimientos;
}

// ---------- Emparejamiento movimiento <-> factura ----------

function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Busca secuencias de 6 a 10 dígitos seguidos en un texto -- así suelen
// aparecer los NIT dentro de la descripción de una transferencia.
function extraerPosiblesNit(texto) {
  return String(texto || '').match(/\d{6,10}/g) || [];
}

function fechaAOrdinal(fecha) {
  const partes = String(fecha || '').split('/');
  if (partes.length !== 3) return null;
  const [d, m, y] = partes;
  if (!d || !m || !y) return null;
  const t = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  return isNaN(t) ? null : t;
}

const TOLERANCIA_VALOR_EXACTO = 500; // pesos -- redondeos de centavos
const TOLERANCIA_VALOR_APROX = 0.05; // 5% -- solo para el cruce por nombre/NIT cuando el valor no es exacto
const TOLERANCIA_DIAS = 90; // no proponer cruces contra facturas mucho más viejas que el movimiento

// Recibe UN movimiento del banco ({fecha, descripcion, valor, tipo}), y
// la lista de facturas pendientes del cliente correcto -- cada una debe
// traer ya calculado `saldo_pendiente` (valor_con_iva menos lo ya
// conciliado). Devuelve:
//   { facturaId, confianza: 'alta'|'media', aviso: '' }  -- candidato encontrado
//   { facturaId: null, confianza: '', aviso: '...' }     -- ambigüedad real, no se puede elegir solo
//   null                                                  -- nada que sugerir
// Nunca elige "el menos malo" entre candidatos ambiguos -- ante la duda,
// prefiere no sugerir (o avisar la ambigüedad) antes que arriesgar
// marcar el pago contra la factura equivocada.
function emparejarMovimiento(movimiento, facturasPendientes) {
  const tipoFacturaEsperado = movimiento.tipo === 'credito' ? 'ingreso' : 'egreso';
  const fechaMov = fechaAOrdinal(movimiento.fecha);

  let candidatas = (facturasPendientes || []).filter(f =>
    f.tipo_movimiento === tipoFacturaEsperado && Number(f.saldo_pendiente) > 0
  );

  if (fechaMov) {
    candidatas = candidatas.filter(f => {
      const fFactura = fechaAOrdinal(f.fecha_factura);
      if (!fFactura) return true;
      return Math.abs(fechaMov - fFactura) / 86400000 <= TOLERANCIA_DIAS;
    });
  }

  if (candidatas.length === 0) return null;

  const exactas = candidatas.filter(f => Math.abs(Number(f.saldo_pendiente) - movimiento.valor) <= TOLERANCIA_VALOR_EXACTO);
  if (exactas.length === 1) {
    return { facturaId: exactas[0].id, confianza: 'alta', aviso: '' };
  }
  if (exactas.length > 1) {
    const nits = extraerPosiblesNit(movimiento.descripcion);
    const porNit = exactas.filter(f => nits.includes(f.nit_cc) || nits.includes(f.adquiriente_nit));
    if (porNit.length === 1) return { facturaId: porNit[0].id, confianza: 'alta', aviso: '' };
    return { facturaId: null, confianza: '', aviso: `Hay ${exactas.length} facturas pendientes con el mismo valor ($${movimiento.valor.toLocaleString('es-CO')}) -- revisa a mano cuál corresponde.` };
  }

  const nits = extraerPosiblesNit(movimiento.descripcion);
  if (nits.length > 0) {
    const porNit = candidatas.filter(f =>
      (nits.includes(f.nit_cc) || nits.includes(f.adquiriente_nit)) &&
      Math.abs(Number(f.saldo_pendiente) - movimiento.valor) <= Number(f.saldo_pendiente) * TOLERANCIA_VALOR_APROX
    );
    if (porNit.length === 1) {
      return { facturaId: porNit[0].id, confianza: 'media', aviso: 'El valor no coincide exacto con el saldo de la factura -- puede ser un pago parcial o con descuento. Revisa antes de confirmar.' };
    }
  }

  const descNorm = normalizarTexto(movimiento.descripcion);
  const porNombre = candidatas.filter(f => {
    const nombre = normalizarTexto(f.tipo_movimiento === 'ingreso' ? f.adquiriente_nombre : f.nombre_razon_social);
    if (!nombre || nombre.length < 4) return false;
    const palabras = nombre.split(' ').filter(p => p.length >= 4);
    const coincide = palabras.some(p => descNorm.includes(p));
    return coincide && Math.abs(Number(f.saldo_pendiente) - movimiento.valor) <= Number(f.saldo_pendiente) * TOLERANCIA_VALOR_APROX;
  });
  if (porNombre.length === 1) {
    return { facturaId: porNombre[0].id, confianza: 'media', aviso: 'El nombre coincide pero el valor no es exacto -- revisa antes de confirmar.' };
  }

  return null;
}

module.exports = {
  EXTRACTO_PROMPT,
  parseCSVExtracto,
  emparejarMovimiento,
  normalizarTexto,
};
