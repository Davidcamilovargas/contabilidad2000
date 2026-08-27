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
const TARIFAS_RETENCION = {
  compras:                 { umbral: 524000, tarifaBaja: 0.025, tarifaAlta: 0.035 },
  compras_tarjeta:         { umbral: 0,      tarifaBaja: 0.015, tarifaAlta: 0.015 },
  servicios:                { umbral: 105000, tarifaBaja: 0.04,  tarifaAlta: 0.06  },
  honorarios_juridica:      { umbral: 0,      tarifaBaja: 0.11,  tarifaAlta: 0.11  },
  honorarios_natural:       { umbral: 0,      tarifaBaja: 0.10,  tarifaAlta: 0.11  },
  arrendamiento_muebles:    { umbral: 0,      tarifaBaja: 0.04,  tarifaAlta: 0.04  },
  arrendamiento_inmuebles:  { umbral: 524000, tarifaBaja: 0.035, tarifaAlta: 0.035 },
  transporte_carga:         { umbral: 105000, tarifaBaja: 0.01,  tarifaAlta: 0.01  },
  transporte_pasajeros:     { umbral: 524000, tarifaBaja: 0.035, tarifaAlta: 0.035 },
  licenciamiento_software:  { umbral: 0,      tarifaBaja: 0.035, tarifaAlta: 0.035 },
  vigilancia_aseo:          { umbral: 105000, tarifaBaja: 0.02,  tarifaAlta: 0.02  },
  hoteles_restaurantes:     { umbral: 105000, tarifaBaja: 0.035, tarifaAlta: 0.035 },
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
    for (const [categoriaParte, montoParte] of Object.entries(desglose)) {
      const configBase = TARIFAS_RETENCION[String(categoriaParte).toLowerCase()];
      const subtotalParte = Number(montoParte) || 0;
      if (!configBase || subtotalParte < configBase.umbral) continue; // esta parte no aplica, se omite
      const config = tarifaParaProveedor(categoriaParte, inv.nit_cc || '', configBase);
      bajoTotal += Math.round(subtotalParte * config.tarifaBaja);
      altoTotal += Math.round(subtotalParte * config.tarifaAlta);
      huboAlguno = true;
      if (config.tarifaBaja !== config.tarifaAlta) mismaTarifaEnTodas = false;
    }
    if (!huboAlguno) return null; // ninguna de las partes superó su umbral
    return { bajo: bajoTotal, alto: altoTotal, mismaTarifa: mismaTarifaEnTodas };
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
  return { bajo, alto, mismaTarifa: config.tarifaBaja === config.tarifaAlta };
}