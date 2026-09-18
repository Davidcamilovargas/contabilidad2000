// ---------------------------------------------------------------------
// Definición ÚNICA de las "excepciones" (avisos) que Enlaza puede
// detectar sobre una factura YA GUARDADA -- Tarea 8 de la hoja de ruta
// ("excepciones unificadas").
//
// Antes de este archivo, cada pantalla tenía su PROPIA copia a mano de
// estos chequeos (duplicado por hash, sin NIT, letras vs. números,
// saldo vencido, anticipo detectado), con textos ligeramente distintos
// entre sí y sin ninguna forma de volver a verlos una vez la factura
// quedaba guardada -- el mismo riesgo de desincronización silenciosa que
// ya resolvió public/retenciones.js para las tarifas de retención. Ahora
// hay un solo lugar que define QUÉ cuenta como excepción y CÓMO se
// explica, y facturas.html/revision.html lo usan igual.
//
// Nota de alcance -- "duplicado por hash" NO vive aquí: ese chequeo es
// preventivo (impide guardar la factura repetida, ver buscarFacturaPorHash
// en server.js) y no aplica a una factura que ya está guardada, así que
// no tiene sentido como una excepción "detectada después". Las 5
// excepciones de este archivo son justo las que SÍ pueden convivir con
// una factura ya guardada y por eso necesitan quedar visibles después,
// no solo en el momento de digitarla.
//
// Se carga de las dos formas de siempre en esta app (ver el mismo patrón
// en public/retenciones.js): como <script> plano en el navegador
// (Escanear, Carga masiva, Facturas, Revisión -- queda como funciones
// globales) y, al final del archivo, como módulo de Node si algún día
// hace falta desde server.js o desde una prueba automatizada.
//
// listaExcepciones(inv) recibe una factura (fila de `invoices`, o el
// objeto que ya trae la IA con esos mismos nombres de campo) y devuelve
// un arreglo `[{ tipo, etiqueta, detalle }]` -- vacío si no tiene
// ninguna. `detalle` es texto plano listo para mostrarle al contador
// (hay que escaparlo con escapeHtml antes de insertarlo en el DOM, igual
// que cualquier otro texto de la factura).
'use strict';

// Copia idéntica a la que ya usan escanear.html/masivo.html para "sin
// NIT" -- quita el dígito de verificación (si viene pegado con guión) y
// se queda solo con los dígitos. Un NIT vacío después de esto es lo que
// cuenta como "sin NIT".
function soloDigitosParaExcepciones(nit) {
  let s = String(nit || '').trim();
  s = s.replace(/-\s*\d$/, '');
  return s.replace(/[^0-9]/g, '');
}

function formatCOPParaExcepciones(value) {
  const num = Number(value);
  if (isNaN(num)) return String(value || '—');
  return '$' + num.toLocaleString('es-CO');
}

// Tolerancia (en pesos) para las comparaciones de cuadratura de valores
// -- la MISMA que ya usan generarAsientoEgreso() (asientos.js) y el
// cálculo de valores_descuadrados al guardar (server.js). Antes de esta
// tarea, el aviso "no cuadra" que se mostraba ANTES de guardar en
// Escanear y Carga masiva usaba $5 de tolerancia mientras el servidor ya
// usaba $1 -- exactamente el tipo de desincronización silenciosa que
// esta tarea busca evitar: una factura podía pasar el aviso de "sí
// cuadra" en pantalla y aun así quedar marcada valores_descuadrados=true
// (y sin asiento propuesto) apenas se guardaba. Ahora las dos usan este
// mismo número.
const TOLERANCIA_DESCUADRE = 1;

// Chequeo puro de cuadratura -- para usarlo ANTES de guardar, cuando
// todavía no existe la columna valores_descuadrados (esa es la que lee
// la excepción 'descuadre' de la lista de abajo, ya persistida por el
// servidor). Misma cuenta, dos momentos distintos.
function valoresDescuadrados(inv) {
  if (!inv) return false;
  const sinIva = Number(inv.valor_sin_iva) || 0;
  const iva = Number(inv.valor_iva) || 0;
  const conIva = Number(inv.valor_con_iva) || 0;
  return sinIva > 0 && conIva > 0 && Math.abs((sinIva + iva) - conIva) > TOLERANCIA_DESCUADRE;
}

