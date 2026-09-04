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
//
// `baseEspecial: 'aiu'` -- SOLO en vigilancia_aseo y servicios_temporales.
// Marca las dos categorías donde la DIAN aplica una regla de dos pasos
// distinta al resto (Concepto DIAN 100202208-1587, ago 2026): el umbral
// de arriba se prueba contra el valor BRUTO de la factura (igual que
// cualquier otra categoría), pero la TARIFA se aplica solo sobre el
// componente de AIU (Administración + Imprevistos + Utilidad), nunca
// sobre el bruto -- ver calcularRetencionCategoriaLinea() más abajo,
// que es donde vive toda la lógica especial.
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
  vigilancia_aseo:          { umbralUvt: 2,  tarifaBaja: 0.02,  tarifaAlta: 0.02,  cuentaPUC: '236525', nombrePUC: 'Servicios', baseEspecial: 'aiu' },
  servicios_temporales:     { umbralUvt: 2,  tarifaBaja: 0.01,  tarifaAlta: 0.01,  cuentaPUC: '236525', nombrePUC: 'Servicios', baseEspecial: 'aiu' },
  hoteles_restaurantes:     { umbralUvt: 2,  tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
};

// El piso presuntivo de AIU que fija la norma para estos dos conceptos
// (aseo/vigilancia y temporales): si el contrato no desglosa AIU, o lo
// desglosa por debajo de este mínimo, la tarifa se aplica sobre este
// piso -- nunca sobre un AIU menor, así el proveedor no pueda reducir
// la base reportando un AIU artificialmente bajo.
const AIU_PISO_PORCENTAJE = 0.10;

