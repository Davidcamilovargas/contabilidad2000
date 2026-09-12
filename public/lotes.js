'use strict';

// ---------- Procesamiento de lotes en segundo plano ----------
//
// Antes, "Carga masiva" leía cada factura en el propio navegador del
// contador -- si cambiaba de página, el trabajo se perdía por completo
// (el navegador destruye la página anterior y todo lo que tenía en
// memoria). Ahora el navegador solo SUBE los archivos una vez; de ahí
// en adelante es el SERVIDOR el que va leyendo cada uno con la IA, en
// segundo plano, sin importar si el contador se fue a otra página o
// cerró la pestaña -- mientras el servidor siga corriendo, el lote
// sigue avanzando.
//
// Los lotes se procesan UNO A LA VEZ, en fila (si subes un lote nuevo
// mientras otro sigue en curso, el nuevo espera su turno) -- más
// simple que procesar varios en paralelo, y evita saturar la cuota de
// la API de Gemini.

let procesandoAhora = false;

// Se inyectan desde server.js para no duplicar la conexión a la base
// de datos ni la lógica de extracción -- este módulo no sabe nada de
// Express, solo de cómo mover un lote de "en_cola" a "completado".
let pool, crypto, procesarExtraccionFactura, procesarPaqueteDocumento, detectarClienteYMovimientoServidor;

function init(deps) {
  pool = deps.pool;
  crypto = deps.crypto;
  procesarExtraccionFactura = deps.procesarExtraccionFactura;
  procesarPaqueteDocumento = deps.procesarPaqueteDocumento;
  detectarClienteYMovimientoServidor = deps.detectarClienteYMovimientoServidor;
}

