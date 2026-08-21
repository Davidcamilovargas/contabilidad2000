require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;

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

if (!GOOGLE_CLIENT_ID) {
  console.error('\n[ERROR] No se encontró GOOGLE_CLIENT_ID en el archivo .env');
  console.error('Crea credenciales OAuth en https://console.cloud.google.com/apis/credentials y pega el Client ID en tu .env.\n');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('\n[ERROR] No se encontró JWT_SECRET en el archivo .env');
  console.error('Inventa cualquier texto largo y secreto y ponlo como JWT_SECRET en tu .env (ej. una frase random de 40+ caracteres).\n');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Conexión a PostgreSQL. Supabase requiere SSL; en local (Postgres propio)
// normalmente no hace falta, por eso se desactiva la verificación estricta
// del certificado en vez de exigirla siempre.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      nombre TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
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
      rete_fuente TEXT DEFAULT '',
      rete_iva TEXT DEFAULT '',
      rete_ica TEXT DEFAULT '',
      concepto TEXT DEFAULT '',
      tipo_movimiento TEXT DEFAULT 'egreso',
      adquiriente_nit TEXT DEFAULT '',
      adquiriente_nombre TEXT DEFAULT '',
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id UUID PRIMARY KEY,
      nombre TEXT DEFAULT '',
      nit TEXT DEFAULT '',
      dv TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS authorized_emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      nota TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Si la tabla ya existía de antes de este arreglo, esto hace que el id
  // se genere solo de ahora en adelante -- útil sobre todo para cuando
  // agregas filas a mano desde el Table Editor de Supabase, donde nadie
  // le pone un id manualmente.
  await pool.query(`ALTER TABLE authorized_emails ALTER COLUMN id SET DEFAULT gen_random_uuid();`);
  // Migración automática: si la tabla ya existía de una versión anterior
  // (sin estas columnas), se agregan ahora sin borrar los datos existentes.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valor_iva TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valor_con_iva TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rete_fuente TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rete_iva TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rete_ica TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tipo_movimiento TEXT DEFAULT 'egreso';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS adquiriente_nit TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS adquiriente_nombre TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cliente_id UUID;`);
  // Login: cada factura/cliente queda asociada al contador que la guardó.
  // Nullable a propósito -- los datos guardados ANTES del login existían
  // sin dueño, y no se borran ni se le asignan a nadie a la fuerza.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS contador_id UUID;`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contador_id UUID;`);
}

// ---------- Middlewares globales (deben ir ANTES que cualquier ruta
// que los necesite -- express procesa todo en orden de registro) ----------
app.use(express.json({ limit: '20mb' })); // las facturas en base64 pueden pesar varios MB
app.use(cookieParser());

// El Client ID de Google NO es secreto (a diferencia del Client Secret,
// que aquí ni siquiera se usa) -- el navegador lo necesita para mostrar
// el botón de login, así que se lo servimos desde una sola variable de
// entorno en vez de pegarlo a mano en cada página HTML.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.GOOGLE_CLIENT_ID = ${JSON.stringify(GOOGLE_CLIENT_ID)};`);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Autenticación ----------

function issueSessionCookie(res, userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('kardex_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !DATABASE_URL.includes('localhost'),
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
  });
}

// Verifica el JWT de la cookie. Si es válido, agrega req.userId.
// Si no, responde 401 en JSON (nunca redirige -- esto protege rutas /api/*).
function requireAuth(req, res, next) {
  const token = req.cookies?.kardex_session;
  if (!token) return res.status(401).json({ error: 'No has iniciado sesión.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.' });
  }
}