function esCategoriaBaseAiu(categoria) {
  const config = TARIFAS_RETENCION[String(categoria || '').toLowerCase()];
  return !!(config && config.baseEspecial === 'aiu');
}

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
  servicios_temporales: [
    ['513510', 'Temporales'],
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
// Pieza compartida: calcula la retención en la fuente de UNA porción con
// su propia categoría y subtotal -- una parte de un desglose agregado, o
// un ítem real de la Fase 4. Antes esta lógica vivía pegada dentro del
// bucle del desglose de calcularRetencionSugerida(); se extrajo aparte
// para que el cálculo línea por línea (calcularRetencionSugeridaPorItems,
// más abajo) use EXACTAMENTE la misma tarifa/umbral/cuenta, en vez de una
// segunda copia que se puede desincronizar.
//
// Devuelve null si la categoría no tiene tarifa confirmada en la tabla, o
// si el subtotal no supera su umbral -- en ese caso no aplica, punto.
//
// Para vigilancia_aseo y servicios_temporales (baseEspecial: 'aiu') hay un
// tercer resultado posible: si el umbral SÍ se supera (probado contra el
// bruto) pero no se recibió un valor de AIU, esta categoría SÍ requiere
// retención pero no se puede calcular el monto sin ese dato -- se
// devuelve { requiereAiu: true, subtotalBruto, aiuMinimoPresuntivo,
// cuentaPUC, nombrePUC } en vez de silenciarlo como si no aplicara (eso
// entendería el contador como "no hay que retener nada", que sería
// justo el error que este ajuste vino a corregir).
//
// Si sí hay un monto calculado: { bajo, alto, mismaTarifa, cuentaPUC,
// nombrePUC, baseUsada, aiuUsado, aiuAjustadoAlPiso } en pesos.
// `aiuUsado`/`baseUsada` solo vienen en las categorías con baseEspecial
// -- en las demás, la base ES el subtotal (mismo comportamiento de
// siempre, no hace falta reportarla aparte).
function calcularRetencionCategoriaLinea(categoria, subtotal, nitProveedor, fechaFactura, tarifasAprendidas, aiu) {
  tarifasAprendidas = tarifasAprendidas || {};
  const categoriaKey = String(categoria || '').toLowerCase();
  const configBase = TARIFAS_RETENCION[categoriaKey];
  if (!configBase) return null; // "otro" -- tarifa no confirmada, no adivinamos

  const subtotalNum = Number(subtotal) || 0;
  // El umbral SIEMPRE se prueba contra el valor bruto (subtotal de la
  // línea/categoría), incluso en las categorías de base especial -- eso
  // no cambia, es solo la TARIFA la que se aplica distinto para esas dos.
  if (subtotalNum < umbralPesos(configBase, fechaFactura)) return null; // bajo el umbral, no aplica

  const aprendida = tarifasAprendidas[`${nitProveedor || ''}|${categoriaKey}`];
  const config = aprendida !== undefined ? { tarifaBaja: aprendida, tarifaAlta: aprendida } : configBase;

  if (configBase.baseEspecial === 'aiu') {
    const aiuNum = (aiu === undefined || aiu === null || aiu === '') ? null : Number(aiu);
    const pisoAiu = Math.round(subtotalNum * AIU_PISO_PORCENTAJE);
    if (aiuNum === null || isNaN(aiuNum)) {
      return {
        requiereAiu: true,
        subtotalBruto: subtotalNum,
        aiuMinimoPresuntivo: pisoAiu,
        cuentaPUC: configBase.cuentaPUC,
        nombrePUC: configBase.nombrePUC,
      };
    }
    const baseTarifa = Math.max(aiuNum, pisoAiu);
    return {
      bajo: Math.round(baseTarifa * config.tarifaBaja),
      alto: Math.round(baseTarifa * config.tarifaAlta),
      mismaTarifa: config.tarifaBaja === config.tarifaAlta,
      cuentaPUC: configBase.cuentaPUC,
      nombrePUC: configBase.nombrePUC,
      baseUsada: baseTarifa,
      aiuUsado: aiuNum,
      aiuAjustadoAlPiso: baseTarifa > aiuNum,
    };
  }

  return {
    bajo: Math.round(subtotalNum * config.tarifaBaja),
    alto: Math.round(subtotalNum * config.tarifaAlta),
    mismaTarifa: config.tarifaBaja === config.tarifaAlta,
    cuentaPUC: configBase.cuentaPUC,
    nombrePUC: configBase.nombrePUC,
  };
}

function calcularRetencionSugerida(inv, cliente, tarifasAprendidas, perfilTercero){
  tarifasAprendidas = tarifasAprendidas || {};
  if (!cliente || !cliente.agente_retenedor) return null; // nunca le corresponde retener

  const perfil = perfilFiscalEfectivo(inv, perfilTercero);
  if (perfil.regimenSimple) return null; // Régimen Simple -- Rete Fuente no aplica
  if (perfil.autorretenedor) return null; // el proveedor se autorretiene -- el comprador no debe practicar retención ordinaria

  let desglose = null;
  try {
    const raw = inv.desglose_categorias;
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
      desglose = parsed;
    }
  } catch (e) { desglose = null; }

  // Desglose paralelo de AIU por categoría (solo relevante para
  // vigilancia_aseo/servicios_temporales) -- mismo formato que
  // `desglose`: { categoria: montoAiu }. Puede venir vacío/ausente si la
  // factura no desglosó AIU en ninguna de sus líneas.
  let desgloseAiu = {};
  try {
    const rawAiu = inv.desglose_aiu;
    const parsedAiu = typeof rawAiu === 'string' ? JSON.parse(rawAiu || '{}') : (rawAiu || {});
    if (parsedAiu && typeof parsedAiu === 'object' && !Array.isArray(parsedAiu)) desgloseAiu = parsedAiu;
  } catch (e) { desgloseAiu = {}; }

  if (desglose) {
    let bajoTotal = 0, altoTotal = 0, huboAlguno = false, mismaTarifaEnTodas = true;
    let faltaAiuEnAlguna = false;
    const categoriasFaltantesAiu = [];
    const cuentasInvolucradas = new Map(); // cuentaPUC -> nombrePUC, sin duplicados
    for (const [categoriaParte, montoParte] of Object.entries(desglose)) {
      const r = calcularRetencionCategoriaLinea(categoriaParte, montoParte, inv.nit_cc || '', inv.fecha_factura, tarifasAprendidas, desgloseAiu[categoriaParte]);
      if (!r) continue; // esta parte no aplica (categoría sin tarifa, o bajo su umbral), se omite
      if (r.requiereAiu) {
        faltaAiuEnAlguna = true;
        categoriasFaltantesAiu.push({ categoria: categoriaParte, subtotalBruto: r.subtotalBruto, aiuMinimoPresuntivo: r.aiuMinimoPresuntivo });
        cuentasInvolucradas.set(r.cuentaPUC, r.nombrePUC);
        continue;
      }
      bajoTotal += r.bajo;
      altoTotal += r.alto;
      huboAlguno = true;
      if (!r.mismaTarifa) mismaTarifaEnTodas = false;
      cuentasInvolucradas.set(r.cuentaPUC, r.nombrePUC);
    }
    if (!huboAlguno && !faltaAiuEnAlguna) return null; // ninguna de las partes superó su umbral
    return {
      bajo: bajoTotal, alto: altoTotal, mismaTarifa: mismaTarifaEnTodas,
      cuentasPUC: [...cuentasInvolucradas.entries()].map(([cuenta, nombre]) => ({ cuenta, nombre })),
      // Si esto es true, `bajo`/`alto` son un total PARCIAL -- falta el
      // AIU de las categorías en `categoriasFaltantesAiu` para completar
      // el cálculo. Nunca se debe mostrar bajo/alto como el total final
      // sin revisar este flag primero.
      requiereAiu: faltaAiuEnAlguna,
      categoriasFaltantesAiu,
    };
  }

  // Sin desglose -- factura de una sola categoría, comportamiento normal.
  const r = calcularRetencionCategoriaLinea(inv.categoria_concepto, inv.valor_sin_iva, inv.nit_cc || '', inv.fecha_factura, tarifasAprendidas, inv.valor_aiu);
  if (!r) return null;
  if (r.requiereAiu) {
    return {
      bajo: 0, alto: 0, mismaTarifa: true,
      cuentasPUC: [{ cuenta: r.cuentaPUC, nombre: r.nombrePUC }],
      requiereAiu: true,
      categoriasFaltantesAiu: [{ categoria: inv.categoria_concepto, subtotalBruto: r.subtotalBruto, aiuMinimoPresuntivo: r.aiuMinimoPresuntivo }],
    };
  }
  return {
    bajo: r.bajo, alto: r.alto, mismaTarifa: r.mismaTarifa,
    cuentasPUC: [{ cuenta: r.cuentaPUC, nombre: r.nombrePUC }],
    requiereAiu: false, categoriasFaltantesAiu: [],
  };
}