async function asegurarSchemaLotes() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lotes_procesamiento (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      cliente_id UUID,
      estado TEXT NOT NULL DEFAULT 'en_cola',
      total_items INTEGER NOT NULL DEFAULT 0,
      items_procesados INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lotes_contador ON lotes_procesamiento (contador_id, estado);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lote_items (
      id UUID PRIMARY KEY,
      lote_id UUID NOT NULL REFERENCES lotes_procesamiento(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      nombre_archivo TEXT NOT NULL DEFAULT '',
      base64 TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT '',
      es_pdf BOOLEAN NOT NULL DEFAULT false,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      data TEXT NOT NULL DEFAULT '{}',
      error_msg TEXT NOT NULL DEFAULT '',
      cliente_id_detectado UUID,
      tipo_movimiento_detectado TEXT NOT NULL DEFAULT 'egreso',
      eliminado BOOLEAN NOT NULL DEFAULT false,
      documento_indice INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lote_items_lote ON lote_items (lote_id, orden);`);
  // Migración para bases ya existentes de antes de que se agregara este
  // campo -- marca en qué posición del ARCHIVO ORIGINAL vive cada fila,
  // cuando ese archivo trajo varios documentos concatenados (ver
  // procesarUnItem más abajo). NULL para una fila que nunca se desglosó.
  await pool.query(`ALTER TABLE lote_items ADD COLUMN IF NOT EXISTS documento_indice INTEGER;`);
}

// Crea un lote nuevo con sus archivos (todavía "en_cola"), y dispara el
// procesamiento en segundo plano -- no espera a que termine, responde
// de inmediato con el id del lote para que el navegador pueda
// consultarlo cuando quiera.
async function crearLote(contadorId, clienteId, archivos) {
  const loteId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO lotes_procesamiento (id, contador_id, cliente_id, estado, total_items) VALUES ($1, $2, $3, 'en_cola', $4)`,
    [loteId, contadorId, clienteId || null, archivos.length]
  );
  for (let i = 0; i < archivos.length; i++) {
    const a = archivos[i];
    await pool.query(
      `INSERT INTO lote_items (id, lote_id, orden, nombre_archivo, base64, media_type, es_pdf, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente')`,
      [crypto.randomUUID(), loteId, i, a.nombre || '', a.base64 || '', a.mediaType || '', !!a.isPdf]
    );
  }
  dispararProcesamiento(); // fire-and-forget -- no se espera aquí
  return loteId;
}

// El "motor" de la cola -- toma el lote más viejo que no haya
// terminado (en_cola o procesando con ítems pendientes) y lo procesa
// ítem por ítem. Si ya hay un procesamiento en curso en este mismo
// proceso de Node, no arranca dos a la vez.
async function dispararProcesamiento() {
  if (procesandoAhora) return;
  procesandoAhora = true;
  try {
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, contador_id FROM lotes_procesamiento WHERE estado IN ('en_cola', 'procesando') ORDER BY created_at ASC LIMIT 1`
      );
      if (rows.length === 0) break; // no hay nada pendiente, se detiene hasta que llegue un lote nuevo

      const lote = rows[0];
      await pool.query(`UPDATE lotes_procesamiento SET estado = 'procesando', updated_at = now() WHERE id = $1`, [lote.id]);

      const { rows: items } = await pool.query(
        `SELECT * FROM lote_items WHERE lote_id = $1 AND estado = 'pendiente' AND eliminado = false ORDER BY orden ASC, created_at ASC`,
        [lote.id]
      );

      for (const item of items) {
        await procesarUnItem(item, lote.contador_id);
        await pool.query(
          `UPDATE lotes_procesamiento SET items_procesados = items_procesados + 1, updated_at = now() WHERE id = $1`,
          [lote.id]
        );
      }

      // ¿Ya no quedan ítems pendientes en este lote? -- se marca
      // completado. Si alguien agregó más ítems mientras tanto (no
      // debería pasar hoy, pero por si acaso), el bucle de arriba lo
      // vuelve a recoger.
      const { rows: pendientesRestantes } = await pool.query(
        `SELECT COUNT(*) AS n FROM lote_items WHERE lote_id = $1 AND estado = 'pendiente' AND eliminado = false`,
        [lote.id]
      );
      if (Number(pendientesRestantes[0].n) === 0) {
        await pool.query(`UPDATE lotes_procesamiento SET estado = 'completado', updated_at = now() WHERE id = $1`, [lote.id]);
      }
    }
  } catch (err) {
    console.error('Error en el procesamiento de lotes en segundo plano:', err);
  } finally {
    procesandoAhora = false;
  }
}

// Reintenta UN solo ítem (el contador le dio "Reintentar" a una fila
// específica, o quiere forzar releer un duplicado) -- lo marca
// pendiente otra vez y despierta el motor de la cola. `contadorId` se
// verifica contra el lote dueño del ítem, para que nadie pueda
// reintentar/tocar un ítem de OTRO contador solo adivinando su UUID.
async function reintentarItem(itemId, contadorId, forzar) {
  const { rows } = await pool.query(
    `UPDATE lote_items SET estado = 'pendiente', error_msg = '', data = $3
     WHERE id = $1 AND lote_id IN (SELECT id FROM lotes_procesamiento WHERE contador_id = $2)
     RETURNING lote_id`,
    [itemId, contadorId, JSON.stringify({ __forzar: !!forzar })]
  );
  if (rows.length > 0) {
    // El lote (padre) puede haber quedado marcado "completado" de antes
    // -- si no se despierta también a él, dispararProcesamiento() nunca
    // vuelve a mirarlo (su consulta solo busca lotes en_cola/procesando),
    // y este ítem se quedaría en "pendiente" para siempre sin que nadie
    // lo vuelva a procesar.
    await pool.query(
      `UPDATE lotes_procesamiento SET estado = 'en_cola', updated_at = now() WHERE id = $1 AND estado = 'completado'`,
      [rows[0].lote_id]
    );
  }
  dispararProcesamiento();
}

async function eliminarItem(itemId, contadorId) {
  await pool.query(
    `UPDATE lote_items SET eliminado = true
     WHERE id = $1 AND lote_id IN (SELECT id FROM lotes_procesamiento WHERE contador_id = $2)`,
    [itemId, contadorId]
  );
}

// Igual que en el navegador: si la IA rechaza el documento a propósito
// (422 -- no es factura ni cuenta de cobro), reintentar no cambia nada,
// así que no se reintenta solo. Si el error parece técnico (sin
// conexión con Gemini, un 500/503 momentáneo), sí vale la pena
// reintentar unas pocas veces antes de darse por vencido.
async function procesarExtraccionConReintento(contadorId, base64, mediaType, esPdf, forzar) {
  const MAX_INTENTOS = 3;
  const ESPERA_MS = 1500;
  let ultimoError;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      return await procesarExtraccionFactura(contadorId, base64, mediaType, esPdf, forzar);
    } catch (err) {
      ultimoError = err;
      if (err.status === 422) throw err;
      if (intento < MAX_INTENTOS) await new Promise((r) => setTimeout(r, ESPERA_MS));
    }
  }
  throw ultimoError;
}

// Igual que procesarExtraccionConReintento, pero para el prompt de
// paquete (puede traer varios documentos) -- ver procesarPaqueteDocumento
// en server.js.
async function procesarPaqueteConReintento(contadorId, base64, mediaType, forzar) {
  const MAX_INTENTOS = 3;
  const ESPERA_MS = 1500;
  let ultimoError;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      return await procesarPaqueteDocumento(contadorId, base64, mediaType, forzar);
    } catch (err) {
      ultimoError = err;
      if (err.status === 422) throw err;
      if (intento < MAX_INTENTOS) await new Promise((r) => setTimeout(r, ESPERA_MS));
    }
  }
  throw ultimoError;
}

// Guarda en UNA fila de lote_items el resultado de UN documento ya
// procesado -- ya sea un documento que llegó solo (envuelto como
// { tipo: 'factura', data }), o uno de los que salieron de desglosar un
// paquete (ver procesarUnItem). Misma lógica de siempre: duplicado,
// listo (cliente identificado con confianza) o revisar (no se pudo
// identificar el cliente/proveedor solo).
async function guardarResultadoDocumento(itemId, contadorId, doc) {
  if (doc.tipo === 'rechazado') {
    await pool.query(
      `UPDATE lote_items SET estado = 'error', error_msg = $2 WHERE id = $1`,
      [itemId, doc.mensaje || 'Este documento no parece ser una factura ni cuenta de cobro.']
    );
    return;
  }

  const parsed = doc.data;
  if (parsed.duplicado) {
    await pool.query(
      `UPDATE lote_items SET estado = 'duplicado', data = $2 WHERE id = $1`,
      [itemId, JSON.stringify(parsed)]
    );
    return;
  }

  const deteccion = await detectarClienteYMovimientoServidor(contadorId, parsed);
  await pool.query(
    `UPDATE lote_items SET estado = $2, data = $3, cliente_id_detectado = $4, tipo_movimiento_detectado = $5 WHERE id = $1`,
    [itemId, deteccion.confiado ? 'listo' : 'revisar', JSON.stringify(parsed), deteccion.clienteId || null, deteccion.tipoMovimiento]
  );
}

// Un PDF puede traer varios documentos concatenados (varias facturas
// escaneadas y unidas en un solo archivo, por ejemplo) -- esta función
// los detecta y los DESGLOSA en filas independientes del lote, una por
// cada documento, para que el contador revise y guarde cada uno por su
// lado (en vez de que Carga masiva trate el archivo completo como una
// sola factura, que era el comportamiento de antes).
async function procesarUnItem(item, contadorId) {
  await pool.query(`UPDATE lote_items SET estado = 'procesando' WHERE id = $1`, [item.id]);

  // Si este ítem viene de un reintento, `data` trae temporalmente la
  // marca de "forzar" (ver reintentarItem) -- se lee y se limpia.
  let forzar = false;
  try {
    const marcaPrevia = JSON.parse(item.data || '{}');
    forzar = !!marcaPrevia.__forzar;
  } catch (e) { /* data no era la marca de reintento, se ignora */ }

  try {
    if (!item.es_pdf) {
      // Una foto es siempre un solo documento -- mismo camino de
      // siempre, sin pasar por el prompt de segmentación de paquete.
      const parsed = await procesarExtraccionConReintento(contadorId, item.base64, item.media_type, false, forzar);
      await guardarResultadoDocumento(item.id, contadorId, { tipo: 'factura', data: parsed });
      return;
    }

    const { documentos } = await procesarPaqueteConReintento(contadorId, item.base64, 'application/pdf', forzar);

    // Este ítem YA sabe en qué posición del archivo original vive (se
    // le marcó la primera vez que se procesó, ver más abajo) -- eso
    // pasa cuando se reintenta un documento que salió de desglosar un
    // paquete: solo hay que volver a guardar SU resultado puntual, sin
    // volver a insertar (ni tocar) a sus hermanos, o cada reintento
    // duplicaría todo el paquete de nuevo.
    if (item.documento_indice !== null && item.documento_indice !== undefined) {
      const doc = documentos[item.documento_indice] || { tipo: 'rechazado', mensaje: 'No se pudo volver a ubicar este documento dentro del archivo original -- intenta subirlo de nuevo por separado.' };
      await guardarResultadoDocumento(item.id, contadorId, doc);
      return;
    }

    // Primera vez que se procesa este archivo. Si trae un solo
    // documento (el caso normal, con mucha diferencia) esta fila se
    // queda igual que siempre. Si trae varios, esta fila se queda con
    // el PRIMERO y se insertan filas nuevas para cada uno de los demás
    // -- así el resumen de Carga masiva muestra cada documento como su
    // propia fila, lista para revisar y guardar de forma individual.
    if (documentos.length > 1) {
      await pool.query(
        `UPDATE lotes_procesamiento SET total_items = total_items + $2, updated_at = now() WHERE id = $1`,
        [item.lote_id, documentos.length - 1]
      );
      await pool.query(
        `UPDATE lote_items SET documento_indice = 0, nombre_archivo = $2 WHERE id = $1`,
        [item.id, `${item.nombre_archivo} (documento 1 de ${documentos.length})`]
      );
    } else {
      await pool.query(`UPDATE lote_items SET documento_indice = 0 WHERE id = $1`, [item.id]);
    }
    await guardarResultadoDocumento(item.id, contadorId, documentos[0]);

    for (let i = 1; i < documentos.length; i++) {
      const nuevoId = crypto.randomUUID();
      const nombreConSufijo = `${item.nombre_archivo} (documento ${i + 1} de ${documentos.length})`;
      await pool.query(
        `INSERT INTO lote_items (id, lote_id, orden, nombre_archivo, base64, media_type, es_pdf, estado, documento_indice)
         VALUES ($1, $2, $3, $4, $5, $6, true, 'procesando', $7)`,
        [nuevoId, item.lote_id, item.orden, nombreConSufijo, item.base64, item.media_type, i]
      );
      await guardarResultadoDocumento(nuevoId, contadorId, documentos[i]);
      await pool.query(
        `UPDATE lotes_procesamiento SET items_procesados = items_procesados + 1, updated_at = now() WHERE id = $1`,
        [item.lote_id]
      );
    }
  } catch (err) {
    await pool.query(
      `UPDATE lote_items SET estado = 'error', error_msg = $2 WHERE id = $1`,
      [item.id, err.publicMessage || err.message || 'No se pudo procesar este archivo.']
    );
  }
}

// El lote más reciente de este contador que no esté completado (o,
// si no hay ninguno en curso, el completado más reciente -- para que
// al volver a Carga masiva siga viendo el último resultado). Se usa
// tanto para el avisito global como para reconectar la pantalla.
async function obtenerLoteActivoOUltimo(contadorId) {
  let { rows } = await pool.query(
    `SELECT * FROM lotes_procesamiento WHERE contador_id = $1 AND estado IN ('en_cola', 'procesando') ORDER BY created_at ASC LIMIT 1`,
    [contadorId]
  );
  if (rows.length === 0) {
    ({ rows } = await pool.query(
      `SELECT * FROM lotes_procesamiento WHERE contador_id = $1 AND estado = 'completado' ORDER BY updated_at DESC LIMIT 1`,
      [contadorId]
    ));
  }
  if (rows.length === 0) return null;

  const lote = rows[0];
  const { rows: items } = await pool.query(
    `SELECT id, orden, nombre_archivo, media_type, es_pdf, estado, data, error_msg, cliente_id_detectado, tipo_movimiento_detectado
     FROM lote_items WHERE lote_id = $1 AND eliminado = false ORDER BY orden ASC, created_at ASC`,
    [lote.id]
  );
  return { ...lote, items };
}

// El archivo original (base64) de UN ítem puntual -- aparte, para no
// cargar el peso de todos los archivos en cada consulta del lote
// activo (eso se pide seguido, para el avisito). Esto solo se pide
// cuando el contador de verdad hace clic en "Ver".
async function obtenerArchivoItem(itemId, contadorId) {
  const { rows } = await pool.query(
    `SELECT base64, media_type, es_pdf, nombre_archivo FROM lote_items
     WHERE id = $1 AND lote_id IN (SELECT id FROM lotes_procesamiento WHERE contador_id = $2)`,
    [itemId, contadorId]
  );
  return rows[0] || null;
}

module.exports = {
  init,
  asegurarSchemaLotes,
  crearLote,
  dispararProcesamiento,
  reintentarItem,
  eliminarItem,
  obtenerLoteActivoOUltimo,
  obtenerArchivoItem,
};