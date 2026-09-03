require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');
const integraciones = require('./integraciones');
const cartera = require('./cartera');

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
  // Categoría oficial de retención (compras/servicios/honorarios/etc.) --
  // la asigna la IA al leer la factura, reemplaza la detección por
  // palabras clave que se usaba antes para elegir el umbral correcto.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS categoria_concepto TEXT DEFAULT '';`);
  // Si el emisor es Régimen Simple -- la IA lo detecta al leer, pero
  // hasta ahora nunca se guardaba. Sin esto, el cálculo de retención
  // sugerida no puede saber esto para facturas ya guardadas.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS regimen_simple BOOLEAN DEFAULT false;`);
  // Desglose del subtotal por categoría, para facturas que mezclan
  // ítems de distinta naturaleza (ej. productos + mano de obra en la
  // misma factura) -- se guarda como texto JSON, ej: '{"compras":442000,"servicios":140000}'.
  // Vacío ('' o '{}') significa que toda la factura es una sola categoría.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS desglose_categorias TEXT DEFAULT '';`);
  // La subcuenta PUC del gasto (clase 5) que el contador confirmó a
  // mano -- distinta de la cuenta de retención (grupo 2365). El
  // sistema nunca la adivina sola cuando hay ambigüedad (ej. "compras"
  // puede ser inventario, papelería, aseo...), el contador la elige.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subcuenta_gasto TEXT DEFAULT '';`);
  // Login: cada factura/cliente queda asociada al contador que la guardó.
  // Nullable a propósito -- los datos guardados ANTES del login existían
  // sin dueño, y no se borran ni se le asignan a nadie a la fuerza.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS contador_id UUID;`);
  // Huella (SHA-256) del archivo original de cada factura -- permite
  // reconocer que un documento YA se leyó y se guardó antes, sin tener
  // que volver a mandarlo a la IA. Vacía para facturas guardadas antes
  // de este cambio (no se puede recalcular retroactivamente sin el
  // archivo original).
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS file_hash TEXT DEFAULT '';`);
  // Índice parcial (ignora las filas con file_hash vacío) para que la
  // búsqueda de duplicados por contador sea instantánea incluso con
  // miles de facturas guardadas.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_contador_filehash ON invoices (contador_id, file_hash) WHERE file_hash <> '';`);

  // ---------- Ítems de factura (Fase 4 -- desglose línea por línea) ----------
  // Antes solo se guardaba `desglose_categorias`, un resumen agregado
  // ("compras: 442000, servicios: 140000") -- suficiente para calcular la
  // retención total, pero sin rastro de CUÁLES líneas reales de la
  // factura formaban cada categoría. Esta tabla guarda cada ítem tal
  // cual viene en el documento (o el ítem único que representa toda la
  // factura, si no trae tabla de líneas), con su propia categoría y
  // subcuenta PUC -- así una factura que mezcla productos y mano de obra
  // ya no se trata como un solo bloque, sino línea por línea, igual que
  // el contador la vería en el papel.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factura_items (
      id UUID PRIMARY KEY,
      invoice_id UUID NOT NULL,
      contador_id UUID,
      orden INTEGER NOT NULL DEFAULT 0,
      descripcion TEXT DEFAULT '',
      cantidad TEXT DEFAULT '',
      valor_unitario TEXT DEFAULT '',
      subtotal TEXT DEFAULT '',
      categoria_concepto TEXT DEFAULT '',
      subcuenta_gasto TEXT DEFAULT '',
      valor_iva TEXT DEFAULT '',
      iva_mayor_valor BOOLEAN NOT NULL DEFAULT false
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_factura_items_invoice ON factura_items (invoice_id);`);
  // Si la factura que los contenía se borra, sus ítems quedarían
  // huérfanos (basura que nadie vuelve a leer) -- se borran con ella.
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE factura_items ADD CONSTRAINT factura_items_invoice_fk
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // ---------- Cartera / conciliación bancaria ----------
  // Cada fila es UN movimiento de un extracto bancario (un cargo o un
  // abono). "estado" empieza en 'sin_conciliar'; cuando el contador
  // confirma contra qué factura corresponde, pasa a 'conciliado' y
  // queda invoice_id apuntando a esa factura -- varios movimientos
  // pueden apuntar a la misma factura (pagos parciales). 'ignorado' es
  // para movimientos que el contador marcó como que NO corresponden a
  // ninguna factura (comisiones bancarias, traslados entre cuentas
  // propias, etc.), para que dejen de aparecer como pendientes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimientos_banco (
      id UUID PRIMARY KEY,
      contador_id UUID,
      cliente_id UUID,
      extracto_id UUID,
      fecha TEXT DEFAULT '',
      descripcion TEXT DEFAULT '',
      valor TEXT DEFAULT '',
      tipo TEXT DEFAULT '',
      invoice_id UUID,
      estado TEXT NOT NULL DEFAULT 'sin_conciliar',
      file_hash TEXT DEFAULT '',
      mes TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Un contador no revisa la cartera por año -- la revisa mes a mes, igual
  // que Facturas/Ingresos/Egresos. "mes" es el período contable que el
  // contador eligió al subir ESE extracto (formato "AAAA-MM"), no una
  // fecha calculada -- así un extracto que cruza fin de mes no queda
  // partido entre dos períodos distintos sin que el contador lo decida.
  await pool.query(`ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS mes TEXT DEFAULT '';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movbanco_contador_cliente ON movimientos_banco (contador_id, cliente_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movbanco_mes ON movimientos_banco (contador_id, cliente_id, mes);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movbanco_invoice ON movimientos_banco (invoice_id) WHERE invoice_id IS NOT NULL;`);
  // Evita procesar dos veces el mismo extracto (mismos bytes) para el
  // mismo cliente -- igual que file_hash en invoices, pero aquí por
  // archivo de extracto completo, no por movimiento individual.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_movbanco_filehash ON movimientos_banco (contador_id, cliente_id, file_hash) WHERE file_hash <> '';`);

  // ---------- Plantillas de exportación ----------
  // Ni Helisa ni World Office tienen UN formato fijo de importación --
  // cada contador configura sus propias columnas dentro de su software
  // (orden, cuentas, centros de costo...). Por eso esto no es una lista
  // de plantillas fijas por plataforma, sino que el contador arma la
  // suya (qué campo va en cada columna, con qué encabezado) y la guarda
  // para reusarla cada mes. "columnas" es un arreglo JSON de
  // {campo, encabezado, valorConstante, formatoFecha}.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plantillas_exportacion (
      id UUID PRIMARY KEY,
      contador_id UUID,
      nombre TEXT NOT NULL DEFAULT '',
      columnas TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plantillas_contador ON plantillas_exportacion (contador_id);`);

  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contador_id UUID;`);
  // Si el cliente es agente retenedor -- sin esto no tiene sentido
  // calcular ninguna retención sugerida (si no es agente retenedor,
  // nunca le corresponde retener, sin importar el monto).
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS agente_retenedor BOOLEAN DEFAULT false;`);
  // Expansión del modelo de clientes: datos básicos, tributarios, RUT,
  // contacto principal, e información bancaria (para conectar pagos
  // más adelante y hacer relación con la cartera del cliente).
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS tipo_persona TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS direccion TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ciudad TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS telefono TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS correo TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ciiu TEXT DEFAULT '';`);
  // Códigos de responsabilidad tributaria del RUT (casilla 53), separados
  // por coma, ej: "05,07,47". "agente_retenedor" se calcula solo a
  // partir de si el código 07 está en esta lista -- ya no se marca a mano.
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS responsabilidades TEXT DEFAULT '';`);
  // El RUT se guarda como archivo (base64) -- por ahora solo se
  // almacena, sin lectura automática con IA (fase futura).
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS rut_archivo TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS rut_archivo_nombre TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contacto_nombre TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contacto_cargo TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contacto_telefono TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS contacto_correo TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS banco TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS tipo_cuenta TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS numero_cuenta TEXT DEFAULT '';`);

  // "Memoria" de correcciones -- guarda qué categoría corrigió cada
  // contador para qué palabra del concepto. No es que la IA aprenda,
  // es que Kárdex IA recuerda y aplica la corrección la próxima vez,
  // antes de mostrarle el resultado al contador.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS concepto_correcciones (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      palabra TEXT NOT NULL,
      categoria TEXT NOT NULL,
      veces_usado INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, palabra)
    );
  `);
  // "Memoria" de la tarifa real de cada proveedor -- cuando el contador
  // escribe un valor de Rete Fuente que coincide con la tarifa alta (no
  // declarante) o baja (declarante), lo recordamos por NIT + categoría.
  // Así, la próxima factura de ese mismo proveedor en esa categoría usa
  // el valor exacto en vez de mostrar un rango.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarifa_proveedor_aprendida (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      nit_proveedor TEXT NOT NULL,
      categoria TEXT NOT NULL,
      tarifa NUMERIC NOT NULL,
      veces_confirmado INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, nit_proveedor, categoria)
    );
  `);

  // Perfil fiscal del tercero (proveedor/cliente que aparece EN las
  // facturas, no el cliente del contador) -- por NIT. Antes lo único
  // que decidía si un proveedor era Régimen Simple era lo que la IA
  // leyera de CADA documento (`invoices.regimen_simple`) -- si la IA se
  // equivocaba, o la factura no lo mostraba claro, la retención podía
  // calcularse mal sin que nadie se diera cuenta. Ahora el contador
  // marca el perfil de ese NIT UNA vez y queda guardado -- eso manda
  // sobre lo que diga la lectura automática de ahí en adelante (ver
  // perfilFiscalEfectivo() en public/retenciones.js).
  //
  // "Gran Contribuyente" y "Agente de retención de IVA" se guardan
  // como información -- se muestran como advertencia al contador, pero
  // no fuerzan un cálculo solos, porque la regla de a quién le toca
  // retener en esos casos es más matizada (depende de jerarquías de
  // retención) y no queremos adivinar con plata. "Régimen Simple" y
  // "Autorretenedor" sí fuerzan la retención en la fuente a $0, porque
  // esa regla SÍ es inequívoca.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terceros_fiscales (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      nit TEXT NOT NULL,
      nombre TEXT NOT NULL DEFAULT '',
      gran_contribuyente BOOLEAN NOT NULL DEFAULT false,
      autorretenedor BOOLEAN NOT NULL DEFAULT false,
      regimen_simple BOOLEAN NOT NULL DEFAULT false,
      agente_retencion_iva BOOLEAN NOT NULL DEFAULT false,
      notas TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, nit)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_terceros_fiscales_contador ON terceros_fiscales (contador_id);`);

  // Tarifas de ReteICA -- a diferencia de Rete Fuente/Rete IVA (que son
  // nacionales, una sola tabla vale para todo el país), el ICA lo fija
  // CADA municipio (hay más de 1.100 en Colombia) y la tarifa además
  // cambia según la actividad económica -- no existe una tabla
  // nacional confiable que esta app pueda traer ya puesta sin
  // arriesgarse a inventar un número con plata de por medio. Por eso
  // el contador arma su propia tabla: municipio + actividad + tarifa
  // por mil + base mínima (en UVT, porque también varía por municipio)
  // + la cuenta PUC auxiliar donde se contabiliza (ej. 23680101 para
  // Bogotá, 23680102 para Medellín -- cada contador nombra la suya).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarifas_ica (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      municipio TEXT NOT NULL,
      actividad TEXT NOT NULL DEFAULT '',
      tarifa_por_mil NUMERIC NOT NULL,
      base_uvt NUMERIC NOT NULL DEFAULT 0,
      cuenta_puc TEXT NOT NULL DEFAULT '',
      notas TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, municipio, actividad)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tarifas_ica_contador ON tarifas_ica (contador_id);`);

  // Qué tarifa de ICA (de la tabla de arriba) se usó al calcular el
  // Rete ICA sugerido de esta factura -- queda guardado junto con la
  // factura para que quede trazable después (ej. al exportar o
  // auditar) de dónde salió el número, sin tener que adivinar cuál
  // municipio se usó.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tarifa_ica_id UUID;`);
  // Plan del contador -- define cuántos clientes puede registrar.
  // Se asigna manualmente hoy (desde Supabase) hasta que exista cobro
  // real; "solo" es el valor por defecto para cualquier cuenta nueva.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'solo';`);

  // Integraciones con software contable externo (Alegra, y a futuro
  // Siigo u otros) -- una fila por contador+proveedor conectado. El
  // token nunca se guarda en texto plano, siempre pasa por
  // integraciones.cifrar() antes de llegar aquí.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integraciones_contables (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      proveedor TEXT NOT NULL,
      email TEXT DEFAULT '',
      token_cifrado TEXT NOT NULL,
      activo BOOLEAN NOT NULL DEFAULT true,
      conectado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultima_sincronizacion TIMESTAMPTZ,
      configuracion TEXT NOT NULL DEFAULT '{}',
      UNIQUE (contador_id, proveedor)
    );
  `);
  // Configuración específica del proveedor que no se puede adivinar
  // (ej. en Siigo: qué tipo de comprobante y qué forma de pago usar --
  // son ids que solo existen en LA cuenta de ese contador). Se agrega
  // aparte por si la tabla ya existía de antes de este campo.
  await pool.query(`ALTER TABLE integraciones_contables ADD COLUMN IF NOT EXISTS configuracion TEXT NOT NULL DEFAULT '{}';`);
  // A qué factura de Alegra/Siigo (u otro proveedor) corresponde cada
  // factura guardada en Kárdex IA, para no volver a crearla si se manda
  // "Enviar" dos veces, y para mostrar el estado en Facturas. Cada
  // proveedor tiene sus propias columnas porque una misma factura se
  // podría enviar a más de uno.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS alegra_bill_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS alegra_enviada_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS siigo_bill_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS siigo_enviada_at TIMESTAMPTZ;`);
}