// ---------- Retención sugerida LÍNEA POR LÍNEA (Fase 4) ----------
//
// A diferencia de `desglose_categorias` (un resumen agregado: "compras:
// 442000, servicios: 140000"), aquí `items` es el arreglo REAL de líneas
// de la factura (factura_items) -- cada una con su propia descripción y
// categoría. Se usa la misma pieza compartida (calcularRetencionCategoriaLinea)
// que el cálculo agregado, así que el total nunca puede quedar
// desincronizado entre ambas vistas.
//
// Devuelve null si el cliente no es agente retenedor, si no hay ítems, o
// si el proveedor está exento por su perfil fiscal (Régimen Simple /
// Autorretenedor) -- en ese último caso NO se calcula nada por línea
// (todas quedan en null), porque la exención aplica a la factura completa,
// no a una parte de ella.
//
// Si aplica, devuelve:
//   { porItem: [ {bajo,alto,mismaTarifa,cuentaPUC,nombrePUC} | {requiereAiu:true,...} | null, ... ],
//     bajo, alto, mismaTarifa, cuentasPUC, requiereAiu, itemsFaltantesAiu }
// `porItem` tiene el mismo largo y orden que `items` -- porItem[i] es el
// resultado (o null) para items[i], para poder mostrar el estimado al
// lado de cada línea en la interfaz. Un ítem de vigilancia_aseo o
// servicios_temporales sin `item.aiu` cae en `{requiereAiu:true,...}` en
// vez de en un monto -- `bajo`/`alto` del total son igual que en
// calcularRetencionSugerida: un total PARCIAL cuando `requiereAiu` es
// true, nunca el total final sin revisar ese flag primero.
function calcularRetencionSugeridaPorItems(items, inv, cliente, tarifasAprendidas, perfilTercero) {
  if (!cliente || !cliente.agente_retenedor) return null;
  if (!Array.isArray(items) || items.length === 0) return null;

  const perfil = perfilFiscalEfectivo(inv, perfilTercero);
  if (perfil.regimenSimple || perfil.autorretenedor) {
    return { porItem: items.map(() => null), bajo: 0, alto: 0, mismaTarifa: true, cuentasPUC: [], requiereAiu: false, itemsFaltantesAiu: [] };
  }

  let bajoTotal = 0, altoTotal = 0, mismaTarifaEnTodas = true;
  const cuentasInvolucradas = new Map();
  const itemsFaltantesAiu = [];
  const porItem = items.map((item, idx) => {
    const r = calcularRetencionCategoriaLinea(item.categoria_concepto, item.subtotal, inv.nit_cc || '', inv.fecha_factura, tarifasAprendidas, item.aiu);
    if (!r) return null;
    if (r.requiereAiu) {
      itemsFaltantesAiu.push({ idx, descripcion: item.descripcion || '', subtotalBruto: r.subtotalBruto, aiuMinimoPresuntivo: r.aiuMinimoPresuntivo });
      cuentasInvolucradas.set(r.cuentaPUC, r.nombrePUC);
      return r;
    }
    bajoTotal += r.bajo;
    altoTotal += r.alto;
    if (!r.mismaTarifa) mismaTarifaEnTodas = false;
    cuentasInvolucradas.set(r.cuentaPUC, r.nombrePUC);
    return r;
  });

  return {
    porItem, bajo: bajoTotal, alto: altoTotal, mismaTarifa: mismaTarifaEnTodas,
    cuentasPUC: [...cuentasInvolucradas.entries()].map(([cuenta, nombre]) => ({ cuenta, nombre })),
    requiereAiu: itemsFaltantesAiu.length > 0, itemsFaltantesAiu,
  };
}

