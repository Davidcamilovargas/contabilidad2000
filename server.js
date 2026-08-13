require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error('\n[ERROR] No se encontró GEMINI_API_KEY en el archivo .env');
  console.error('Copia .env.example a .env y agrega tu clave gratuita de Google AI Studio antes de iniciar el servidor.\n');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('\n[ERROR] No se encontró DATABASE_URL en el archivo .env');
  console.error('Crea un proyecto gratis en https://supabase.com, copia el "Connection string" (modo "Transaction pooler") y pégalo en tu .env.\n');
  process.exit(1);
}

// Conexión a PostgreSQL. Supabase requiere SSL; en local (Postgres propio)
// normalmente no hace falta, por eso se desactiva la verificación estricta
// del certificado en vez de exigirla siempre.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY,
      tipo_doc TEXT DEFAULT '',
      nit_cc TEXT DEFAULT '',
      dv TEXT DEFAULT '',
      nombre_razon_social TEXT DEFAULT '',
      letras_fe TEXT DEFAULT '',
      numeros_fe TEXT DEFAULT '',
      fecha_factura TEXT DEFAULT '',
      valor_sin_iva TEXT DEFAULT '',
      valor_iva TEXT DEFAULT '',
      valor_con_iva TEXT DEFAULT '',
      concepto TEXT DEFAULT '',
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Migración automática: si la tabla ya existía de una versión anterior
  // (sin estas columnas), se agregan ahora sin borrar los datos existentes.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valor_iva TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valor_con_iva TEXT DEFAULT '';`);
}

app.use(express.json({ limit: '20mb' })); // las facturas en base64 pueden pesar varios MB
app.use(express.static(path.join(__dirname, 'public')));

const SAVED_FIELDS = [
  'tipo_doc', 'nit_cc', 'dv', 'nombre_razon_social',
  'letras_fe', 'numeros_fe', 'fecha_factura',
  'valor_sin_iva', 'valor_iva', 'valor_con_iva', 'concepto',
];

function rowToInvoice(row) {
  return { ...row, savedAt: row.saved_at, saved_at: undefined };
}

// Listar facturas guardadas (todas, o filtradas por mes con ?month=YYYY-MM)
app.get('/api/invoices', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invoices ORDER BY saved_at DESC');
    const invoices = rows.map(rowToInvoice);
    const { month } = req.query;
    if (!month) return res.json(invoices);

    const filtered = invoices.filter((inv) => {
      const [d, m, y] = (inv.fecha_factura || '').split('/');
      if (!d || !m || !y) return false;
      return `${y}-${m.padStart(2, '0')}` === month;
    });
    res.json(filtered);
  } catch (err) {
    console.error('Error leyendo facturas:', err);
    res.status(500).json({ error: 'No se pudieron leer las facturas guardadas.' });
  }
});

// Guardar una factura ya revisada por el contador
app.post('/api/invoices', async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const values = SAVED_FIELDS.map((key) => req.body[key] ?? '');
    const columns = SAVED_FIELDS.join(', ');
    const placeholders = SAVED_FIELDS.map((_, i) => `$${i + 2}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO invoices (id, ${columns}) VALUES ($1, ${placeholders}) RETURNING *`,
      [id, ...values]
    );
    res.status(201).json(rowToInvoice(rows[0]));
  } catch (err) {
    console.error('Error guardando factura:', err);
    res.status(500).json({ error: 'No se pudo guardar la factura.' });
  }
});

// Eliminar una factura guardada
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Factura no encontrada.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando factura:', err);
    res.status(500).json({ error: 'No se pudo eliminar la factura.' });
  }
});