// Nombres de columna (whitelisteados, nunca vienen del usuario) donde
// cada proveedor guarda el id de la factura ya enviada -- así la ruta
// de envío no queda pegada a Alegra, y sumar un proveedor nuevo es
// agregar una entrada aquí + sus 2 columnas ALTER TABLE de arriba.
const COLUMNAS_ENVIO_PROVEEDOR = {
  alegra: { billId: 'alegra_bill_id', enviadaAt: 'alegra_enviada_at' },
  siigo: { billId: 'siigo_bill_id', enviadaAt: 'siigo_enviada_at' },
};

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
    const { rows } = await pool.query('SELECT id, email, nombre, avatar_url, plan FROM users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado.' });

    const plan = rows[0].plan || 'solo';
    const limite = clientLimitFor(plan);
    const countRes = await pool.query('SELECT COUNT(*) FROM clients WHERE contador_id = $1', [req.userId]);
    const actuales = Number(countRes.rows[0].count);

    res.json({
      id: rows[0].id, email: rows[0].email, nombre: rows[0].nombre, avatarUrl: rows[0].avatar_url,
      plan, limiteClientes: limite, clientesActuales: actuales,
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo verificar la sesión.' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('kardex_session');
  res.json({ ok: true });
});

// Cuántos clientes puede registrar cada contador, según su plan.
// Un plan que no aparezca aquí (ej. uno nuevo a futuro) se trata como
// ilimitado -- así no hay que tocar código para lanzar un plan "todo
// incluido" más adelante.
const PLAN_LIMITS = {
  solo: 5,
  profesional: 10,
};

function clientLimitFor(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : null; // null = sin límite
}

// ---------- Memoria de correcciones de categoría ----------

const STOPWORDS = new Set([
  'de','la','el','los','las','un','una','unos','unas','para','por','con',
  'en','del','al','y','o','a','su','sus','the','and',
]);