// ---------- Normalización de ítems leídos por la IA (Fase 4) ----------
//
// La IA devuelve `items` como un arreglo crudo (a veces como texto JSON
// en vez de un arreglo real) -- esta función lo deja siempre en la misma
// forma interna que usa la interfaz de edición línea por línea, tanto en
// Escanear como en Carga masiva, con un default sensato de subcuenta PUC
// por categoría (misma tabla SUBCUENTAS_GASTO de arriba). Es la ÚNICA
// función que arma esta forma -- así ambas pantallas leen y editan
// ítems con exactamente la misma estructura.
//
// Si el documento no trae una tabla de ítems detallada (ej. una cuenta
// de cobro con un solo concepto global), arma UN ítem único con el total
// de la factura, usando lo mismo que ya se extrajo a nivel de factura.
//
// `categoriasValidas` es opcional -- un arreglo de claves válidas (ej.
// las mismas del <select> de categoría de esa pantalla). Si se pasa y la
// categoría que trajo la IA no está en la lista, el ítem cae a 'otro' en
// vez de quedar con un valor que ningún <select> podría mostrar.
function normalizarItemsDesdeIA(data, categoriasValidas) {
  let raw = data.items;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw || '[]'); } catch (e) { raw = []; }
  }
  const subcuentaPorDefecto = (categoria) => {
    const opciones = SUBCUENTAS_GASTO[categoria] || SUBCUENTAS_GASTO['otro'];
    return opciones ? opciones[0][0] : '';
  };
  const validarCategoria = (categoria) => {
    const cat = categoria || 'otro';
    if (!categoriasValidas) return cat;
    return categoriasValidas.includes(cat) ? cat : 'otro';
  };

  if (!Array.isArray(raw) || raw.length === 0) {
    const categoria = validarCategoria((data.categoria_concepto || 'otro').toLowerCase());
    return [{
      descripcion: data.concepto || '',
      cantidad: '', valor_unitario: '',
      subtotal: String(data.valor_sin_iva ?? '0'),
      categoria_concepto: categoria,
      subcuenta_gasto: subcuentaPorDefecto(categoria),
      iva_mayor_valor: false,
      // AIU (Administración+Imprevistos+Utilidad) -- solo tiene sentido
      // para vigilancia_aseo/servicios_temporales (ver esCategoriaBaseAiu
      // en la tabla de arriba); en cualquier otra categoría este campo
      // simplemente no se usa. Vacío = "no se sabe todavía", nunca 0 a
      // propósito (0 sí sería un valor real, aunque poco común).
      aiu: data.valor_aiu !== undefined && data.valor_aiu !== null && data.valor_aiu !== '' ? String(data.valor_aiu) : '',
    }];
  }
  return raw.map((it) => {
    const categoria = validarCategoria(String(it.categoria_concepto || 'otro').toLowerCase());
    return {
      descripcion: it.descripcion || '',
      cantidad: it.cantidad !== undefined && it.cantidad !== null ? String(it.cantidad) : '',
      valor_unitario: it.valor_unitario !== undefined && it.valor_unitario !== null ? String(it.valor_unitario) : '',
      subtotal: it.subtotal !== undefined && it.subtotal !== null ? String(it.subtotal) : '0',
      categoria_concepto: categoria,
      subcuenta_gasto: subcuentaPorDefecto(categoria),
      iva_mayor_valor: false,
      aiu: it.aiu !== undefined && it.aiu !== null && it.aiu !== '' ? String(it.aiu) : '',
    };
  });
}

