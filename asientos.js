// ---------------------------------------------------------------------
// Motor contable mínimo: plan de cuentas (PUC) y generación automática
// del asiento de partida doble a partir de una factura ya clasificada.
//
// Alcance de esta primera versión (lee esto antes de tocar el archivo):
//
// - Solo genera asiento para facturas de EGRESO (compra/gasto/honorario
//   que el contador le paga a un tercero). Las facturas de INGRESO
//   (ventas) todavía no tienen un asiento automático -- la app hoy no
//   tiene un catálogo de cuentas de ingreso ni de retenciones "sufridas"
//   (anticipos de impuestos) tan maduro como el de gastos/retenciones
//   practicadas, y prefiero no adivinar esa clasificación. Queda para
//   una siguiente iteración.
// - El asiento que se genera es SIEMPRE de causación (la factura se
//   causa, no se paga) -- no toca cuentas de bancos/caja. Vincular esto
//   con un pago real de public/lotes.js / movimientos_banco es trabajo
//   aparte (conciliación bancaria ya existe, pero conectarla con el
//   asiento contable es una tarea futura).
// - Nunca se genera un asiento si falta un dato necesario para hacerlo
//   bien (ej. el contador todavía no eligió la subcuenta del gasto) --
//   mismo principio que ya usa toda la app: el sistema no adivina algo
//   ambiguo, prefiere no proponer nada a proponer algo mal.
// - El asiento que se genera queda SIEMPRE en estado "propuesto" -- lo
//   crea el sistema pero el contador tiene que aprobarlo para que cuente
//   como confirmado (ver estado en asientos_contables, server.js).
//
// Igual que public/retenciones.js, este archivo es isomórfico: hoy solo
// lo usa server.js con require(), pero está escrito así por si en el
// futuro hace falta mostrar una vista previa del asiento en el navegador
// antes de guardar la factura.
// ---------------------------------------------------------------------

const {
  TARIFAS_RETENCION,
  CUENTAS_PUC_FIJAS,
  SUBCUENTAS_GASTO,
} = require('./public/retenciones');

// ---------- Plan de cuentas semilla ----------
//
// Cada contador tiene su PROPIA copia de este catálogo (tabla
// plan_cuentas, con contador_id) -- se siembra la primera vez que hace
// falta (ver asegurarPlanCuentasContador en server.js) y de ahí en
// adelante es SUYA: si la edita o agrega cuentas, esos cambios no se
// pierden ni se sobreescriben. Esto es más simple que un catálogo
// global compartido y no depende de que exista la jerarquía de
// "empresas" (esa es la tarea de Multiempresa, más grande y aparte).
//
// Los códigos de gastos (clase 5) y de retención (grupo 2365/2367/2368)
// se derivan de public/retenciones.js -- MISMA fuente que ya usan
// Escanear/Carga masiva/Facturas para mostrarle esas cuentas al
// contador, para que el plan de cuentas nunca quede desincronizado de
// lo que el contador ya está viendo y eligiendo en esas pantallas.
//
// Las cuentas de activo/pasivo/IVA de abajo (Bancos, Clientes,
// Proveedores, Inventarios, IVA) son las mínimas indispensables para
// poder registrar la partida doble de una factura de compra -- se
// tomaron del Plan Único de Cuentas (Decreto 2650 de 1993), a nivel de
// cuenta (4 dígitos) donde no hace falta más detalle todavía. Si tu
// plan de cuentas real usa subcuentas más específicas (ej. IVA
// descontable y generado en cuentas separadas en vez de una sola 2408),
// edítalas después de que se siembren -- esto es un punto de partida
// razonable, no una migración legal obligatoria.
function construirPlanCuentasSemilla() {
  const cuentas = new Map(); // codigo -> {codigo, nombre, naturaleza, clase}

  const agregar = (codigo, nombre, naturaleza, clase) => {
    if (!codigo) return;
    if (!cuentas.has(codigo)) cuentas.set(codigo, { codigo, nombre, naturaleza, clase });
  };

  // Activo
  agregar('1110', 'Bancos', 'debito', 'activo');
  agregar('1305', 'Clientes', 'debito', 'activo');
  agregar('1435', 'Inventarios -- mercancías no fabricadas por la empresa', 'debito', 'activo');

  // Pasivo
  agregar('2205', 'Proveedores nacionales', 'credito', 'pasivo');
  agregar('2408', 'Impuesto sobre las ventas por pagar (IVA)', 'credito', 'pasivo');
  // Grupo genérico de retención en la fuente -- se usa solo cuando una
  // factura mezcla más de una categoría con subcuenta de retención
  // distinta y no se puede repartir el valor total entre ellas sin
  // adivinar (ver generarAsientoEgreso más abajo).
  agregar('2365', 'Retención en la fuente por pagar', 'credito', 'pasivo');
  agregar(CUENTAS_PUC_FIJAS.rete_iva.cuentaPUC, CUENTAS_PUC_FIJAS.rete_iva.nombrePUC, 'credito', 'pasivo');
  agregar(CUENTAS_PUC_FIJAS.rete_ica.cuentaPUC, CUENTAS_PUC_FIJAS.rete_ica.nombrePUC, 'credito', 'pasivo');
  // Subcuentas específicas de retención en la fuente -- una por cada
  // cuentaPUC distinta que aparezca en TARIFAS_RETENCION (varias
  // categorías comparten la misma cuenta, ej. todos los "servicios").
  Object.values(TARIFAS_RETENCION).forEach((config) => {
    agregar(config.cuentaPUC, `Retención en la fuente -- ${config.nombrePUC}`, 'credito', 'pasivo');
  });

  // Gasto (clase 5) -- una cuenta por cada subcuenta que el contador
  // puede elegir en el selector "Subcuenta (PUC)" de Escanear/Carga
  // masiva. El pseudo-código "inventario" no es una cuenta de gasto real
  // (es mercancía para reventa, un activo) -- se mapea aparte, a 1435.
  Object.values(SUBCUENTAS_GASTO).forEach((opciones) => {
    opciones.forEach(([codigo, nombre]) => {
      if (codigo === 'inventario') return; // ya se agregó como 1435 (activo) arriba
      agregar(codigo, nombre, 'debito', 'gasto');
    });
  });

  return [...cuentas.values()];
}