// Modelo gratuito de Gemini. Si en el futuro Google lo retira, cambia este valor
// por el modelo Flash vigente (revisa https://ai.google.dev/gemini-api/docs/models).
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Endpoint que recibe el archivo (imagen o PDF) y llama a la API gratuita de Gemini
app.post('/api/extract', async (req, res) => {
  const { base64, mediaType, isPdf } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const prompt = `Eres un asistente contable. Analiza la imagen o documento de esta factura colombiana y extrae EXACTAMENTE estos campos, devolviendo SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

{
  "tipo_doc": "13 si el proveedor se identifica con cédula, 31 si es NIT. Si no es claro, usa el que aplique según el número.",
  "nit_cc": "número de identificación del proveedor/emisor, solo dígitos",
  "dv": "dígito de verificación si aparece, si no aparece pon una cadena vacía",
  "nombre_razon_social": "nombre o razón social del proveedor/emisor de la factura",
  "letras_fe": "prefijo alfabético de la factura electrónica si existe (ej: FE, SETP), si no existe cadena vacía",
  "numeros_fe": "número o consecutivo de la factura electrónica, solo el número",
  "fecha_factura": "fecha de la factura en formato DD/MM/AAAA",
  "valor_sin_iva": "subtotal ANTES de IVA, en pesos colombianos ENTEROS (ver regla de formato abajo)",
  "valor_iva": "valor del IVA (impuesto), en pesos colombianos ENTEROS. Si la factura no discrimina IVA, usa 0",
  "valor_con_iva": "valor TOTAL de la factura (subtotal + IVA + otros cargos), en pesos colombianos ENTEROS. Este debe ser el total final que paga el cliente",
  "concepto": "breve descripción de qué es el gasto o servicio facturado, en pocas palabras"
}

REGLA DE FORMATO PARA LOS 3 CAMPOS DE VALOR (muy importante, es el error más común):
Los documentos colombianos escriben los montos con PUNTO como separador de miles y COMA para los centavos (ej: "39.915,96" significa treinta y nueve mil novecientos quince pesos con noventa y seis centavos). Debes devolver el valor como un ENTERO en pesos, redondeando los centavos, SIN puntos, SIN comas, SIN concatenar los dígitos tal cual aparecen escritos.

Ejemplo correcto: si el documento muestra "39.915,96", el JSON debe llevar 39916 (no 3991596, no 39915.96, no 39915).
Ejemplo correcto: si el documento muestra "210.084,00", el JSON debe llevar 210084.
Ejemplo correcto: si el documento muestra "1.487.500", el JSON debe llevar 1487500.

Si algún campo no se puede determinar con certeza, usa una cadena vacía "" para ese campo (excepto valor_iva, que en ese caso va en 0). No inventes datos. Verifica que valor_sin_iva + valor_iva sea igual (o muy cercano, por redondeo de centavos) a valor_con_iva antes de responder.`;

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: effectiveMediaType, data: base64 } },
                { text: prompt }
              ]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Error de Gemini API:', response.status, errText);
      let detail = errText;
      try {
        const parsedErr = JSON.parse(errText);
        detail = parsedErr.error?.message || errText;
      } catch (_) { /* dejar el texto crudo si no es JSON */ }
      return res.status(response.status).json({ error: `Error de la API de Gemini (${response.status}): ${detail}` });
    }

    const data = await response.json();
    const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textOut) {
      return res.status(500).json({ error: 'No se recibió una respuesta de texto de la API.' });
    }

    let clean = textOut.trim();
    clean = clean.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: 'No se pudo interpretar la respuesta de la IA. Intenta con una imagen más clara.' });
    }

    // Capa de seguridad extra: si la IA devolvió centavos (ej. 39915.96) en
    // vez del entero pedido, se redondea aquí antes de mostrarlo/guardarlo.
    for (const key of ['valor_sin_iva', 'valor_iva', 'valor_con_iva']) {
      if (parsed[key] !== undefined && parsed[key] !== '' && !isNaN(Number(parsed[key]))) {
        parsed[key] = Math.round(Number(parsed[key]));
      }
    }

    res.json(parsed);

  } catch (err) {
    console.error('Error al llamar a Gemini:', err);
    res.status(500).json({ error: 'Error de conexión con la API de Gemini.' });
  }
});

app.listen(PORT, async () => {
  try {
    await ensureSchema();
    console.log(`\n✔ Kárdex IA corriendo en http://localhost:${PORT}`);
    console.log(`✔ Base de datos conectada y lista\n`);
  } catch (err) {
    console.error('\n[ERROR] No se pudo conectar/preparar la base de datos:', err.message);
    console.error('Verifica que tu DATABASE_URL en .env sea correcta.\n');
  }
});