// Recibe el token que entrega el botón de Google (Google Identity
// Services) en el navegador, lo verifica contra los servidores de
// Google, y crea o reconoce al usuario en nuestra base de datos.
app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Falta el token de Google.' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const nombre = payload.name || '';
    const avatarUrl = payload.picture || '';

    // Si la tabla de correos autorizados tiene al menos uno registrado,
    // solo esos correos pueden entrar. Si está vacía, cualquiera puede
    // entrar (útil para no bloquearte a ti mismo antes de agregar el primero).
    const authCount = await pool.query('SELECT COUNT(*) FROM authorized_emails');
    if (Number(authCount.rows[0].count) > 0) {
      const allowed = await pool.query('SELECT 1 FROM authorized_emails WHERE LOWER(email) = LOWER($1)', [email]);
      if (allowed.rows.length === 0) {
        return res.status(403).json({ error: 'Tu correo todavía no está autorizado para usar Kárdex IA. Escríbele a David para que te dé acceso.' });
      }
    }

    const existing = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
    } else {
      const id = crypto.randomUUID();
      const { rows } = await pool.query(
        'INSERT INTO users (id, google_id, email, nombre, avatar_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [id, googleId, email, nombre, avatarUrl]
      );
      user = rows[0];
    }

    issueSessionCookie(res, user.id);
    res.json({ ok: true, user: { id: user.id, email: user.email, nombre: user.nombre, avatarUrl: user.avatar_url } });
  } catch (err) {
    console.error('Error verificando login de Google:', err);
    res.status(401).json({ error: 'No se pudo verificar tu cuenta de Google.' });
  }
});

// Le dice al frontend quién está logueado (o 401 si nadie)
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, nombre, avatar_url FROM users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado.' });
    res.json({ id: rows[0].id, email: rows[0].email, nombre: rows[0].nombre, avatarUrl: rows[0].avatar_url });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo verificar la sesión.' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('kardex_session');
  res.json({ ok: true });
});

const SAVED_FIELDS = [
  'tipo_doc', 'nit_cc', 'dv', 'nombre_razon_social',
  'letras_fe', 'numeros_fe', 'fecha_factura',
  'valor_sin_iva', 'valor_iva', 'valor_con_iva',
  'rete_fuente', 'rete_iva', 'rete_ica', 'concepto',
  'tipo_movimiento', 'adquiriente_nit', 'adquiriente_nombre', 'cliente_id',
];

function rowToInvoice(row) {
  return { ...row, savedAt: row.saved_at, saved_at: undefined };
}

// ---------- Clientes ----------

// Listar todos los clientes guardados (solo los de este contador)
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE contador_id = $1 ORDER BY nombre ASC', [req.userId]);
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo clientes:', err);
    res.status(500).json({ error: 'No se pudieron leer los clientes.' });
  }
});

// Crear un cliente nuevo, asociado a este contador
app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const { nombre, nit, dv } = req.body;
    if (!nombre || !nit) {
      return res.status(400).json({ error: 'Nombre y NIT son obligatorios.' });
    }
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      'INSERT INTO clients (id, nombre, nit, dv, contador_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, nombre, nit, dv || '', req.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creando cliente:', err);
    res.status(500).json({ error: 'No se pudo crear el cliente.' });
  }
});

// Eliminar un cliente (solo si es de este contador)
app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM clients WHERE id = $1 AND contador_id = $2', [req.params.id, req.userId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando cliente:', err);
    res.status(500).json({ error: 'No se pudo eliminar el cliente.' });
  }
});

// Listar facturas guardadas (todas, o filtradas por mes con ?month=YYYY-MM) -- solo las de este contador
app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invoices WHERE contador_id = $1 ORDER BY saved_at DESC', [req.userId]);
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
app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const values = SAVED_FIELDS.map((key) => {
      const val = req.body[key] ?? '';
      // cliente_id es de tipo UUID en la base de datos -- una cadena vacía
      // rompería la inserción, así que se convierte a NULL cuando no hay cliente.
      if (key === 'cliente_id') return val === '' ? null : val;
      return val;
    });
    const columns = [...SAVED_FIELDS, 'contador_id'].join(', ');
    const placeholders = [...SAVED_FIELDS, 'contador_id'].map((_, i) => `$${i + 2}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO invoices (id, ${columns}) VALUES ($1, ${placeholders}) RETURNING *`,
      [id, ...values, req.userId]
    );
    res.status(201).json(rowToInvoice(rows[0]));
  } catch (err) {
    console.error('Error guardando factura:', err);
    res.status(500).json({ error: 'No se pudo guardar la factura.' });
  }
});