// Saca las palabras "significativas" de un concepto -- las que sirven
// para reconocer el mismo tipo de gasto la próxima vez (ignora
// conectores cortos como "de", "la", "para").
function extraerPalabrasClave(concepto) {
  return (concepto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

// Revisa si alguna palabra del concepto tiene una corrección guardada
// por este contador, y si la hay, la devuelve (la más usada primero).
// No cambia nada si no encuentra ninguna coincidencia.
async function buscarCorreccionAprendida(contadorId, concepto) {
  const palabras = extraerPalabrasClave(concepto);
  if (palabras.length === 0) return null;

  const { rows } = await pool.query(
    'SELECT categoria, palabra, veces_usado FROM concepto_correcciones WHERE contador_id = $1 AND palabra = ANY($2) ORDER BY veces_usado DESC, updated_at DESC LIMIT 1',
    [contadorId, palabras]
  );
  return rows.length > 0 ? rows[0].categoria : null;
}

// Guarda (o refuerza) una corrección: el contador cambió la categoría
// que sugirió la IA por otra distinta, para este concepto.
async function guardarCorreccion(contadorId, concepto, categoriaFinal) {
  const palabras = extraerPalabrasClave(concepto);
  for (const palabra of palabras) {
    await pool.query(
      `INSERT INTO concepto_correcciones (id, contador_id, palabra, categoria, veces_usado)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (contador_id, palabra)
       DO UPDATE SET categoria = $4, veces_usado = concepto_correcciones.veces_usado + 1, updated_at = now()`,
      [crypto.randomUUID(), contadorId, palabra, categoriaFinal]
    );
  }
}

// ---------- Memoria de la tarifa real por proveedor ----------

// Solo estas categorías tienen una diferencia real entre tarifa
// declarante/no declarante -- las demás son tarifa fija, no hay nada
// que aprender ahí (ver TARIFAS_RETENCION en facturas.html).
const TARIFAS_CON_RANGO = {
  compras: { tarifaBaja: 0.025, tarifaAlta: 0.035 },
  servicios: { tarifaBaja: 0.04, tarifaAlta: 0.06 },
  honorarios_natural: { tarifaBaja: 0.10, tarifaAlta: 0.11 },
};

// Revisa si el valor de Rete Fuente que el contador escribió coincide
// con alguna de las 2 tarifas conocidas para esa categoría -- si
// coincide, devuelve cuál (para poder recordarla). Si no coincide con
// ninguna (ej. el contador escribió cualquier otra cosa), no se
// aprende nada -- mejor no adivinar que aprender algo incorrecto.
function detectarTarifaUsada(categoria, subtotal, reteFuenteEscrito) {
  const config = TARIFAS_CON_RANGO[categoria];
  if (!config || !subtotal || !reteFuenteEscrito) return null;
  const tolerancia = Math.max(50, Math.round(subtotal * 0.001));
  const valorBaja = Math.round(subtotal * config.tarifaBaja);
  const valorAlta = Math.round(subtotal * config.tarifaAlta);
  if (Math.abs(reteFuenteEscrito - valorBaja) <= tolerancia) return config.tarifaBaja;
  if (Math.abs(reteFuenteEscrito - valorAlta) <= tolerancia) return config.tarifaAlta;
  return null;
}

async function guardarTarifaProveedor(contadorId, nitProveedor, categoria, tarifa) {
  await pool.query(
    `INSERT INTO tarifa_proveedor_aprendida (id, contador_id, nit_proveedor, categoria, tarifa, veces_confirmado)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (contador_id, nit_proveedor, categoria)
     DO UPDATE SET tarifa = $5, veces_confirmado = tarifa_proveedor_aprendida.veces_confirmado + 1, updated_at = now()`,
    [crypto.randomUUID(), contadorId, nitProveedor, categoria, tarifa]
  );
}

const SAVED_FIELDS = [
  'tipo_doc', 'nit_cc', 'dv', 'nombre_razon_social',
  'letras_fe', 'numeros_fe', 'fecha_factura',
  'valor_sin_iva', 'valor_iva', 'valor_con_iva',
  'rete_fuente', 'rete_iva', 'rete_ica', 'concepto', 'categoria_concepto',
  'tipo_movimiento', 'adquiriente_nit', 'adquiriente_nombre', 'cliente_id',
  'regimen_simple', 'desglose_categorias', 'subcuenta_gasto', 'file_hash',
  'tarifa_ica_id',
];

function rowToInvoice(row) {
  return { ...row, savedAt: row.saved_at, saved_at: undefined };
}

// ---------- Detección de documentos duplicados ----------

// Huella determinística del archivo: mismo archivo (mismos bytes) ==
// mismo hash, sin importar el nombre con el que se subió ni cuándo.
// Se calcula sobre el base64 tal cual lo manda el navegador (no hace
// falta decodificarlo a binario primero -- es una correspondencia 1 a 1).
function calcularFileHash(base64) {
  return crypto.createHash('sha256').update(base64, 'utf8').digest('hex');
}

// Datos mínimos y seguros para mostrarle al contador cuál factura ya
// existe -- nunca el registro completo (no hace falta, y evita mandar
// de más).
const CAMPOS_FACTURA_EXISTENTE = `
  id, nombre_razon_social, numeros_fe, letras_fe, fecha_factura,
  valor_con_iva, tipo_movimiento, cliente_id, saved_at
`;

async function buscarFacturaPorHash(contadorId, fileHash) {
  if (!fileHash) return null;
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_FACTURA_EXISTENTE} FROM invoices WHERE contador_id = $1 AND file_hash = $2 LIMIT 1`,
    [contadorId, fileHash]
  );
  return rows.length > 0 ? rows[0] : null;
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

// Crear un cliente nuevo, asociado a este contador -- respetando el
// tope de clientes de su plan.
app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const {
      nombre, nit, dv, tipo_persona, direccion, ciudad, telefono, correo,
      ciiu, responsabilidades, rut_archivo, rut_archivo_nombre,
      contacto_nombre, contacto_cargo, contacto_telefono, contacto_correo,
      banco, tipo_cuenta, numero_cuenta,
    } = req.body;
    if (!nombre || !nit) {
      return res.status(400).json({ error: 'Nombre y NIT son obligatorios.' });
    }

    const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = userRes.rows[0]?.plan || 'solo';
    const limite = clientLimitFor(plan);

    if (limite !== null) {
      const countRes = await pool.query('SELECT COUNT(*) FROM clients WHERE contador_id = $1', [req.userId]);
      const actuales = Number(countRes.rows[0].count);
      if (actuales >= limite) {
        return res.status(403).json({
          error: `Tu plan (${plan}) permite hasta ${limite} clientes, y ya tienes ${actuales}. Habla con nosotros para subir de plan.`,
          limitReached: true, plan, limite, actuales,
        });
      }
    }

    // "Agente retenedor" ya no se marca a mano -- se calcula solo a
    // partir de si el código 07 (retención en la fuente) está entre
    // las responsabilidades tributarias marcadas.
    const responsabilidadesStr = responsabilidades || '';
    const agenteRetenedorCalculado = responsabilidadesStr.split(',').includes('07');

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO clients (
        id, nombre, nit, dv, contador_id, agente_retenedor,
        tipo_persona, direccion, ciudad, telefono, correo, ciiu, responsabilidades,
        rut_archivo, rut_archivo_nombre,
        contacto_nombre, contacto_cargo, contacto_telefono, contacto_correo,
        banco, tipo_cuenta, numero_cuenta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *`,
      [
        id, nombre, nit, dv || '', req.userId, agenteRetenedorCalculado,
        tipo_persona || '', direccion || '', ciudad || '', telefono || '', correo || '', ciiu || '', responsabilidadesStr,
        rut_archivo || '', rut_archivo_nombre || '',
        contacto_nombre || '', contacto_cargo || '', contacto_telefono || '', contacto_correo || '',
        banco || '', tipo_cuenta || '', numero_cuenta || '',
      ]
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

// Actualizar si un cliente es agente retenedor (sin esto, no tiene
// sentido calcular ninguna retención sugerida para ese cliente).
// Actualizar cualquiera de los datos de un cliente ya creado.
// "agente_retenedor" nunca se recibe directo del cliente -- siempre se
// recalcula a partir de las responsabilidades tributarias enviadas.
const CLIENT_EDITABLE_FIELDS = [
  'nombre', 'nit', 'dv', 'tipo_persona', 'direccion', 'ciudad', 'telefono', 'correo',
  'ciiu', 'responsabilidades', 'rut_archivo', 'rut_archivo_nombre',
  'contacto_nombre', 'contacto_cargo', 'contacto_telefono', 'contacto_correo',
  'banco', 'tipo_cuenta', 'numero_cuenta',
];

app.patch('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const updates = {};
    for (const field of CLIENT_EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    // Si vienen responsabilidades en esta actualización, recalcular
    // agente_retenedor a partir de ellas (código 07 = agente retenedor).
    if (updates.responsabilidades !== undefined) {
      updates.agente_retenedor = updates.responsabilidades.split(',').includes('07');
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'No se envió ningún campo para actualizar.' });
    }

    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map((k) => updates[k]);
    const { rows } = await pool.query(
      `UPDATE clients SET ${setClause} WHERE id = $${keys.length + 1} AND contador_id = $${keys.length + 2} RETURNING *`,
      [...values, req.params.id, req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Error actualizando cliente:', err);
    res.status(500).json({ error: 'No se pudo actualizar el cliente.' });
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

// Tarifas de retención que ya se aprendieron por proveedor -- usado
// por el Excel para mostrar el valor exacto en vez de un rango,
// cuando ya sabemos qué tarifa le corresponde a ese proveedor.
app.get('/api/tarifas-aprendidas', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT nit_proveedor, categoria, tarifa FROM tarifa_proveedor_aprendida WHERE contador_id = $1',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo tarifas aprendidas:', err);
    res.status(500).json({ error: 'No se pudieron leer las tarifas aprendidas.' });
  }
});

// Guardar una factura ya revisada por el contador
app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    // cliente_id viene del navegador -- si trae uno, hay que confirmar
    // que sea un cliente de ESTE contador antes de guardarlo. Sin este
    // chequeo, cualquiera podría mandar el id de un cliente ajeno (por
    // ejemplo adivinando o copiando un UUID) y la factura quedaría
    // asociada al cliente de otro contador en vez de quedar sin asignar.
    if (req.body.cliente_id) {
      const clienteRes = await pool.query(
        'SELECT 1 FROM clients WHERE id = $1 AND contador_id = $2',
        [req.body.cliente_id, req.userId]
      );
      if (clienteRes.rows.length === 0) {
        return res.status(400).json({ error: 'El cliente indicado no existe o no te pertenece.' });
      }
    }
    if (req.body.tarifa_ica_id) {
      const tarifaRes = await pool.query(
        'SELECT 1 FROM tarifas_ica WHERE id = $1 AND contador_id = $2',
        [req.body.tarifa_ica_id, req.userId]
      );
      if (tarifaRes.rows.length === 0) {
        return res.status(400).json({ error: 'La tarifa de ICA indicada no existe o no te pertenece.' });
      }
    }

    // Red de seguridad contra duplicados -- /api/extract ya avisa ANTES
    // de leer con IA si el archivo coincide con una factura guardada,
    // pero esto cubre el caso de que se llegue aquí sin pasar por ahí
    // (ej. una pestaña vieja, o dos subidas casi al mismo tiempo). Si el
    // contador ya confirmó que quiere guardarla de todas formas, manda
    // forzar_duplicado y se salta este chequeo.
    if (req.body.file_hash && !req.body.forzar_duplicado) {
      const existente = await buscarFacturaPorHash(req.userId, req.body.file_hash);
      if (existente) {
        return res.status(409).json({
          error: 'Este documento ya se había guardado antes -- no se guardó de nuevo para evitar un duplicado.',
          duplicado: true,
          factura_existente: existente,
        });
      }
    }

    const id = crypto.randomUUID();
    const values = SAVED_FIELDS.map((key) => {
      const val = req.body[key] ?? '';
      // cliente_id es de tipo UUID en la base de datos -- una cadena vacía
      // rompería la inserción, así que se convierte a NULL cuando no hay cliente.
      if (key === 'cliente_id') return val === '' ? null : val;
      // tarifa_ica_id es de tipo UUID igual que cliente_id -- mismo tratamiento.
      if (key === 'tarifa_ica_id') return val === '' ? null : val;
      // regimen_simple es de tipo BOOLEAN -- convertir explícitamente.
      if (key === 'regimen_simple') return val === true || val === 'true';
      return val;
    });
    const columns = [...SAVED_FIELDS, 'contador_id'].join(', ');
    const placeholders = [...SAVED_FIELDS, 'contador_id'].map((_, i) => `$${i + 2}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO invoices (id, ${columns}) VALUES ($1, ${placeholders}) RETURNING *`,
      [id, ...values, req.userId]
    );

    // Si el contador cambió la categoría que la IA sugirió, lo
    // guardamos como una corrección -- la próxima vez que aparezca un
    // concepto parecido, se la aplicamos sola, sin que tenga que
    // corregirla de nuevo. No bloquea el guardado si esto falla.
    const categoriaOriginal = req.body.categoria_concepto_ia || '';
    const categoriaFinal = req.body.categoria_concepto || '';
    if (categoriaOriginal && categoriaFinal && categoriaOriginal !== categoriaFinal) {
      try {
        await guardarCorreccion(req.userId, req.body.concepto || '', categoriaFinal);
      } catch (err) {
        console.error('No se pudo guardar la corrección aprendida:', err.message);
      }
    }

    // Si el contador escribió un valor real de Rete Fuente, y ese
    // valor coincide con una de las 2 tarifas conocidas para esta
    // categoría, lo recordamos para este proveedor específico -- la
    // próxima factura suya en esta categoría usará el valor exacto,
    // no un rango.
    try {
      const categoriaGuardada = req.body.categoria_concepto || '';
      const subtotalGuardado = Number(req.body.valor_sin_iva) || 0;
      const reteFuenteGuardado = Number(req.body.rete_fuente) || 0;
      const nitProveedorGuardado = req.body.nit_cc || '';
      if (nitProveedorGuardado && reteFuenteGuardado > 0) {
        const tarifaDetectada = detectarTarifaUsada(categoriaGuardada, subtotalGuardado, reteFuenteGuardado);
        if (tarifaDetectada !== null) {
          await guardarTarifaProveedor(req.userId, nitProveedorGuardado, categoriaGuardada, tarifaDetectada);
        }
      }
    } catch (err) {
      console.error('No se pudo guardar la tarifa aprendida del proveedor:', err.message);
    }

    // Ítems línea por línea (Fase 4) -- opcional a propósito: una factura
    // guardada antes de este cambio, o guardada desde un flujo que no
    // manda `items`, simplemente no tiene filas en factura_items, y el
    // resto de la app sigue funcionando con el desglose agregado de
    // siempre. Si algo falla guardando los ítems, NO se revierte la
    // factura ya guardada -- se guarda igual, solo sin el detalle línea
    // por línea (mismo criterio que las correcciones aprendidas arriba).
    if (Array.isArray(req.body.items) && req.body.items.length > 0) {
      try {
        let orden = 0;
        for (const item of req.body.items) {
          await pool.query(
            `INSERT INTO factura_items
              (id, invoice_id, contador_id, orden, descripcion, cantidad, valor_unitario, subtotal, categoria_concepto, subcuenta_gasto, valor_iva, iva_mayor_valor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              crypto.randomUUID(), id, req.userId, orden++,
              String(item.descripcion ?? ''), String(item.cantidad ?? ''), String(item.valor_unitario ?? ''),
              String(item.subtotal ?? ''), String(item.categoria_concepto ?? '').toLowerCase(),
              String(item.subcuenta_gasto ?? ''), String(item.valor_iva ?? ''),
              item.iva_mayor_valor === true || item.iva_mayor_valor === 'true',
            ]
          );
        }
      } catch (err) {
        console.error('No se pudieron guardar los ítems de la factura:', err.message);
      }
    }

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

// Ajustar los 3 valores de retención de una factura YA guardada -- pensado
// para el panel de validación antes de exportar/enviar (Fase 3): el
// contador revisa el resumen consolidado justo antes de exportar a Excel o
// enviar a Alegra/Siigo, y puede corregir o eximir (poner en 0) la
// retención de esa factura puntual sin tener que borrarla y registrarla de
// nuevo. A propósito solo acepta estos 3 campos -- no es un endpoint
// general de edición de factura, es específico para este checkpoint.
const CAMPOS_EDITABLES_RETENCION = ['rete_fuente', 'rete_iva', 'rete_ica'];
app.put('/api/invoices/:id', requireAuth, async (req, res) => {
  try {
    const sets = [];
    const values = [];
    let i = 1;
    for (const campo of CAMPOS_EDITABLES_RETENCION) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
        sets.push(`${campo} = $${i}`);
        values.push(String(req.body[campo] ?? ''));
        i++;
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'No se envió ningún campo válido para actualizar.' });
    }
    values.push(req.params.id, req.userId);
    const { rows } = await pool.query(
      `UPDATE invoices SET ${sets.join(', ')} WHERE id = $${i} AND contador_id = $${i + 1} RETURNING *`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada o no te pertenece.' });
    }
    res.json(rowToInvoice(rows[0]));
  } catch (err) {
    console.error('Error actualizando retención de factura:', err);
    res.status(500).json({ error: 'No se pudo actualizar la factura.' });
  }
});

// Ítems línea por línea de una factura (Fase 4) -- ownership por el
// contador_id guardado en cada ítem, no hace falta el join con invoices.
app.get('/api/invoices/:id/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM factura_items WHERE invoice_id = $1 AND contador_id = $2 ORDER BY orden ASC',
      [req.params.id, req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando ítems de factura:', err);
    res.status(500).json({ error: 'No se pudieron cargar los ítems de la factura.' });
  }
});

// ---------- Integraciones con software contable ----------

// Lista las integraciones conectadas de este contador -- NUNCA incluye
// el token, ni siquiera cifrado (no hay razón para que el navegador lo
// vea de vuelta).
app.get('/api/integraciones', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT proveedor, email, activo, conectado_at, ultima_sincronizacion FROM integraciones_contables WHERE contador_id = $1',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo integraciones:', err);
    res.status(500).json({ error: 'No se pudieron leer las integraciones.' });
  }
});

// Conecta (o reemplaza) las credenciales de un proveedor contable.
// Antes de guardar nada, se prueba la conexión de verdad contra la API
// del proveedor -- si el correo/token no sirven, no se guarda basura.
//
// Algunos proveedores (hoy, Siigo) además exigen que el contador elija
// de su PROPIA cuenta algo que Kárdex IA no puede adivinar (ej. qué
// tipo de comprobante y qué forma de pago usar). Si el adaptador
// declara `obtenerOpcionesConfiguracion` y todavía no llegó una
// `configuracion` válida en el body, esta ruta responde con las
// opciones reales de esa cuenta SIN guardar nada -- el frontend las
// muestra, el contador elige, y se vuelve a llamar esta misma ruta ya
// con `configuracion` incluida para guardar todo junto.
app.post('/api/integraciones/:proveedor/conectar', requireAuth, async (req, res) => {
  const { proveedor } = req.params;
  const adaptador = integraciones.PROVEEDORES[proveedor];
  if (!adaptador) {
    return res.status(400).json({ error: `"${proveedor}" no es un proveedor soportado todavía.` });
  }

  const { email, token, configuracion } = req.body;
  if (!email || !token) {
    return res.status(400).json({ error: 'Faltan el correo y/o el token de la cuenta.' });
  }

  try {
    await adaptador.probarConexion({ email, token });
  } catch (err) {
    console.error(`Error probando conexión con ${proveedor}:`, err.message);
    return res.status(err.status || 502).json({ error: err.publicMessage || `No se pudo conectar con ${adaptador.nombre}.` });
  }

  if (adaptador.obtenerOpcionesConfiguracion && !adaptador.validarConfiguracion(configuracion)) {
    try {
      const opciones = await adaptador.obtenerOpcionesConfiguracion({ email, token });
      return res.status(200).json({ requiereConfiguracion: true, opciones });
    } catch (err) {
      console.error(`Error leyendo catálogos de ${proveedor}:`, err.message);
      return res.status(err.status || 502).json({ error: err.publicMessage || `No se pudieron leer las opciones de configuración de ${adaptador.nombre}.` });
    }
  }

  try {
    const tokenCifrado = integraciones.cifrar(token);
    const configuracionTexto = JSON.stringify(configuracion || {});
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO integraciones_contables (id, contador_id, proveedor, email, token_cifrado, activo, conectado_at, configuracion)
       VALUES ($1, $2, $3, $4, $5, true, now(), $6)
       ON CONFLICT (contador_id, proveedor)
       DO UPDATE SET email = $4, token_cifrado = $5, activo = true, conectado_at = now(), configuracion = $6
       RETURNING proveedor, email, activo, conectado_at`,
      [id, req.userId, proveedor, email, tokenCifrado, configuracionTexto]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(`Error guardando integración con ${proveedor}:`, err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.publicMessage || 'No se pudo guardar la conexión.' });
  }
});

// Desconecta un proveedor -- borra el token guardado, no solo lo marca
// inactivo, para no dejar una credencial sin uso dando vueltas.
app.delete('/api/integraciones/:proveedor', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM integraciones_contables WHERE contador_id = $1 AND proveedor = $2',
      [req.userId, req.params.proveedor]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'No tenías esa integración conectada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error desconectando integración:', err.message);
    res.status(500).json({ error: 'No se pudo desconectar.' });
  }
});