const PLAN_CUENTAS_SEMILLA = construirPlanCuentasSemilla();

// Traduce el pseudo-código "inventario" (usado en el selector de
// Escanear/Carga masiva) a la cuenta real que le corresponde.
function codigoCuentaGasto(subcuentaGasto) {
  if (subcuentaGasto === 'inventario') return '1435';
  return subcuentaGasto;
}

// ---------- Generación del asiento para una factura de EGRESO ----------
//
// `invoice`: la fila de la tabla invoices (o el objeto ya convertido por
// rowToInvoice en server.js -- funciona igual, se leen los mismos
// nombres de campo).
// `items`: las filas de factura_items de esa factura (arreglo, puede
// venir vacío si la factura no tiene desglose línea por línea).
//
// Devuelve { lineas, debe, haber } si se pudo generar, o
// { error: 'motivo' } si falta algo -- nunca lanza, y nunca devuelve un
// asiento que no cuadre (debe === haber siempre que no haya error).
function generarAsientoEgreso(invoice, items) {
  if (String(invoice.tipo_movimiento || '').toLowerCase() !== 'egreso') {
    return { error: 'no_es_egreso' };
  }

  const valorSinIva = Number(invoice.valor_sin_iva) || 0;
  const valorIva = Number(invoice.valor_iva) || 0;
  const valorConIva = Number(invoice.valor_con_iva) || 0;
  const reteFuente = Number(invoice.rete_fuente) || 0;
  const reteIva = Number(invoice.rete_iva) || 0;
  const reteIca = Number(invoice.rete_ica) || 0;

  if (valorConIva <= 0) return { error: 'sin_valor' };
  // Antes de proponer cualquier línea, se valida la misma regla de la
  // tarea "IA documental" del roadmap: subtotal + IVA debe cuadrar con
  // el total. Si no cuadra, la factura tiene un problema de datos que
  // hay que corregir ahí, no en el asiento -- no tiene sentido generar
  // una partida doble "cuadrada a la fuerza" sobre números que ya están
  // mal desde la factura.
  if (Math.abs(valorSinIva + valorIva - valorConIva) > 1) {
    return { error: 'valores_no_cuadran' };
  }

  const itemsConCategoria = Array.isArray(items) ? items.filter((it) => it.subcuenta_gasto) : [];

  // Débitos del gasto -- una línea por cada subcuenta distinta que
  // aparezca (agrupa los ítems que comparten subcuenta y suma su
  // subtotal). Si la factura no tiene ítems con subcuenta propia, cae
  // al caso de siempre: una sola categoría, con la subcuenta de la
  // cabecera de la factura.
  const gastosPorCuenta = new Map(); // codigo -> {monto, nombre}
  if (itemsConCategoria.length > 0) {
    for (const item of itemsConCategoria) {
      const codigo = codigoCuentaGasto(item.subcuenta_gasto);
      const monto = Number(item.subtotal) || 0;
      if (monto <= 0) continue;
      const cuenta = PLAN_CUENTAS_SEMILLA.find((c) => c.codigo === codigo);
      const existente = gastosPorCuenta.get(codigo) || { monto: 0, nombre: cuenta ? cuenta.nombre : codigo };
      existente.monto += monto;
      gastosPorCuenta.set(codigo, existente);
    }
  } else if (invoice.subcuenta_gasto) {
    const codigo = codigoCuentaGasto(invoice.subcuenta_gasto);
    const cuenta = PLAN_CUENTAS_SEMILLA.find((c) => c.codigo === codigo);
    gastosPorCuenta.set(codigo, { monto: valorSinIva, nombre: cuenta ? cuenta.nombre : codigo });
  }

  // Sin ninguna subcuenta de gasto elegida todavía, no hay de dónde
  // sacar el débito principal -- el contador tiene que elegirla primero
  // (en la ficha de la factura, como ya hace hoy).
  if (gastosPorCuenta.size === 0) return { error: 'sin_subcuenta_gasto' };

  const lineas = [];
  let orden = 0;
  for (const [codigo, { monto, nombre }] of gastosPorCuenta) {
    lineas.push({ orden: orden++, cuenta_codigo: codigo, cuenta_nombre: nombre, debito: round2(monto), credito: 0 });
  }

  if (valorIva > 0) {
    lineas.push({ orden: orden++, cuenta_codigo: '2408', cuenta_nombre: 'Impuesto sobre las ventas por pagar (IVA)', debito: round2(valorIva), credito: 0 });
  }

  // Retención en la fuente -- si TODAS las categorías involucradas
  // comparten la misma subcuenta de retención (el caso normal: una
  // factura de una sola categoría, o varias que igual caen en la misma
  // cuenta, ej. "servicios" y "transporte_carga" comparten 236525), se
  // usa esa subcuenta específica. Si hay más de una distinta, la
  // factura solo guarda el TOTAL de rete_fuente (no cuánto es de cada
  // categoría), así que no se puede repartir sin adivinar -- se usa la
  // cuenta genérica 2365 y se deja una nota para que el contador la
  // reclasifique a mano si hace falta.
  if (reteFuente > 0) {
    const categorias = itemsConCategoria.length > 0
      ? [...new Set(itemsConCategoria.map((it) => String(it.categoria_concepto || '').toLowerCase()))]
      : [String(invoice.categoria_concepto || '').toLowerCase()];
    const cuentasRetencion = new Set(categorias.map((cat) => (TARIFAS_RETENCION[cat] || {}).cuentaPUC).filter(Boolean));
    if (cuentasRetencion.size === 1) {
      const [codigo] = cuentasRetencion;
      const config = Object.values(TARIFAS_RETENCION).find((c) => c.cuentaPUC === codigo);
      lineas.push({ orden: orden++, cuenta_codigo: codigo, cuenta_nombre: `Retención en la fuente -- ${config.nombrePUC}`, debito: 0, credito: round2(reteFuente) });
    } else {
      lineas.push({
        orden: orden++,
        cuenta_codigo: '2365',
        cuenta_nombre: 'Retención en la fuente por pagar (revisar reparto entre categorías -- esta factura mezcla más de una)',
        debito: 0,
        credito: round2(reteFuente),
      });
    }
  }

  if (reteIva > 0) {
    lineas.push({ orden: orden++, cuenta_codigo: CUENTAS_PUC_FIJAS.rete_iva.cuentaPUC, cuenta_nombre: CUENTAS_PUC_FIJAS.rete_iva.nombrePUC, debito: 0, credito: round2(reteIva) });
  }
  if (reteIca > 0) {
    lineas.push({ orden: orden++, cuenta_codigo: CUENTAS_PUC_FIJAS.rete_ica.cuentaPUC, cuenta_nombre: CUENTAS_PUC_FIJAS.rete_ica.nombrePUC, debito: 0, credito: round2(reteIca) });
  }

  // Lo que de verdad se le debe al proveedor: el total de la factura
  // menos todas las retenciones que se le practicaron.
  const saldoProveedor = valorConIva - reteFuente - reteIva - reteIca;
  if (saldoProveedor > 0) {
    lineas.push({ orden: orden++, cuenta_codigo: '2205', cuenta_nombre: 'Proveedores nacionales', debito: 0, credito: round2(saldoProveedor) });
  } else if (saldoProveedor < 0) {
    // No debería pasar con datos válidos (las retenciones nunca superan
    // el total de la factura) -- si pasa, es una señal de que algo en
    // los valores de la factura está mal, mejor no proponer nada.
    return { error: 'retenciones_mayores_al_total' };
  }

  const debe = round2(lineas.reduce((s, l) => s + l.debito, 0));
  const haber = round2(lineas.reduce((s, l) => s + l.credito, 0));
  if (Math.abs(debe - haber) > 1) {
    // Red de seguridad -- con la lógica de arriba esto no debería pasar
    // nunca, pero un asiento que no cuadra jamás debería llegar a
    // guardarse, así que se revisa explícitamente antes de devolverlo.
    return { error: 'asiento_no_cuadra' };
  }

  return { lineas, debe, haber };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  PLAN_CUENTAS_SEMILLA,
  generarAsientoEgreso,
  codigoCuentaGasto,
};