// Eliminar una factura guardada (solo si es de este contador)
app.delete('/api/invoices/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM invoices WHERE id = $1 AND contador_id = $2', [req.params.id, req.userId]);
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
app.post('/api/extract', requireAuth, async (req, res) => {
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
  "rete_fuente": "valor de Retención en la Fuente (Rete Fuente / ReteRenta) si el documento la muestra explícitamente, en pesos ENTEROS. Si el documento no muestra esta sección o el valor es 0, usa 0",
  "rete_iva": "valor de Retención de IVA (ReteIVA) si el documento la muestra explícitamente, en pesos ENTEROS. Si no aplica o es 0, usa 0",
  "rete_ica": "valor de Retención de ICA (ReteICA) si el documento la muestra explícitamente, en pesos ENTEROS. Si no aplica o es 0, usa 0",
  "concepto": "breve descripción de qué es el gasto o servicio facturado, en pocas palabras",
  "adquiriente_nit": "número de identificación de quien RECIBE la factura (no quien la emite). Casi todas las facturas colombianas traen una segunda sección de identificación, separada de la del emisor/vendedor -- puede llamarse 'Adquiriente', 'Comprador', 'Receptor', 'Cliente', 'Datos del Cliente', o similar según el software que generó la factura. Busca esa segunda sección sin importar cómo la llamen, y extrae el NIT que aparece ahí, solo dígitos. Si no la encuentras, deja una cadena vacía",
  "adquiriente_nombre": "nombre o razón social de quien RECIBE la factura -- la misma segunda sección mencionada arriba (Adquiriente / Comprador / Receptor / Cliente, como la llame el documento). Si no la encuentras, deja una cadena vacía",
  "regimen_simple": "true si el documento menciona explícitamente que el emisor pertenece al 'Régimen Simple de Tributación' o dice algo como 'no practique ninguna retención' (suele aparecer en la sección de notas/detalles). false en cualquier otro caso, incluido cuando no estés seguro"
}

REGLA DE FORMATO PARA LOS 3 CAMPOS DE VALOR (muy importante, es el error más común):
Los documentos colombianos escriben los montos con PUNTO como separador de miles y COMA para los centavos (ej: "39.915,96" significa treinta y nueve mil novecientos quince pesos con noventa y seis centavos). Debes devolver el valor como un ENTERO en pesos, redondeando los centavos, SIN puntos, SIN comas, SIN concatenar los dígitos tal cual aparecen escritos.

Ejemplo correcto: si el documento muestra "39.915,96", el JSON debe llevar 39916 (no 3991596, no 39915.96, no 39915).
Ejemplo correcto: si el documento muestra "210.084,00", el JSON debe llevar 210084.
Ejemplo correcto: si el documento muestra "1.487.500", el JSON debe llevar 1487500.

Muchas facturas electrónicas colombianas incluyen una sección "Retenciones" o "Valores informativos" con Rete fuente, Rete IVA y Rete ICA (casi siempre en 0 si no aplica) — revisa si el documento la tiene antes de responder.

Si algún campo no se puede determinar con certeza, usa una cadena vacía "" para ese campo (excepto valor_iva, rete_fuente, rete_iva y rete_ica, que en ese caso van en 0). No inventes datos. Verifica que valor_sin_iva + valor_iva sea igual (o muy cercano, por redondeo de centavos) a valor_con_iva antes de responder.`;

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
    for (const key of ['valor_sin_iva', 'valor_iva', 'valor_con_iva', 'rete_fuente', 'rete_iva', 'rete_ica']) {
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