// Envía una factura YA guardada en Kárdex IA hacia el software contable
// conectado (por ahora, Alegra) como factura de proveedor. El contador
// decide cuándo mandarla -- nunca es automático al guardar, para que
// siempre haya una revisión humana antes de tocar su contabilidad real.
app.post('/api/invoices/:id/enviar/:proveedor', requireAuth, async (req, res) => {
  const { id, proveedor } = req.params;
  const adaptador = integraciones.PROVEEDORES[proveedor];
  if (!adaptador) {
    return res.status(400).json({ error: `"${proveedor}" no es un proveedor soportado todavía.` });
  }
  const columnas = COLUMNAS_ENVIO_PROVEEDOR[proveedor];
  if (!columnas) {
    // No debería pasar (todo proveedor en PROVEEDORES tiene sus 2
    // columnas arriba) -- pero si alguien agrega un proveedor nuevo sin
    // agregar sus columnas, es mejor un 400 claro que un SQL roto.
    return res.status(500).json({ error: `Falta configurar las columnas de envío para "${proveedor}" en el servidor.` });
  }

  try {
    const facturaRes = await pool.query('SELECT * FROM invoices WHERE id = $1 AND contador_id = $2', [id, req.userId]);
    if (facturaRes.rows.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada.' });
    }
    const factura = facturaRes.rows[0];

    const integracionRes = await pool.query(
      'SELECT email, token_cifrado, configuracion FROM integraciones_contables WHERE contador_id = $1 AND proveedor = $2 AND activo = true',
      [req.userId, proveedor]
    );
    if (integracionRes.rows.length === 0) {
      return res.status(400).json({ error: `No tienes ${adaptador.nombre} conectado. Ve a Integraciones para conectarlo primero.` });
    }

    const cred = {
      email: integracionRes.rows[0].email,
      token: integraciones.descifrar(integracionRes.rows[0].token_cifrado),
    };
    let configuracion = {};
    try { configuracion = JSON.parse(integracionRes.rows[0].configuracion || '{}'); } catch (e) { configuracion = {}; }

    const resultado = await adaptador.enviarFactura(cred, factura, configuracion);

    await pool.query(
      `UPDATE invoices SET ${columnas.billId} = $1, ${columnas.enviadaAt} = now() WHERE id = $2`,
      [resultado.billId || '', id]
    );
    await pool.query(
      'UPDATE integraciones_contables SET ultima_sincronizacion = now() WHERE contador_id = $1 AND proveedor = $2',
      [req.userId, proveedor]
    );

    res.json({ ok: true, billId: resultado.billId, avisos: resultado.avisos || [] });
  } catch (err) {
    console.error(`Error enviando factura a ${proveedor}:`, err.message);
    res.status(err.status || 500).json({ error: err.publicMessage || `No se pudo enviar la factura a ${adaptador.nombre}.` });
  }
});