// Ítems ya editados -> listos para mandar en el POST /api/invoices, con
// el IVA de cada línea prorrateado a partir del IVA total de la factura
// según la participación de cada ítem en el subtotal. Mismo cálculo en
// Escanear y en Carga masiva -- de ahí que viva aquí y no en cada página.
function itemsParaGuardar(items, ivaTotalFactura) {
  const totalSubtotalItems = (items || []).reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
  const ivaHeader = Number(ivaTotalFactura) || 0;
  return (items || []).map((it) => {
    const subtotal = Number(it.subtotal) || 0;
    const ivaProrrateado = totalSubtotalItems > 0 ? Math.round(ivaHeader * subtotal / totalSubtotalItems) : 0;
    return { ...it, valor_iva: String(ivaProrrateado) };
  });
}

// Agrupa un arreglo de ítems (Fase 4) en el mismo formato de
// `desglose_categorias` que ya usa el resto de la app -- { categoria:
// sumaDeSubtotales }. Así, apenas el contador edita los ítems línea por
// línea, el desglose agregado (y por lo tanto calcularRetencionSugerida,
// el Excel de Facturas, etc.) queda SIEMPRE derivado de los ítems reales,
// nunca de una copia separada que se pueda desactualizar.
function desgloseDesdeItems(items) {
  const desglose = {};
  (items || []).forEach((item) => {
    const categoria = String(item.categoria_concepto || '').toLowerCase();
    const subtotal = Number(item.subtotal) || 0;
    if (!categoria || subtotal === 0) return;
    desglose[categoria] = (desglose[categoria] || 0) + subtotal;
  });
  return desglose;
}

