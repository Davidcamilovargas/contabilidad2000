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
// aplicar las bases originales del decreto.
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
const TARIFAS_RETENCION = {
  compras:                 { umbral: 524000, tarifaBaja: 0.025, tarifaAlta: 0.035, cuentaPUC: '236540', nombrePUC: 'Compras' },
  compras_tarjeta:         { umbral: 0,      tarifaBaja: 0.015, tarifaAlta: 0.015, cuentaPUC: '236540', nombrePUC: 'Compras' },
  servicios:                { umbral: 105000, tarifaBaja: 0.04,  tarifaAlta: 0.06,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  honorarios_juridica:      { umbral: 0,      tarifaBaja: 0.11,  tarifaAlta: 0.11,  cuentaPUC: '236515', nombrePUC: 'Honorarios' },
  honorarios_natural:       { umbral: 0,      tarifaBaja: 0.10,  tarifaAlta: 0.11,  cuentaPUC: '236515', nombrePUC: 'Honorarios' },
  arrendamiento_muebles:    { umbral: 0,      tarifaBaja: 0.04,  tarifaAlta: 0.04,  cuentaPUC: '236530', nombrePUC: 'Arrendamientos' },
  arrendamiento_inmuebles:  { umbral: 524000, tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236530', nombrePUC: 'Arrendamientos' },
  transporte_carga:         { umbral: 105000, tarifaBaja: 0.01,  tarifaAlta: 0.01,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  transporte_pasajeros:     { umbral: 524000, tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
  licenciamiento_software:  { umbral: 0,      tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
  vigilancia_aseo:          { umbral: 105000, tarifaBaja: 0.02,  tarifaAlta: 0.02,  cuentaPUC: '236525', nombrePUC: 'Servicios' },
  hoteles_restaurantes:     { umbral: 105000, tarifaBaja: 0.035, tarifaAlta: 0.035, cuentaPUC: '236525', nombrePUC: 'Servicios' },
};

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


// Calcula la retención en la fuente SUGERIDA (estimada -- no oficial, no
// leída del documento) para una factura, cruzando la categoría del
// concepto, si el cliente es agente retenedor, y si el proveedor es
// Régimen Simple. Si la factura mezcla categorías (ej. productos + mano
// de obra en una misma factura), usa el desglose guardado y calcula
// cada parte por separado contra su propio umbral y tarifa, en vez de
// tratar todo el subtotal como una sola categoría.
//
// `cliente` necesita al menos `{ agente_retenedor }`.
// `tarifasAprendidas` es un objeto { "NIT|categoria": tarifaExacta } --
// si ya se confirmó la tarifa real de un proveedor antes, se usa esa en
// vez de un rango. Pasa {} (o nada) si no la tienes disponible.
//
// Devuelve null cuando no se puede/debe calcular nada, o
// { bajo, alto, mismaTarifa } en pesos colombianos (COP).
function calcularRetencionSugerida(inv, cliente, tarifasAprendidas){
  tarifasAprendidas = tarifasAprendidas || {};
  if (!cliente || !cliente.agente_retenedor) return null; // nunca le corresponde retener
  if (inv.regimen_simple === true || inv.regimen_simple === 'true') return null; // Régimen Simple -- Rete Fuente no aplica

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
      if (!configBase || subtotalParte < configBase.umbral) continue; // esta parte no aplica, se omite
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
  if (subtotal < configBase.umbral) return null; // bajo el umbral, no aplica

  const config = tarifaParaProveedor(categoria, inv.nit_cc || '', configBase);
  const bajo = Math.round(subtotal * config.tarifaBaja);
  const alto = Math.round(subtotal * config.tarifaAlta);
  return {
    bajo, alto, mismaTarifa: config.tarifaBaja === config.tarifaAlta,
    cuentasPUC: [{ cuenta: configBase.cuentaPUC, nombre: configBase.nombrePUC }],
  };
}