// Modelo gratuito de Gemini. Si en el futuro Google lo retira, cambia este valor
// por el modelo Flash vigente (revisa https://ai.google.dev/gemini-api/docs/models).
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Llama a Gemini con un archivo (imagen o PDF) + un prompt de texto, y
// devuelve el JSON ya parseado. Centraliza la llamada HTTP y la limpieza
// de la respuesta (Gemini a veces envuelve el JSON en ```json ... ```)
// para que /api/extract y /api/extract-rut no dupliquen esta lógica.
// Si algo falla, lanza un error con `.status` (código HTTP a devolver
// al navegador) y `.publicMessage` (texto seguro para mostrarle al contador).
async function llamarGeminiJSON(base64, effectiveMediaType, prompt) {
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
    const err = new Error(detail);
    err.status = response.status;
    err.publicMessage = `Error de la API de Gemini (${response.status}): ${detail}`;
    throw err;
  }

  const data = await response.json();
  const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textOut) {
    const err = new Error('Gemini no devolvió texto.');
    err.status = 500;
    err.publicMessage = 'No se recibió una respuesta de texto de la API.';
    throw err;
  }

  let clean = textOut.trim();
  clean = clean.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(clean);
  } catch (parseErr) {
    const err = new Error('No se pudo parsear como JSON: ' + clean.slice(0, 300));
    err.status = 500;
    err.publicMessage = 'No se pudo interpretar la respuesta de la IA. Intenta con una imagen más clara.';
    throw err;
  }
}

const INVOICE_PROMPT = `Eres un asistente contable colombiano. Antes de extraer ningún dato, tu PRIMERA tarea es identificar qué tipo de documento es la imagen o archivo que recibiste, porque Kárdex IA SOLO debe procesar los dos únicos documentos que se pueden causar contablemente en Colombia: la factura de venta y la cuenta de cobro. Cualquier otro tipo de documento debe rechazarse, aunque tenga valores y NIT parecidos a una factura.

CÓMO IDENTIFICAR CADA TIPO (usa estas señales, no solo el título del documento):

FACTURA DE VENTA (electrónica o física) -- tipo_documento = "factura_venta":
- Dice explícitamente "Factura de Venta", "Factura Electrónica de Venta" o "Invoice".
- Trae CUFE (Código Único de Facturación Electrónica) o un código QR de validación de la DIAN.
- Trae número de resolución de facturación autorizada por la DIAN y/o un consecutivo con prefijo (ej: FE-1234, SETP990).
- Identifica con NIT o cédula tanto al vendedor/emisor como al comprador/adquiriente.
- Discrimina subtotal, IVA (si aplica) y valor total.

CUENTA DE COBRO -- tipo_documento = "cuenta_cobro":
- Dice explícitamente "Cuenta de Cobro".
- La emite típicamente una persona natural NO obligada a facturar (independientes, honorarios, servicios ocasionales) -- NO tiene CUFE, código QR de la DIAN, ni resolución de facturación.
- Trae: fecha, nombre y NIT/cédula de quien cobra, nombre y NIT/cédula (o razón social) de quien debe pagar, una descripción del servicio o concepto, y el valor total a pagar.
- A menudo incluye la frase "no obligado(a) a facturar" (o similar) y un espacio de firma.

CUALQUIER OTRO DOCUMENTO -- tipo_documento = "otro" (SIEMPRE rechazar, documento_valido debe ser false), por ejemplo:
- Comprobantes o recibos de pago, soportes o confirmaciones de transferencia bancaria, extractos bancarios.
- Cotizaciones, proformas, órdenes de compra o remisiones sin valor fiscal.
- Contratos, recibos de consignación, tickets no fiscales, reportes o resúmenes de pagos.
- Capturas de pantalla de apps de pago, comprobantes de Nequi/Daviplata/PSE, o cualquier documento que no sea ni una factura de venta ni una cuenta de cobro.

Si tienes dudas genuinas entre factura de venta y cuenta de cobro, elige la que mejor encaje y sigue adelante -- el rechazo (tipo_documento = "otro") es solo para documentos que claramente NO son ninguno de los dos.

Una vez identificado el tipo, extrae EXACTAMENTE estos campos, devolviendo SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

{
  "tipo_documento": "'factura_venta' si es una factura de venta (electrónica o física), 'cuenta_cobro' si es una cuenta de cobro, 'otro' para cualquier otro documento (comprobantes de pago, extractos, cotizaciones, contratos, etc.) -- ver criterios arriba",
  "documento_valido": "true SOLO si tipo_documento es 'factura_venta' o 'cuenta_cobro'. false para 'otro'",
  "motivo_rechazo": "si documento_valido es false, una frase breve en español explicando qué parece ser el documento en su lugar (ej: 'Este documento parece ser un comprobante de transferencia bancaria, no una factura ni una cuenta de cobro'). Si documento_valido es true, cadena vacía",
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
  "regimen_simple": "true si el documento menciona explícitamente que el emisor pertenece al 'Régimen Simple de Tributación' o dice algo como 'no practique ninguna retención' (suele aparecer en la sección de notas/detalles). false en cualquier otro caso, incluido cuando no estés seguro",
  "categoria_concepto": "clasifica el concepto de la factura en UNA de estas categorías oficiales de retención en la fuente de la DIAN (usa exactamente uno de estos valores, en minúsculas): 'compras' (bienes/productos físicos generales, ej. útiles, insumos, mercancía), 'compras_tarjeta' (SOLO si el documento indica explícitamente que se pagó con tarjeta débito o crédito), 'servicios' (mano de obra operativa sin título profesional, ej. limpieza general, mantenimiento), 'honorarios_juridica' (servicio profesional facturado por una persona jurídica/empresa, ej. una firma de asesoría), 'honorarios_natural' (servicio profesional facturado por una persona natural con título, ej. un contador o abogado independiente), 'arrendamiento_muebles' (alquiler de equipos, vehículos, maquinaria), 'arrendamiento_inmuebles' (alquiler de local, oficina o bodega), 'transporte_carga' (transporte de mercancía/carga), 'transporte_pasajeros' (transporte terrestre de personas), 'licenciamiento_software' (licencias o derecho de uso de software), 'vigilancia_aseo' (servicios de vigilancia o aseo prestados por una empresa especializada), 'hoteles_restaurantes' (alojamiento o alimentación), 'otro' (si no encaja claramente en ninguna). Elige la que mejor describa la naturaleza real de lo facturado, no solo el nombre del producto.",
  "desglose_categorias": "IMPORTANTE: revisa la tabla de ítems de la factura línea por línea. Si TODOS los ítems son de la misma naturaleza (ej. todos productos, o todo un solo servicio), deja este campo como un objeto vacío {}. Si la factura mezcla ítems de naturaleza distinta (ej. productos Y mano de obra/servicio en la misma factura, como suele pasar en talleres, ferreterías o mantenimiento), agrupa el subtotal (sin IVA) de cada ítem según su categoría real (usa las mismas categorías del campo categoria_concepto) y devuelve un objeto JSON con cada categoría encontrada y la suma de sus ítems, ej: {\"compras\": 442000, \"servicios\": 140000}. La suma de todos los valores del objeto debe ser igual al subtotal total de la factura (valor_sin_iva). Nunca inventes una categoría que no tenga ítems reales detrás.",
  "items": "El desglose línea por línea COMPLETO de la factura -- un arreglo con CADA ítem real que aparece en la tabla de productos/servicios del documento, sin resumir ni agrupar. Cada elemento del arreglo debe tener esta forma: {\"descripcion\": \"texto breve del ítem tal como aparece\", \"cantidad\": cantidad si aparece (número), o cadena vacía si no aparece, \"valor_unitario\": valor unitario en pesos ENTEROS si aparece, o 0 si no aparece, \"subtotal\": subtotal de ESA línea SIN IVA, en pesos ENTEROS (regla de formato de más abajo), \"categoria_concepto\": clasifica ESTE ítem puntual en UNA de las mismas categorías oficiales de retención listadas en el campo categoria_concepto de arriba (usa exactamente uno de esos valores, en minúsculas), según la naturaleza real de ESE ítem, no de la factura completa}. La suma de todos los \"subtotal\" del arreglo debe ser igual (o muy cercana, por redondeo) al valor_sin_iva total de la factura. Si el documento NO trae una tabla de ítems detallada (ej. una cuenta de cobro con un solo concepto global, sin líneas separadas), devuelve un arreglo con UN SOLO elemento que represente el total de la factura, usando el mismo concepto y la misma categoria_concepto que ya extrajiste arriba. Nunca inventes ítems que no estén realmente en el documento."
}

REGLA DE FORMATO PARA LOS CAMPOS DE VALOR (los 3 de arriba, y también valor_unitario/subtotal de cada ítem del arreglo "items" -- muy importante, es el error más común):
Los documentos colombianos escriben los montos con PUNTO como separador de miles y COMA para los centavos (ej: "39.915,96" significa treinta y nueve mil novecientos quince pesos con noventa y seis centavos). Debes devolver el valor como un ENTERO en pesos, redondeando los centavos, SIN puntos, SIN comas, SIN concatenar los dígitos tal cual aparecen escritos.

Ejemplo correcto: si el documento muestra "39.915,96", el JSON debe llevar 39916 (no 3991596, no 39915.96, no 39915).
Ejemplo correcto: si el documento muestra "210.084,00", el JSON debe llevar 210084.
Ejemplo correcto: si el documento muestra "1.487.500", el JSON debe llevar 1487500.

Muchas facturas electrónicas colombianas incluyen una sección "Retenciones" o "Valores informativos" con Rete fuente, Rete IVA y Rete ICA (casi siempre en 0 si no aplica) — revisa si el documento la tiene antes de responder.

Si algún campo no se puede determinar con certeza, usa una cadena vacía "" para ese campo (excepto valor_iva, rete_fuente, rete_iva y rete_ica, que en ese caso van en 0). No inventes datos. Verifica que valor_sin_iva + valor_iva sea igual (o muy cercano, por redondeo de centavos) a valor_con_iva antes de responder.

Si documento_valido es false (el documento no es factura de venta ni cuenta de cobro), igual completa nombre_razon_social y concepto con lo que alcances a leer si es evidente (ayuda a que el contador entienda qué era el archivo), pero deja los campos de valores en 0 y el resto en cadena vacía -- no hace falta forzar una lectura completa de un documento que de todos modos se va a rechazar.`;

