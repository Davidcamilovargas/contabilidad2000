// ---------- Cálculos compartidos para Ingresos, Egresos y Balance ----------
// Mismo principio que retenciones.js: la lógica de agrupar y sumar
// facturas vive en un solo lugar, así las 3 páginas de estadísticas
// siempre calculan igual -- si un día cambia cómo se agrupa algo,
// solo hay que tocar este archivo.

// Devuelve las etiquetas "YYYY-MM" de los últimos `n` meses, terminando
// en el mes actual, en orden cronológico (más viejo primero).
function ultimosMeses(n){
  const out = [];
  const hoy = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const MESES_CORTOS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function etiquetaMes(yyyyMm){
  const [y, m] = yyyyMm.split('-');
  return MESES_CORTOS[Number(m) - 1] + ' ' + y.slice(2);
}

// Extrae "YYYY-MM" de una factura (el campo fecha_factura viene como
// texto "DD/MM/AAAA"). Devuelve null si la fecha no es válida.
function mesDeFactura(inv){
  const [d, m, y] = (inv.fecha_factura || '').split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}`;
}

// Filtra solo las facturas de un tipo de movimiento ('ingreso' o 'egreso').
function filtrarPorTipo(invoices, tipo){
  return invoices.filter(inv => (inv.tipo_movimiento || 'egreso') === tipo);
}

// Suma el valor CON IVA de un arreglo de facturas.
function sumaConIva(invoices){
  return invoices.reduce((acc, inv) => acc + (Number(inv.valor_con_iva) || 0), 0);
}

// Agrupa el total (con IVA) por mes, para los últimos `n` meses.
// Devuelve un arreglo alineado con ultimosMeses(n): [{ mes, total }].
function totalesPorMes(invoices, n){
  const meses = ultimosMeses(n);
  const sumas = Object.fromEntries(meses.map(m => [m, 0]));
  invoices.forEach(inv => {
    const mes = mesDeFactura(inv);
    if (mes && sumas[mes] !== undefined) sumas[mes] += Number(inv.valor_con_iva) || 0;
  });
  return meses.map(mes => ({ mes, total: sumas[mes] }));
}

// Agrupa el total (con IVA) por categoría de concepto.
// Devuelve un arreglo ordenado de mayor a menor: [{ categoria, total }].
function totalesPorCategoria(invoices){
  const sumas = {};
  invoices.forEach(inv => {
    const cat = inv.categoria_concepto || 'otro';
    sumas[cat] = (sumas[cat] || 0) + (Number(inv.valor_con_iva) || 0);
  });
  return Object.entries(sumas)
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);
}

// Agrupa el total (con IVA) por la CONTRAPARTE de la factura -- para
// egresos es el proveedor (quien emitió la factura, nit_cc); para
// ingresos es el cliente que compró (adquiriente_nit). Devuelve un
// arreglo ordenado de mayor a menor: [{ nit, nombre, total }].
function totalesPorContraparte(invoices, tipo){
  const sumas = {}; // nit -> { nombre, total }
  invoices.forEach(inv => {
    const nit = tipo === 'ingreso' ? (inv.adquiriente_nit || '—') : (inv.nit_cc || '—');
    const nombre = tipo === 'ingreso' ? (inv.adquiriente_nombre || 'Sin identificar') : (inv.nombre_razon_social || 'Sin identificar');
    if (!sumas[nit]) sumas[nit] = { nombre, total: 0 };
    sumas[nit].total += Number(inv.valor_con_iva) || 0;
  });
  return Object.entries(sumas)
    .map(([nit, v]) => ({ nit, nombre: v.nombre, total: v.total }))
    .sort((a, b) => b.total - a.total);
}

// Nombres legibles para las categorías -- para no mostrar el código
// interno ("honorarios_juridica") en las gráficas.
const CATEGORIA_LABELS_COMPARTIDO = {
  compras: 'Compras', compras_tarjeta: 'Compras (tarjeta)', servicios: 'Servicios',
  honorarios_juridica: 'Honorarios (jurídica)', honorarios_natural: 'Honorarios (natural)',
  arrendamiento_muebles: 'Arriendo muebles', arrendamiento_inmuebles: 'Arriendo inmuebles',
  transporte_carga: 'Transporte carga', transporte_pasajeros: 'Transporte pasajeros',
  licenciamiento_software: 'Software', vigilancia_aseo: 'Vigilancia/aseo',
  hoteles_restaurantes: 'Hoteles/restaurantes', otro: 'Otro',
};