// Mismo agrupamiento que desgloseDesdeItems(), pero sumando `item.aiu` en
// vez de `item.subtotal` -- alimenta `inv.desglose_aiu` que usa
// calcularRetencionSugerida() para las categorías de base especial
// (vigilancia_aseo/servicios_temporales). Solo suma categorías que SÍ
// declararon un AIU en al menos un ítem -- una categoría ausente aquí no
// significa AIU=0, significa "no se sabe", y calcularRetencionCategoriaLinea
// ya distingue eso (devuelve requiereAiu:true en vez de asumir $0).
function desgloseAiuDesdeItems(items) {
  const desglose = {};
  (items || []).forEach((item) => {
    const categoria = String(item.categoria_concepto || '').toLowerCase();
    if (!categoria || item.aiu === undefined || item.aiu === null || item.aiu === '') return;
    const aiu = Number(item.aiu) || 0;
    desglose[categoria] = (desglose[categoria] || 0) + aiu;
  });
  return desglose;
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
// hay IVA, el subtotal no supera el umbral de su categoría, o el
// proveedor está exento por su propia calidad tributaria -- ver abajo).
//
// OJO -- a propósito NO se exime aquí por Régimen Simple ni por
// Autorretenedor: esos dos solo eximen de Rete Fuente (renta) y de
// ICA -- un proveedor de Régimen Simple responsable de IVA SÍ puede
// tener ReteIVA practicado sobre sus ventas (verificado: la exención
// del RST aplica a renta e ICA, no a IVA). Mezclar esa regla aquí
// sería inventar una exención que la norma no da -- por eso
// `calcularRetencionSugerida()` sí revisa el perfil fiscal y esta
// función no.
//
// Exención que SÍ aplica aquí -- "entre agentes de retención de IVA no
// se practica retención" (doctrina DIAN, resumida en Gerencie.com y
// Actualícese sobre Art. 437-2 E.T.): si el proveedor mismo ya es un
// agente de retención de IVA designado, o es Gran Contribuyente, tu
// cliente no debe retenerle -- sin importar si tu cliente también es
// Gran Contribuyente o no, en NINGUNA combinación de las que reporta la
// norma le corresponde retención cuando el VENDEDOR tiene esa calidad.
// (El único caso donde SÍ se retiene es el normal: comprador agente
// retenedor comprándole a un proveedor de régimen común corriente, que
// es exactamente lo que ya cubre el resto de esta función.)
// `perfilTercero` es lo mismo que recibe `calcularRetencionSugerida()`
// -- opcional, pasa null/undefined si no se cargó (se comporta como
// antes: no exime por esto, solo por lo que ya cubría).
function calcularReteIvaSugerido(inv, cliente, perfilTercero){
  if (!cliente || !cliente.agente_retenedor) return null;

  if (perfilTercero && (perfilTercero.agente_retencion_iva || perfilTercero.gran_contribuyente)) return null;

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

// ---------- Retención de ICA (ReteICA) por municipio ----------
//
// A diferencia de Rete Fuente y Rete IVA (que son nacionales, con una
// tabla y una tarifa que valen para todo el país), el ICA es municipal
// -- cada municipio fija su propia tarifa (y hay más de 1.100
// municipios en Colombia), y encima la tarifa cambia según la
// actividad económica (industrial/comercial/servicios, o hasta más
// fino por CIIU). No existe una tabla nacional confiable que esta app
// pueda traer ya puesta sin arriesgarse a inventar un número -- por
// eso el contador arma SU PROPIA tabla de tarifas de ICA (municipio +
// actividad + tarifa + base mínima + cuenta PUC auxiliar), una vez por
// cliente/municipio que de verdad maneje, y la reusa cada vez.
//
// `tarifaIca` es UNA fila de esa tabla que el contador ya eligió para
// esta factura: { municipio, actividad, tarifa_por_mil, base_uvt,
// cuenta_puc }. Si no ha elegido ninguna (porque no la ha configurado
// todavía), esta función no calcula nada -- nunca asume un municipio
// ni una tarifa por su cuenta.
function calcularReteIcaSugerido(inv, tarifaIca){
  if (!tarifaIca) return null; // el contador no ha elegido/configurado una tarifa de ICA para este municipio todavía

  const tarifaPorMil = Number(tarifaIca.tarifa_por_mil);
  if (!tarifaPorMil || tarifaPorMil <= 0) return null;

  const subtotal = Number(inv.valor_sin_iva) || 0;
  const baseUvt = Number(tarifaIca.base_uvt) || 0;
  const umbral = Math.round(baseUvt * valorUvt(anioDeFechaFactura(inv.fecha_factura)));
  if (subtotal < umbral) return null; // bajo la base mínima que el contador configuró para este municipio

  return {
    monto: Math.round(subtotal * (tarifaPorMil / 1000)),
    cuentaPUC: tarifaIca.cuenta_puc || CUENTAS_PUC_FIJAS.rete_ica.cuentaPUC,
    nombrePUC: tarifaIca.cuenta_puc ? `ICA retenido -- ${tarifaIca.municipio}` : CUENTAS_PUC_FIJAS.rete_ica.nombrePUC,
  };
}