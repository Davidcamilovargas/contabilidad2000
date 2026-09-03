// ---------- Retención en la fuente sugerida (fuente única para toda la app) ----------
// Antes esta tabla y este cálculo vivían duplicados en más de un
// archivo (Escanear tenía su propia versión resumida, Facturas tenía la
// versión completa que alimenta el Excel) -- eso es peligroso: si la
// norma cambia y solo se actualiza un archivo, la app queda dando
// respuestas distintas según la pantalla. Ahora este es el ÚNICO lugar
// que hay que tocar cuando cambie una tarifa o un umbral; todas las
// páginas (Escanear, Carga masiva, Facturas) cargan este mismo archivo.
//
// Tabla de retención en la fuente vigente (2026), solo para las
// categorías donde se confirmó la tarifa con fuentes actuales
// (Gerencie.com, cruzado con Siigo y Ámbito Jurídico). Para "otro" no
// se calcula -- no encaja en ninguna categoría confiable.
// La tarifa exacta depende de si el proveedor es declarante de renta o
// no (dato que casi nunca se sabe desde la factura) -- por eso se
// devuelve como RANGO (tarifa declarante -- tarifa no declarante) en
// las categorías donde de verdad cambia; el resto tiene una sola
// tarifa fija, sin importar si declara o no.
// Umbrales vigentes desde el 1 jul 2026 -- el Consejo de Estado revocó
// la suspensión del Decreto 572/2025 (exp. 30229), así que volvieron a
// aplicar las bases originales del decreto. Verificado contra tabla de
// retención en la fuente 2026 (Gerencie.com, cruzado con Siigo/Alegra)
// el 3 de sept de 2026.
//
// IMPORTANTE -- esto NO es asesoría tributaria: es una tabla que se
// mantiene a mano según la norma vigente al momento de escribir esto.
// La base de retención en la fuente ha cambiado varias veces solo en
// 2026 por decisiones judiciales -- revisa la norma actual antes de
// confiar ciegamente en estos valores, y actualiza este archivo (es el
// único que hace falta tocar) en cuanto cambie algo.
// `cuentaPUC` -- la subcuenta del Plan Único de Cuentas (grupo 2365,
// "Retención en la fuente") donde contablemente se registra cada
// categoría, según puc.com.co. El PUC no tiene subcuenta propia para
// transporte, software, vigilancia ni hoteles dentro de Retención en
// la fuente -- contablemente se registran como "Servicios" (236525),
// aunque la DIAN les aplique una tarifa de retención distinta. La
// tarifa depende de la norma; la cuenta depende del PUC -- son cosas
// separadas. Rete IVA (cuenta 2367) y Rete ICA (cuenta 2368) están
// aparte, en CUENTAS_PUC_FIJAS, porque no dependen de la categoría.
//
// `umbralUvt` -- la base mínima está fijada EN UVT por la norma, no en
// pesos. Antes esta tabla tenía el peso ya calculado a mano (524000,
// 105000...) y había que acordarse de recalcular TODOS esos números
// cada vez que cambiaba la UVT (pasa cada enero, y a veces más --
// 2026 tuvo cambios judiciales a mitad de año). Ahora el peso se
// calcula solo, cruzando `umbralUvt` con el valor de UVT del AÑO DE LA
// FACTURA (ver UVT_POR_ANIO más abajo) -- así una factura de 2025 usa
// la UVT de 2025 y una de 2026 usa la de 2026, automáticamente.
const TARIFAS_RETENCION = {
  compras:                 { umbralUvt: 10, tarifaBaja: 0.025, tarifaAlta: 0.035, cuentaPUC: '236540', nombrePUC: 'Compras' },
  compras_tarjeta:         { umbralUvt: 0,  tarifaBaja: 0.015, tarifaAlta: 0.015, cuentaPUC: '236540', nombrePUC: 'Compras' },
  servicios:                { umbralUvt: 2,  tarifaBaja: 0.04,  tarifaAlta: 0.06,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  honorarios_juridica:      { umbralUvt: 0,  tarifaBaja: 0.11,  tarifaAlta: 0.11,  cuentaPUC: '236515', nombrePUC: 'Honorarios' },
  honorarios_natural:       { umbralUvt: 0,  tarifaBaja: 0.10,  tarifaAlta: 0.11,  cuentaPUC: '236515', nombrePUC: 'Honorarios' },
  arrendamiento_muebles:    { umbralUvt: 0,  tarifaBaja: 0.04,  tarifaAlta: 0.04,  cuentaPUC: '236530', nombrePUC: 'Arrendamientos' },
  arrendamiento_inmuebles:  { umbralUvt: 10, tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236530', nombrePUC: 'Arrendamientos' },
  transporte_carga:         { umbralUvt: 2,  tarifaBaja: 0.01,  tarifaAlta: 0.01,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  transporte_pasajeros:     { umbralUvt: 10, tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
  licenciamiento_software:  { umbralUvt: 0,  tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
  vigilancia_aseo:          { umbralUvt: 2,  tarifaBaja: 0.02,  tarifaAlta: 0.02,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  hoteles_restaurantes:     { umbralUvt: 2,  tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
};

// ---------- UVT (Unidad de Valor Tributario) por año ----------
//
// Valores oficiales publicados por la DIAN. Se agrega una fila nueva
// cada enero cuando la DIAN publica el valor del año -- es el ÚNICO
// número que hay que actualizar; todos los umbrales de arriba se
// recalculan solos a partir de esto.
//   2025: Resolución DIAN, $49.799 (confirmado, aumento 5.81% vs 2024)
//   2026: Resolución DIAN, $52.374 (confirmado)
const UVT_POR_ANIO = {
  2025: 49799,
  2026: 52374,
};
// Año más reciente conocido -- se usa como respaldo para facturas de
// años aún no agregados a la tabla (ej. si ya estamos en un año nuevo
// y todavía no se agrega la fila). Mejor una UVT un poco desactualizada
// que un umbral de $0 que fuerce a calcular retención sobre cualquier
// centavo.
const UVT_ANIO_MAS_RECIENTE = 2026;

function valorUvt(anio) {
  if (UVT_POR_ANIO[anio] != null) return UVT_POR_ANIO[anio];
  return UVT_POR_ANIO[UVT_ANIO_MAS_RECIENTE];
}

// La fecha de factura en esta app siempre viene como texto DD/MM/AAAA.
function anioDeFechaFactura(fechaFactura) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(fechaFactura || '').trim());
  if (m) return Number(m[3]);
  return UVT_ANIO_MAS_RECIENTE;
}

// Umbral en pesos para una categoría, según la fecha de la factura.
function umbralPesos(configBase, fechaFactura) {
  const anio = anioDeFechaFactura(fechaFactura);
  return Math.round((configBase.umbralUvt || 0) * valorUvt(anio));
}

// Cuentas PUC fijas para Rete IVA y Rete ICA -- no dependen de la
// categoría del concepto de la factura, así que viven aparte.
const CUENTAS_PUC_FIJAS = {
  rete_iva: { cuentaPUC: '2367', nombrePUC: 'Impuesto a las ventas retenido' },
  rete_ica: { cuentaPUC: '2368', nombrePUC: 'Impuesto de industria y comercio retenido' },
};

// ---------- Subcuentas del gasto (no de la retención) ----------
//
// Esto es distinto a `cuentaPUC`/`nombrePUC` de arriba -- aquella es
// la cuenta donde se registra LA RETENCIÓN (una deuda con la DIAN,
// grupo 2365). Esto de aquí es la cuenta donde se registra EL GASTO
// EN SÍ (la compra o el servicio), que vive en la clase 5 del PUC.
//
// El contador elige la subcuenta exacta (nunca se adivina sola) --
// mismo principio que ya usamos para la categoría de retención: el
// sistema no decide algo ambiguo por su cuenta, el contador confirma
// y el sistema aplica el resto solo a partir de ahí.
//
// La primera opción de cada lista es la que se preselecciona por
// defecto (la más común), pero el contador puede cambiarla siempre.
const SUBCUENTAS_GASTO = {
  compras: [
    ['inventario', 'Inventarios -- mercancía para reventa'],
    ['519530', 'Útiles, papelería y fotocopias'],
    ['519525', 'Elementos de aseo y cafetería'],
    ['519535', 'Combustibles y lubricantes'],
    ['519540', 'Envases y empaques'],
    ['519595', 'Otros (Diversos)'],
  ],
  compras_tarjeta: [
    ['519530', 'Útiles, papelería y fotocopias'],
    ['519525', 'Elementos de aseo y cafetería'],
    ['519535', 'Combustibles y lubricantes'],
    ['519595', 'Otros (Diversos)'],
  ],
  servicios: [
    ['513595', 'Servicios -- Otros'],
    ['513510', 'Temporales'],
    ['513525', 'Acueducto y alcantarillado'],
    ['513530', 'Energía eléctrica'],
    ['513535', 'Teléfono'],
    ['513555', 'Gas'],
  ],
  honorarios_juridica: [
    ['511095', 'Honorarios -- Otros'],
    ['511010', 'Revisoría fiscal'],
    ['511015', 'Auditoría externa'],
    ['511025', 'Asesoría jurídica'],
    ['511030', 'Asesoría financiera'],
    ['511035', 'Asesoría técnica'],
  ],
  honorarios_natural: [
    ['511095', 'Honorarios -- Otros'],
    ['511025', 'Asesoría jurídica'],
    ['511030', 'Asesoría financiera'],
    ['511035', 'Asesoría técnica'],
  ],
  arrendamiento_muebles: [
    ['512015', 'Maquinaria y equipo'],
    ['512020', 'Equipo de oficina'],
    ['512025', 'Equipo de computación y comunicación'],
    ['512040', 'Flota y equipo de transporte'],
    ['512095', 'Otros'],
  ],
  arrendamiento_inmuebles: [
    ['512010', 'Construcciones y edificaciones'],
  ],
  transporte_carga: [
    ['513550', 'Transporte, fletes y acarreos'],
  ],
  transporte_pasajeros: [
    ['519545', 'Taxis y buses'],
    ['515520', 'Pasajes terrestres (gastos de viaje)'],
  ],
  licenciamiento_software: [
    ['513520', 'Procesamiento electrónico de datos'],
    ['513595', 'Servicios -- Otros'],
  ],
  vigilancia_aseo: [
    ['513505', 'Aseo y vigilancia'],
  ],
  hoteles_restaurantes: [
    ['519560', 'Casino y restaurante'],
    ['515505', 'Alojamiento y manutención (gastos de viaje)'],
  ],
  otro: [
    ['519595', 'Diversos -- Otros'],
  ],
};


// ---------- Perfil fiscal del tercero (persistido, por NIT) ----------
//
// Antes lo ÚNICO que decidía si un proveedor era Régimen Simple era lo
// que la IA leyera de ESE documento puntual (`inv.regimen_simple`) --
// si la IA se equivocaba en la lectura, o el proveedor no lo declaraba
// visible en esa factura, la retención se calculaba mal sin que nadie
// se diera cuenta. Ahora, si el contador ya marcó el perfil fiscal de
// ese NIT una vez (ficha de terceros), ESO manda -- sin importar lo
// que la lectura automática sugiera en la factura de turno.
//
// `perfilTercero` es lo que devuelve GET /api/terceros-fiscales para
// ese NIT: { gran_contribuyente, autorretenedor, regimen_simple,
// agente_retencion_iva } -- o null/undefined si el contador nunca
// marcó nada para ese NIT (en ese caso, se cae de vuelta a lo que la
// IA leyó en el documento, como antes).
function perfilFiscalEfectivo(inv, perfilTercero) {
  const regimenSimple = !!(perfilTercero && perfilTercero.regimen_simple) ||
    inv.regimen_simple === true || inv.regimen_simple === 'true';
  const autorretenedor = !!(perfilTercero && perfilTercero.autorretenedor);
  return { regimenSimple, autorretenedor };
}

// Calcula la retención en la fuente SUGERIDA (estimada -- no oficial, no
// leída del documento) para una factura, cruzando la categoría del
// concepto, si el cliente es agente retenedor, y el perfil fiscal del
// proveedor (Régimen Simple / Autorretenedor). Si la factura mezcla
// categorías (ej. productos + mano de obra en una misma factura), usa
// el desglose guardado y calcula cada parte por separado contra su
// propio umbral y tarifa, en vez de tratar todo el subtotal como una
// sola categoría.
//
// `cliente` necesita al menos `{ agente_retenedor }`.
// `tarifasAprendidas` es un objeto { "NIT|categoria": tarifaExacta } --
// si ya se confirmó la tarifa real de un proveedor antes, se usa esa en
// vez de un rango. Pasa {} (o nada) si no la tienes disponible.
// `perfilTercero` -- ver perfilFiscalEfectivo() arriba. Opcional, pasa
// null/undefined si no se cargó (se comporta como antes: solo mira
// inv.regimen_simple).
//
// Devuelve null cuando no se puede/debe calcular nada, o
// { bajo, alto, mismaTarifa } en pesos colombianos (COP).
function calcularRetencionSugerida(inv, cliente, tarifasAprendidas, perfilTercero){
  tarifasAprendidas = tarifasAprendidas || {};
  if (!cliente || !cliente.agente_retenedor) return null; // nunca le corresponde retener

  const perfil = perfilFiscalEfectivo(inv, perfilTercero);
  if (perfil.regimenSimple) return null; // Régimen Simple -- Rete Fuente no aplica
  if (perfil.autorretenedor) return null; // el proveedor se autorretiene -- el comprador no debe practicar retención ordinaria

  function tarifaParaProveedor(categoria, nitProveedor, config) {
    const aprendida = tarifasAprendidas[`${nitProveedor}|${categoria}`];
    if (aprendida !== undefined) return { tarifaBaja: aprendida, tarifaAlta: aprendida, aprendida: true };
    return config;
  }

  let desglose = null;
  try {
    const raw = inv.desglose_categorias;
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
      desglose = parsed;
    }
  } catch (e) { desglose = null; }

  if (desglose) {
    let bajoTotal = 0, altoTotal = 0, huboAlguno = false, mismaTarifaEnTodas = true;
    const cuentasInvolucradas = new Map(); // cuentaPUC -> nombrePUC, sin duplicados
    for (const [categoriaParte, montoParte] of Object.entries(desglose)) {
      const configBase = TARIFAS_RETENCION[String(categoriaParte).toLowerCase()];
      const subtotalParte = Number(montoParte) || 0;
      if (!configBase || subtotalParte < umbralPesos(configBase, inv.fecha_factura)) continue; // esta parte no aplica, se omite
      const config = tarifaParaProveedor(categoriaParte, inv.nit_cc || '', configBase);
      bajoTotal += Math.round(subtotalParte * config.tarifaBaja);
      altoTotal += Math.round(subtotalParte * config.tarifaAlta);
      huboAlguno = true;
      if (config.tarifaBaja !== config.tarifaAlta) mismaTarifaEnTodas = false;
      cuentasInvolucradas.set(configBase.cuentaPUC, configBase.nombrePUC);
    }
    if (!huboAlguno) return null; // ninguna de las partes superó su umbral
    return {
      bajo: bajoTotal, alto: altoTotal, mismaTarifa: mismaTarifaEnTodas,
      cuentasPUC: [...cuentasInvolucradas.entries()].map(([cuenta, nombre]) => ({ cuenta, nombre })),
    };
  }

  // Sin desglose -- factura de una sola categoría, comportamiento normal.
  const categoria = (inv.categoria_concepto || '').toLowerCase();
  const configBase = TARIFAS_RETENCION[categoria];
  if (!configBase) return null; // "otro" -- tarifa no confirmada, no adivinamos

  const subtotal = Number(inv.valor_sin_iva) || 0;
  if (subtotal < umbralPesos(configBase, inv.fecha_factura)) return null; // bajo el umbral, no aplica

  const config = tarifaParaProveedor(categoria, inv.nit_cc || '', configBase);
  const bajo = Math.round(subtotal * config.tarifaBaja);
  const alto = Math.round(subtotal * config.tarifaAlta);
  return {
    bajo, alto, mismaTarifa: config.tarifaBaja === config.tarifaAlta,
    cuentasPUC: [{ cuenta: configBase.cuentaPUC, nombre: configBase.nombrePUC }],
  };
}

// ---------- Retención de IVA (ReteIVA) ----------
//
// Es un cálculo aparte de la retención en la fuente de arriba -- no
// depende de la categoría del concepto, se aplica sobre el valor del
// IVA de la factura (no sobre el subtotal). Tarifa general vigente:
// 15% del IVA (Art. 437-1 del Estatuto Tributario) -- el Gobierno
// puede fijarla hasta 50%, y hay casos especiales al 100% (servicios
// de no residentes, chatarra) que esta función no cubre, por ser
// casos poco comunes para un contador independiente.
//
// Usa el mismo umbral de la categoría (2 UVT servicios, 10 UVT
// compras, etc.) aplicado sobre el SUBTOTAL -- es la misma cuantía
// mínima que la retención en la fuente normal, según la tabla DIAN.
const RETEIVA_TARIFA_GENERAL = 0.15;

// Calcula el ReteIVA sugerido para una factura -- devuelve el monto
// en pesos, o null si no aplica (cliente no es agente retenedor, no
// hay IVA, o el subtotal no supera el umbral de su categoría).
//
// OJO -- a propósito NO se exime aquí por Régimen Simple ni por
// Autorretenedor: esos dos solo eximen de Rete Fuente (renta) y de
// ICA -- un proveedor de Régimen Simple responsable de IVA SÍ puede
// tener ReteIVA practicado sobre sus ventas (verificado: la exención
// del RST aplica a renta e ICA, no a IVA). Mezclar esa regla aquí
// sería inventar una exención que la norma no da -- por eso
// `calcularRetencionSugerida()` sí revisa el perfil fiscal y esta
// función no.
function calcularReteIvaSugerido(inv, cliente){
  if (!cliente || !cliente.agente_retenedor) return null;

  const ivaValor = Number(inv.valor_iva) || 0;
  if (ivaValor <= 0) return null; // sin IVA, no hay nada que retener

  const categoria = (inv.categoria_concepto || '').toLowerCase();
  const config = TARIFAS_RETENCION[categoria];
  // Sin una categoría con umbral confiable, no adivinamos -- mismo
  // criterio que calcularRetencionSugerida().
  if (!config) return null;

  const subtotal = Number(inv.valor_sin_iva) || 0;
  if (subtotal < umbralPesos(config, inv.fecha_factura)) return null;

  return Math.round(ivaValor * RETEIVA_TARIFA_GENERAL);
}