// Endpoint que recibe el archivo (imagen o PDF) de una factura y llama a la API gratuita de Gemini
app.post('/api/extract', requireAuth, async (req, res) => {
  const { base64, mediaType, isPdf, forzar } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;
  const fileHash = calcularFileHash(base64);

  // Antes de gastar una lectura de IA, revisamos si este mismo archivo
  // (mismos bytes exactos) ya se leyó y se guardó antes para este
  // contador. Si es así, no se vuelve a mandar a Gemini -- se avisa de
  // una vez con los datos de la factura ya guardada. "forzar" permite
  // saltarse este aviso si el contador de verdad quiere volver a leerlo
  // (ej. sospecha que el duplicado es un falso positivo).
  if (!forzar) {
    try {
      const existente = await buscarFacturaPorHash(req.userId, fileHash);
      if (existente) {
        return res.json({ duplicado: true, file_hash: fileHash, factura_existente: existente });
      }
    } catch (err) {
      console.error('No se pudo revisar duplicados antes de leer con IA:', err.message);
      // Si falla la búsqueda, seguimos con la lectura normal -- mejor
      // gastar una lectura de más que bloquear el flujo por esto.
    }
  }

  try {
    const parsed = await llamarGeminiJSON(base64, effectiveMediaType, INVOICE_PROMPT);
    parsed.file_hash = fileHash;

    // Kárdex IA solo causa dos tipos de documento: factura de venta y
    // cuenta de cobro -- son los únicos con validez legal para registrar
    // un ingreso o egreso. Si la IA determinó que el archivo es otra cosa
    // (comprobante de pago, extracto bancario, cotización, contrato...),
    // se rechaza aquí antes de guardarlo o mostrarlo como si fuera una
    // factura válida. Aplica igual para Escanear (uno por uno) y Carga
    // masiva (por archivo), porque ambos pasan por este mismo endpoint.
    if (parsed.documento_valido === false || (parsed.tipo_documento && parsed.tipo_documento !== 'factura_venta' && parsed.tipo_documento !== 'cuenta_cobro')) {
      const err = new Error('Documento rechazado -- no es factura ni cuenta de cobro (tipo detectado: ' + (parsed.tipo_documento || 'desconocido') + ').');
      err.status = 422;
      const motivo = parsed.motivo_rechazo ? ` ${parsed.motivo_rechazo}.` : '';
      err.publicMessage = `Este archivo no parece ser una factura de venta ni una cuenta de cobro.${motivo} Kárdex IA solo procesa esos dos tipos de documento, que son los únicos con validez legal para causar un ingreso o egreso.`;
      throw err;
    }

    // Capa de seguridad extra: si la IA devolvió centavos (ej. 39915.96) en
    // vez del entero pedido, se redondea aquí antes de mostrarlo/guardarlo.
    for (const key of ['valor_sin_iva', 'valor_iva', 'valor_con_iva', 'rete_fuente', 'rete_iva', 'rete_ica']) {
      if (parsed[key] !== undefined && parsed[key] !== '' && !isNaN(Number(parsed[key]))) {
        parsed[key] = Math.round(Number(parsed[key]));
      }
    }

    // Antes de mostrarle el resultado al contador, revisamos si él
    // mismo ya corrigió antes una categoría para un concepto parecido
    // -- si es así, la aplicamos solos, sin que tenga que corregirla
    // otra vez. Guardamos la sugerencia original de la IA para poder
    // comparar después si el contador la cambia de nuevo.
    parsed.categoria_concepto_ia = parsed.categoria_concepto || '';
    try {
      const corregida = await buscarCorreccionAprendida(req.userId, parsed.concepto);
      if (corregida && corregida !== parsed.categoria_concepto) {
        parsed.categoria_concepto = corregida;
        parsed.categoria_ajustada_por_ti = true;
      }
    } catch (err) {
      console.error('No se pudo revisar correcciones aprendidas:', err.message);
      // Si falla, seguimos con la categoría que dio la IA -- no bloquea el flujo.
    }

    res.json(parsed);

  } catch (err) {
    console.error('Error al llamar a Gemini (factura):', err);
    res.status(err.status || 500).json({ error: err.publicMessage || 'Error de conexión con la API de Gemini.' });
  }
});

// ---------- Lectura del RUT con IA ----------

// Solo estos códigos de responsabilidad tributaria tienen un checkbox en
// la pantalla de Clientes -- cualquier otro código que la IA encuentre
// en el RUT se descarta, porque no hay dónde marcarlo en el formulario.
const RESPONSABILIDADES_SOPORTADAS = new Set(['05', '07', '48', '14', '47', '55']);

const RUT_PROMPT = `Eres un asistente contable colombiano. Analiza este documento, que es un RUT (Registro Único Tributario) emitido por la DIAN, y extrae EXACTAMENTE estos campos, devolviendo SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

{
  "tipo_persona": "'natural' si la Casilla 4 marca 'Persona Natural', 'juridica' si marca 'Persona Jurídica'. Si no es claro, cadena vacía.",
  "nombre": "Si es persona jurídica: la Razón Social completa (Casilla 12). Si es persona natural: primer apellido + segundo apellido + primer nombre + otros nombres (Casillas 31-35), en el orden 'Nombres Apellidos'. Cadena vacía si no se encuentra con certeza.",
  "nit": "El Número de Identificación Tributaria (Casilla 5), solo dígitos, SIN el dígito de verificación.",
  "dv": "El Dígito de Verificación (Casilla 6), un solo dígito. Cadena vacía si no aparece.",
  "direccion": "La dirección principal registrada (sección de ubicación / dirección seccional), cadena vacía si no aparece con claridad.",
  "ciudad": "El municipio o ciudad de esa dirección principal, cadena vacía si no aparece.",
  "telefono": "El teléfono principal o 'Teléfono 1' si aparece, solo dígitos, cadena vacía si no aparece.",
  "correo": "El correo electrónico si aparece en el documento, cadena vacía si no aparece.",
  "ciiu": "El código CIIU de la Actividad Económica Principal (Casilla 46), solo el número (ej: 6201), cadena vacía si no aparece.",
  "responsabilidades": "Revisa la sección 'Responsabilidades, Calidades y Atributos' (Casilla 53). De TODOS los códigos marcados ahí, reporta ÚNICAMENTE los que coincidan con esta lista cerrada -- 05 (Renta régimen ordinario), 07 (Agente retenedor renta), 48 (Impuesto sobre las ventas - IVA), 14 (Informante de exógena), 47 (Régimen Simple de Tributación - RST), 55 (Beneficiarios finales). Devuelve los que encuentres de esta lista separados por coma, ej: '05,07,48'. Si el documento no marca ninguno de estos códigos específicos, cadena vacía. Ignora cualquier otro código que no esté en esta lista."
}

Este documento varía de formato según el año en que se generó, pero la numeración de casillas del RUT es estándar -- básate en las etiquetas de cada sección más que en la posición exacta.

No inventes datos que no estén en el documento. Si algún campo no se puede leer con certeza, usa una cadena vacía "" para ese campo -- es preferible dejarlo vacío para que el contador lo complete a mano, que adivinar.`;