// Cada definición: `tipo` (id estable, útil para CSS/filtros), `etiqueta`
// (texto corto para la insignia), `detecta(inv)` (boolean) y
// `detalle(inv)` (la explicación completa, para el panel/tooltip).
const DEFINICIONES_EXCEPCIONES = [
  {
    tipo: 'sin_nit',
    etiqueta: 'Sin NIT',
    detecta: (inv) => !soloDigitosParaExcepciones(inv.nit_cc),
    detalle: () => 'El emisor quedó sin un NIT/cédula numérico -- verifica que el documento realmente no lo traiga antes de reportarlo así.',
  },
  {
    tipo: 'letras_no_coincide',
    etiqueta: 'Letras ≠ números',
    detecta: (inv) => {
      if (!inv.valor_letras_texto) return false;
      const numero = Number(inv.valor_letras_numero) || 0;
      const total = Number(inv.valor_con_iva) || 0;
      return numero > 0 && Math.abs(numero - total) > 1;
    },
    detalle: (inv) => `El valor escrito en letras ("${inv.valor_letras_texto}", ≈ ${formatCOPParaExcepciones(inv.valor_letras_numero)}) no coincide con el total en números (${formatCOPParaExcepciones(inv.valor_con_iva)}) -- puede ser un error de digitación o de imprenta del documento original.`,
  },
  {
    tipo: 'saldo_vencido',
    etiqueta: 'Saldo vencido',
    detecta: (inv) => inv.saldo_vencido_detectado === true || inv.saldo_vencido_detectado === 'true',
    detalle: () => 'El documento muestra explícitamente un saldo vencido de un periodo anterior -- confirma que ese saldo no se esté registrando dos veces.',
  },
  {
    tipo: 'anticipo',
    etiqueta: 'Anticipo',
    detecta: (inv) => inv.anticipo_detectado === true || inv.anticipo_detectado === 'true',
    detalle: (inv) => (Number(inv.valor_abonado) || 0) > 0
      ? `El documento indica un anticipo ya abonado de ${formatCOPParaExcepciones(inv.valor_abonado)} -- confirma que el registro contable no lo esté cobrando de nuevo.`
      : 'El documento menciona un anticipo o avance ya entregado, sin dar un valor exacto -- revisa si el total ya lo descuenta.',
  },
  {
    tipo: 'descuadre',
    etiqueta: 'Valores no cuadran',
    detecta: (inv) => inv.valores_descuadrados === true || inv.valores_descuadrados === 'true',
    detalle: (inv) => {
      const sinIva = Number(inv.valor_sin_iva) || 0;
      const iva = Number(inv.valor_iva) || 0;
      return `Subtotal + IVA (${formatCOPParaExcepciones(sinIva + iva)}) no coincide con el Total (${formatCOPParaExcepciones(inv.valor_con_iva)}) -- por eso, si es egreso, probablemente tampoco tenga un asiento contable propuesto.`;
    },
  },
];

function listaExcepciones(inv) {
  if (!inv) return [];
  const encontradas = [];
  for (const def of DEFINICIONES_EXCEPCIONES) {
    let aplica = false;
    try { aplica = !!def.detecta(inv); } catch (e) { aplica = false; }
    if (aplica) encontradas.push({ tipo: def.tipo, etiqueta: def.etiqueta, detalle: def.detalle(inv) });
  }
  return encontradas;
}

// Chequeo puntual de UNA sola excepción por su `tipo` -- para las
// pantallas de captura (Escanear, Carga masiva), que necesitan preguntar
// "¿esta condición puntual aplica?" en un punto concreto del flujo (por
// ejemplo, para decidir si mostrar el botón "guardar de todas formas"),
// en vez de recalcular las 5 con listaExcepciones() cada vez.
function tieneExcepcion(inv, tipo) {
  if (!inv) return false;
  const def = DEFINICIONES_EXCEPCIONES.find((d) => d.tipo === tipo);
  if (!def) return false;
  try { return !!def.detecta(inv); } catch (e) { return false; }
}

// ---------- Export para Node (mismo patrón que public/retenciones.js) ----------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFINICIONES_EXCEPCIONES,
    listaExcepciones,
    tieneExcepcion,
    soloDigitosParaExcepciones,
    valoresDescuadrados,
    TOLERANCIA_DESCUADRE,
  };
}