// Endpoint que recibe el RUT (imagen o PDF) y usa la IA para pre-llenar
// el formulario de "Agregar cliente" -- el contador siempre revisa y
// completa lo que falte antes de guardar, esto solo ahorra tecleo.
app.post('/api/extract-rut', requireAuth, async (req, res) => {
  const { base64, mediaType, isPdf } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;

  try {
    const parsed = await llamarGeminiJSON(base64, effectiveMediaType, RUT_PROMPT);

    if (parsed.tipo_persona !== 'natural' && parsed.tipo_persona !== 'juridica') {
      parsed.tipo_persona = '';
    }

    const codigos = String(parsed.responsabilidades || '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => RESPONSABILIDADES_SOPORTADAS.has(c));
    parsed.responsabilidades = codigos.join(',');

    res.json(parsed);
  } catch (err) {
    console.error('Error al llamar a Gemini (RUT):', err);
    res.status(err.status || 500).json({ error: err.publicMessage || 'Error de conexión con la API de Gemini.' });
  }
});

// ---------- Cartera / conciliación bancaria ----------

async function clienteEsDelContador(contadorId, clienteId) {
  const { rows } = await pool.query('SELECT 1 FROM clients WHERE id = $1 AND contador_id = $2', [clienteId, contadorId]);
  return rows.length > 0;
}

// Trae todas las facturas de un cliente con su saldo pendiente ya
// calculado (valor_con_iva menos la suma de los movimientos ya
// conciliados contra ella) -- una factura con saldo 0 ya quedó
// totalmente pagada, y no vuelve a aparecer como pendiente.
async function facturasConSaldo(contadorId, clienteId) {
  const { rows: facturas } = await pool.query(
    `SELECT id, nit_cc, adquiriente_nit, nombre_razon_social, adquiriente_nombre,
            fecha_factura, tipo_movimiento, valor_con_iva, letras_fe, numeros_fe, concepto
     FROM invoices WHERE contador_id = $1 AND cliente_id = $2`,
    [contadorId, clienteId]
  );
  const { rows: pagos } = await pool.query(
    `SELECT invoice_id, COALESCE(SUM(NULLIF(valor,'')::numeric),0) AS pagado
     FROM movimientos_banco
     WHERE contador_id = $1 AND cliente_id = $2 AND estado = 'conciliado' AND invoice_id IS NOT NULL
     GROUP BY invoice_id`,
    [contadorId, clienteId]
  );
  const pagadoPorFactura = {};
  pagos.forEach((p) => { pagadoPorFactura[p.invoice_id] = Number(p.pagado); });
  return facturas.map((f) => {
    const total = Number(f.valor_con_iva) || 0;
    const pagado = pagadoPorFactura[f.id] || 0;
    return { ...f, saldo_pendiente: Math.max(0, total - pagado), pagado };
  });
}

// Estado de cuenta completo de un cliente: facturas pendientes (por
// cobrar y por pagar, con antigüedad), movimientos del banco sin
// conciliar (con la sugerencia de cruce ya calculada), y los ya
// conciliados/ignorados. Todo se calcula al vuelo -- no se guarda
// ninguna sugerencia en la base de datos, así siempre refleja el estado
// real de las facturas en este momento.
app.get('/api/cartera/:clienteId', requireAuth, async (req, res) => {
  try {
    const clienteId = req.params.clienteId;
    if (!(await clienteEsDelContador(req.userId, clienteId))) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    const facturas = await facturasConSaldo(req.userId, clienteId);
    const facturasPendientes = facturas.filter((f) => f.saldo_pendiente > 0);

    const { rows: movimientos } = await pool.query(
      `SELECT * FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 ORDER BY fecha DESC, created_at DESC`,
      [req.userId, clienteId]
    );

    const hoy = Date.now();
    const conAging = (f) => {
      const [d, m, y] = String(f.fecha_factura || '').split('/');
      let dias = null;
      if (d && m && y) {
        const t = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
        if (!isNaN(t)) dias = Math.floor((hoy - t) / 86400000);
      }
      return { ...f, dias_transcurridos: dias };
    };

    const sinConciliar = movimientos
      .filter((m) => m.estado === 'sin_conciliar')
      .map((m) => {
        const movimiento = { fecha: m.fecha, descripcion: m.descripcion, valor: Number(m.valor), tipo: m.tipo };
        const sugerencia = cartera.emparejarMovimiento(movimiento, facturasPendientes);
        return { ...m, valor: Number(m.valor), sugerencia };
      });

    const conciliados = movimientos.filter((m) => m.estado === 'conciliado').map((m) => ({ ...m, valor: Number(m.valor) }));
    const ignorados = movimientos.filter((m) => m.estado === 'ignorado').map((m) => ({ ...m, valor: Number(m.valor) }));

    const porCobrar = facturasPendientes.filter((f) => f.tipo_movimiento === 'ingreso').map(conAging);
    const porPagar = facturasPendientes.filter((f) => f.tipo_movimiento === 'egreso').map(conAging);

    const bucket = (dias) => {
      if (dias === null) return 'sin_fecha';
      if (dias <= 30) return 'dias_0_30';
      if (dias <= 60) return 'dias_31_60';
      if (dias <= 90) return 'dias_61_90';
      return 'dias_90_mas';
    };
    const resumenAging = (lista) => {
      const r = { dias_0_30: 0, dias_31_60: 0, dias_61_90: 0, dias_90_mas: 0, sin_fecha: 0 };
      lista.forEach((f) => { r[bucket(f.dias_transcurridos)] += f.saldo_pendiente; });
      return r;
    };

    res.json({
      porCobrar,
      porPagar,
      movimientosSinConciliar: sinConciliar,
      movimientosConciliados: conciliados,
      movimientosIgnorados: ignorados,
      resumen: {
        totalPorCobrar: porCobrar.reduce((s, f) => s + f.saldo_pendiente, 0),
        totalPorPagar: porPagar.reduce((s, f) => s + f.saldo_pendiente, 0),
        agingPorCobrar: resumenAging(porCobrar),
        agingPorPagar: resumenAging(porPagar),
        sinConciliarCount: sinConciliar.length,
      },
    });
  } catch (err) {
    console.error('Error leyendo cartera:', err);
    res.status(500).json({ error: 'No se pudo cargar la cartera de este cliente.' });
  }
});

// Extrae los movimientos de un extracto en PDF con la misma IA que lee
// facturas. Antes de gastar una lectura, revisa si este mismo archivo
// (mismos bytes) ya se procesó antes para este cliente -- evita subir
// el mismo extracto dos veces sin darse cuenta.
app.post('/api/extracto/leer-pdf', requireAuth, async (req, res) => {
  const { base64, mediaType, isPdf, clienteId, forzar } = req.body;
  if (!base64 || !mediaType || !clienteId) {
    return res.status(400).json({ error: 'Faltan datos del archivo o del cliente.' });
  }
  if (!(await clienteEsDelContador(req.userId, clienteId))) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;
  const fileHash = calcularFileHash(base64);

  if (!forzar) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 AND file_hash = $3 LIMIT 1`,
        [req.userId, clienteId, fileHash]
      );
      if (rows.length > 0) return res.json({ duplicado: true, file_hash: fileHash });
    } catch (err) {
      console.error('No se pudo revisar duplicados de extracto:', err.message);
    }
  }

  try {
    const parsed = await llamarGeminiJSON(base64, effectiveMediaType, cartera.EXTRACTO_PROMPT);
    const movimientos = Array.isArray(parsed) ? parsed : [];
    movimientos.forEach((m) => {
      if (m && m.valor !== undefined && !isNaN(Number(m.valor))) m.valor = Math.round(Number(m.valor));
      if (m && m.tipo !== 'credito' && m.tipo !== 'debito') m.tipo = 'debito';
    });
    res.json({ movimientos, file_hash: fileHash });
  } catch (err) {
    console.error('Error al llamar a Gemini (extracto):', err);
    res.status(err.status || 500).json({ error: err.publicMessage || 'Error de conexión con la API de Gemini.' });
  }
});

// Lee un extracto en CSV -- sin IA, con un parser propio (ver cartera.js).
app.post('/api/extracto/leer-csv', requireAuth, async (req, res) => {
  const { csvTexto, clienteId, forzar } = req.body;
  if (!csvTexto || !clienteId) {
    return res.status(400).json({ error: 'Faltan datos del archivo o del cliente.' });
  }
  if (!(await clienteEsDelContador(req.userId, clienteId))) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const fileHash = calcularFileHash(csvTexto);

  if (!forzar) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 AND file_hash = $3 LIMIT 1`,
        [req.userId, clienteId, fileHash]
      );
      if (rows.length > 0) return res.json({ duplicado: true, file_hash: fileHash });
    } catch (err) {
      console.error('No se pudo revisar duplicados de extracto:', err.message);
    }
  }

  try {
    const movimientos = cartera.parseCSVExtracto(csvTexto);
    res.json({ movimientos, file_hash: fileHash });
  } catch (err) {
    console.error('Error leyendo CSV de extracto:', err.message);
    res.status(err.status || 400).json({ error: err.publicMessage || 'No se pudo leer el archivo CSV.' });
  }
});

// Guarda los movimientos ya revisados por el contador (después de leer
// el PDF o el CSV). Todavía no marca ningún cruce -- eso pasa cuando el
// contador confirma cada uno, uno por uno, desde el estado de cuenta.
app.post('/api/extracto/guardar', requireAuth, async (req, res) => {
  try {
    const { clienteId, movimientos, file_hash, mes } = req.body;
    if (!clienteId || !Array.isArray(movimientos) || movimientos.length === 0) {
      return res.status(400).json({ error: 'Faltan movimientos para guardar.' });
    }
    // El mes contable lo elige el contador antes de subir el extracto (no
    // se calcula solo) -- ver comentario en ensureSchema. Sin esto, la
    // pantalla de Cartera no podría filtrar mes a mes como el resto de la
    // app (Facturas/Ingresos/Egresos), que es como un contador la revisa.
    if (!/^\d{4}-\d{2}$/.test(mes || '')) {
      return res.status(400).json({ error: 'Falta indicar a qué mes contable corresponde este extracto.' });
    }
    if (!(await clienteEsDelContador(req.userId, clienteId))) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    const extractoId = crypto.randomUUID();
    let guardados = 0;
    for (const m of movimientos) {
      const valor = Math.round(Number(m.valor));
      if (!valor || (m.tipo !== 'credito' && m.tipo !== 'debito')) continue;
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO movimientos_banco (id, contador_id, cliente_id, extracto_id, fecha, descripcion, valor, tipo, estado, file_hash, mes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sin_conciliar',$9,$10)`,
        [id, req.userId, clienteId, extractoId, String(m.fecha || ''), String(m.descripcion || ''), String(valor), m.tipo, file_hash || '', mes]
      );
      guardados++;
    }
    res.json({ ok: true, guardados, extracto_id: extractoId });
  } catch (err) {
    console.error('Error guardando movimientos del extracto:', err);
    res.status(500).json({ error: 'No se pudieron guardar los movimientos del extracto.' });
  }
});

// El contador confirma que un movimiento del banco corresponde a una
// factura específica -- es la única forma en que un movimiento pasa a
// 'conciliado'. Nunca ocurre solo, ni siquiera cuando la sugerencia es
// de confianza "alta".
app.post('/api/movimientos/:id/confirmar', requireAuth, async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'Falta indicar a qué factura corresponde.' });

    const { rows: movRows } = await pool.query(
      'SELECT * FROM movimientos_banco WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.userId]
    );
    if (movRows.length === 0) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const mov = movRows[0];

    const { rows: facRows } = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND contador_id = $2 AND cliente_id = $3',
      [invoiceId, req.userId, mov.cliente_id]
    );
    if (facRows.length === 0) return res.status(404).json({ error: 'La factura indicada no existe o no es de este cliente.' });
    const factura = facRows[0];

    const tipoEsperado = mov.tipo === 'credito' ? 'ingreso' : 'egreso';
    if (factura.tipo_movimiento !== tipoEsperado) {
      return res.status(400).json({
        error: `Este movimiento es un ${mov.tipo === 'credito' ? 'abono' : 'cargo'}, pero la factura elegida es de ${factura.tipo_movimiento}. No coinciden.`,
      });
    }

    await pool.query(`UPDATE movimientos_banco SET estado = 'conciliado', invoice_id = $1 WHERE id = $2`, [invoiceId, mov.id]);

    // Aviso informativo (no bloquea el guardado): si con este movimiento
    // la factura queda sobrepagada, se lo hacemos saber por si el cruce
    // en realidad era el equivocado.
    const { rows: pagos } = await pool.query(
      `SELECT COALESCE(SUM(NULLIF(valor,'')::numeric),0) AS pagado FROM movimientos_banco WHERE invoice_id = $1 AND estado = 'conciliado'`,
      [invoiceId]
    );
    const totalPagado = Number(pagos[0].pagado);
    const totalFactura = Number(factura.valor_con_iva) || 0;
    const sobrepago = totalPagado > totalFactura + 500;

    res.json({ ok: true, sobrepago, totalPagado, totalFactura });
  } catch (err) {
    console.error('Error confirmando movimiento:', err);
    res.status(500).json({ error: 'No se pudo confirmar el cruce.' });
  }
});

// Marca un movimiento como que NO corresponde a ninguna factura
// (comisiones bancarias, traslados entre cuentas propias, etc.) -- deja
// de aparecer como pendiente de revisar.
app.post('/api/movimientos/:id/ignorar', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE movimientos_banco SET estado = 'ignorado', invoice_id = NULL WHERE id = $1 AND contador_id = $2`,
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error ignorando movimiento:', err);
    res.status(500).json({ error: 'No se pudo ignorar el movimiento.' });
  }
});

// Deshace una conciliación o un "ignorado" -- el movimiento vuelve a
// quedar sin conciliar, por si el contador confirmó (o ignoró) algo por
// error.
app.post('/api/movimientos/:id/desconciliar', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE movimientos_banco SET estado = 'sin_conciliar', invoice_id = NULL WHERE id = $1 AND contador_id = $2`,
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deshaciendo la conciliación:', err);
    res.status(500).json({ error: 'No se pudo deshacer.' });
  }
});

// ---------- Plantillas de exportación ----------
// El archivo real (.xlsx) se arma en el navegador con ExcelJS -- estos
// endpoints solo guardan y devuelven la CONFIGURACIÓN de columnas que el
// contador armó, para que la pueda reusar cada mes sin rehacerla.

function validarColumnasPlantilla(columnas) {
  return Array.isArray(columnas) && columnas.length > 0 && columnas.every(
    (c) => c && typeof c.campo === 'string' && typeof c.encabezado === 'string'
  );
}

app.get('/api/plantillas-exportacion', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nombre, columnas, created_at, updated_at FROM plantillas_exportacion WHERE contador_id = $1 ORDER BY nombre ASC',
      [req.userId]
    );
    res.json(rows.map((r) => ({ ...r, columnas: JSON.parse(r.columnas || '[]') })));
  } catch (err) {
    console.error('Error leyendo plantillas de exportación:', err);
    res.status(500).json({ error: 'No se pudieron cargar las plantillas.' });
  }
});

app.post('/api/plantillas-exportacion', requireAuth, async (req, res) => {
  try {
    const { nombre, columnas } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre de la plantilla.' });
    if (!validarColumnasPlantilla(columnas)) return res.status(400).json({ error: 'La plantilla necesita al menos una columna válida.' });

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO plantillas_exportacion (id, contador_id, nombre, columnas)
       VALUES ($1,$2,$3,$4) RETURNING id, nombre, columnas, created_at, updated_at`,
      [id, req.userId, nombre.trim(), JSON.stringify(columnas)]
    );
    res.json({ ...rows[0], columnas: JSON.parse(rows[0].columnas) });
  } catch (err) {
    console.error('Error creando plantilla de exportación:', err);
    res.status(500).json({ error: 'No se pudo guardar la plantilla.' });
  }
});

app.put('/api/plantillas-exportacion/:id', requireAuth, async (req, res) => {
  try {
    const { nombre, columnas } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre de la plantilla.' });
    if (!validarColumnasPlantilla(columnas)) return res.status(400).json({ error: 'La plantilla necesita al menos una columna válida.' });

    const { rows } = await pool.query(
      `UPDATE plantillas_exportacion SET nombre = $1, columnas = $2, updated_at = now()
       WHERE id = $3 AND contador_id = $4
       RETURNING id, nombre, columnas, created_at, updated_at`,
      [nombre.trim(), JSON.stringify(columnas), req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Plantilla no encontrada.' });
    res.json({ ...rows[0], columnas: JSON.parse(rows[0].columnas) });
  } catch (err) {
    console.error('Error actualizando plantilla de exportación:', err);
    res.status(500).json({ error: 'No se pudo actualizar la plantilla.' });
  }
});

app.delete('/api/plantillas-exportacion/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM plantillas_exportacion WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Plantilla no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando plantilla de exportación:', err);
    res.status(500).json({ error: 'No se pudo eliminar la plantilla.' });
  }
});

// ---------- Perfil fiscal del tercero (por NIT) ----------
// Ver comentario junto a la tabla en ensureSchema(). El contador marca
// esto UNA vez por NIT y de ahí en adelante manda sobre lo que la IA
// lea en cada factura puntual de ese mismo NIT.
function normalizarNit(nit) {
  let s = String(nit || '').trim();
  // Si viene con el dígito de verificación pegado al final con guion
  // (ej. "901.128.185-3", formato común al copiar del RUT), se quita
  // antes de limpiar el resto -- si no, el DV se cuela como si fuera
  // parte del NIT y el mismo tercero termina con dos perfiles
  // distintos (uno con DV, uno sin DV) que nunca se cruzan entre sí.
  s = s.replace(/-\s*\d$/, '');
  return s.replace(/[^0-9]/g, '');
}

app.get('/api/terceros-fiscales', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, notas, updated_at
       FROM terceros_fiscales WHERE contador_id = $1 ORDER BY updated_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo terceros fiscales:', err);
    res.status(500).json({ error: 'No se pudieron cargar los perfiles fiscales.' });
  }
});

app.post('/api/terceros-fiscales', requireAuth, async (req, res) => {
  try {
    const nit = normalizarNit(req.body.nit);
    if (!nit) return res.status(400).json({ error: 'Falta el NIT del tercero.' });
    const nombre = String(req.body.nombre || '').trim();
    const notas = String(req.body.notas || '').trim();
    const granContribuyente = !!req.body.gran_contribuyente;
    const autorretenedor = !!req.body.autorretenedor;
    const regimenSimple = !!req.body.regimen_simple;
    const agenteRetencionIva = !!req.body.agente_retencion_iva;

    // Si no queda ninguna marca activa y no hay nombre/notas, no tiene
    // sentido guardar una fila vacía -- se borra en vez de guardar.
    if (!granContribuyente && !autorretenedor && !regimenSimple && !agenteRetencionIva && !nombre && !notas) {
      await pool.query('DELETE FROM terceros_fiscales WHERE contador_id = $1 AND nit = $2', [req.userId, nit]);
      return res.json({ nit, nombre: '', gran_contribuyente: false, autorretenedor: false, regimen_simple: false, agente_retencion_iva: false, notas: '', borrado: true });
    }

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO terceros_fiscales (id, contador_id, nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (contador_id, nit) DO UPDATE SET
         nombre = EXCLUDED.nombre, gran_contribuyente = EXCLUDED.gran_contribuyente,
         autorretenedor = EXCLUDED.autorretenedor, regimen_simple = EXCLUDED.regimen_simple,
         agente_retencion_iva = EXCLUDED.agente_retencion_iva, notas = EXCLUDED.notas, updated_at = now()
       RETURNING nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, notas, updated_at`,
      [id, req.userId, nit, nombre, granContribuyente, autorretenedor, regimenSimple, agenteRetencionIva, notas]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error guardando perfil fiscal del tercero:', err);
    res.status(500).json({ error: 'No se pudo guardar el perfil fiscal.' });
  }
});

app.delete('/api/terceros-fiscales/:nit', requireAuth, async (req, res) => {
  try {
    const nit = normalizarNit(req.params.nit);
    const { rowCount } = await pool.query(
      'DELETE FROM terceros_fiscales WHERE contador_id = $1 AND nit = $2',
      [req.userId, nit]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'No había un perfil fiscal guardado para ese NIT.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando perfil fiscal del tercero:', err);
    res.status(500).json({ error: 'No se pudo eliminar el perfil fiscal.' });
  }
});

// ---------- Tarifas de ReteICA (por municipio, configurables por el contador) ----------
app.get('/api/tarifas-ica', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, municipio, actividad, tarifa_por_mil, base_uvt, cuenta_puc, notas, updated_at
       FROM tarifas_ica WHERE contador_id = $1 ORDER BY municipio ASC, actividad ASC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo tarifas de ICA:', err);
    res.status(500).json({ error: 'No se pudieron cargar las tarifas de ICA.' });
  }
});

app.post('/api/tarifas-ica', requireAuth, async (req, res) => {
  try {
    const municipio = String(req.body.municipio || '').trim();
    const actividad = String(req.body.actividad || '').trim();
    const tarifaPorMil = Number(req.body.tarifa_por_mil);
    const baseUvt = Number(req.body.base_uvt) || 0;
    const cuentaPuc = String(req.body.cuenta_puc || '').trim();
    const notas = String(req.body.notas || '').trim();

    if (!municipio) return res.status(400).json({ error: 'Falta el municipio.' });
    if (!tarifaPorMil || tarifaPorMil <= 0) return res.status(400).json({ error: 'La tarifa por mil debe ser un número mayor a 0.' });
    if (baseUvt < 0) return res.status(400).json({ error: 'La base mínima en UVT no puede ser negativa.' });

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO tarifas_ica (id, contador_id, municipio, actividad, tarifa_por_mil, base_uvt, cuenta_puc, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (contador_id, municipio, actividad) DO UPDATE SET
         tarifa_por_mil = EXCLUDED.tarifa_por_mil, base_uvt = EXCLUDED.base_uvt,
         cuenta_puc = EXCLUDED.cuenta_puc, notas = EXCLUDED.notas, updated_at = now()
       RETURNING id, municipio, actividad, tarifa_por_mil, base_uvt, cuenta_puc, notas, updated_at`,
      [id, req.userId, municipio, actividad, tarifaPorMil, baseUvt, cuentaPuc, notas]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error guardando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo guardar la tarifa de ICA.' });
  }
});

app.put('/api/tarifas-ica/:id', requireAuth, async (req, res) => {
  try {
    const municipio = String(req.body.municipio || '').trim();
    const actividad = String(req.body.actividad || '').trim();
    const tarifaPorMil = Number(req.body.tarifa_por_mil);
    const baseUvt = Number(req.body.base_uvt) || 0;
    const cuentaPuc = String(req.body.cuenta_puc || '').trim();
    const notas = String(req.body.notas || '').trim();

    if (!municipio) return res.status(400).json({ error: 'Falta el municipio.' });
    if (!tarifaPorMil || tarifaPorMil <= 0) return res.status(400).json({ error: 'La tarifa por mil debe ser un número mayor a 0.' });

    const { rows } = await pool.query(
      `UPDATE tarifas_ica SET municipio=$1, actividad=$2, tarifa_por_mil=$3, base_uvt=$4, cuenta_puc=$5, notas=$6, updated_at=now()
       WHERE id=$7 AND contador_id=$8
       RETURNING id, municipio, actividad, tarifa_por_mil, base_uvt, cuenta_puc, notas, updated_at`,
      [municipio, actividad, tarifaPorMil, baseUvt, cuentaPuc, notas, req.params.id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tarifa de ICA no encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error actualizando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo actualizar la tarifa de ICA.' });
  }
});

app.delete('/api/tarifas-ica/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tarifas_ica WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Tarifa de ICA no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo eliminar la tarifa de ICA.' });
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