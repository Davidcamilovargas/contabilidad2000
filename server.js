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
const lotes = require('./public/lotes');
const { cabecerasSeguridad, crearCors, crearLimitador } = require('./seguridad');
// Única fuente de verdad de tarifas de retención (ver public/retenciones.js
// -- se carga como <script> en el navegador Y aquí con require(), misma
// tabla en los dos lados).
const { TARIFAS_RETENCION, montoCategoriaEnFactura, anioDeFechaFactura, esCategoriaCriterioAcumulado } = require('./public/retenciones');
// Motor contable mínimo (PUC + asientos de partida doble) -- ver
// asientos.js para el alcance exacto de esta primera versión.
const { PLAN_CUENTAS_SEMILLA, generarAsientoEgreso } = require('./asientos');

const app = express();
// Render (y cualquier hosting detrás de un proxy/balanceador) entrega las
// peticiones a Express por HTTP plano, agregando cabeceras X-Forwarded-*
// con los datos reales de la conexión del visitante. Sin esto, req.ip
// siempre sería la IP interna del proxy (rompe el límite de tasa por IP
// de abajo) y req.secure siempre sería false (rompe HSTS y la detección
// de "producción" de la cookie de sesión, ver issueSessionCookie).
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;

// Correo de invitación a la firma (ver /api/firma/invitar más abajo) --
// usa la API HTTP de Resend directamente con fetch (igual que las
// llamadas a Gemini), sin agregar el SDK como dependencia nueva. Es
// opcional a propósito: si no está configurada, la invitación se sigue
// creando en la base de datos exactamente igual (eso es lo que de
// verdad la activa cuando la persona inicia sesión), solo que no se le
// avisa por correo -- el administrador tendría que avisarle por su
// cuenta mientras tanto.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Enlaza <onboarding@resend.dev>';
if (!RESEND_API_KEY) {
  console.warn('[correo] No hay RESEND_API_KEY configurada -- las invitaciones a la firma se crean igual, pero no se envía el correo de aviso.');
}

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
  // Igual que regimen_simple, pero para "Autorretenedor" -- muy común en
  // facturas de servicios públicos (EPM y similares lo imprimen junto al
  // NIT del emisor). Si el proveedor se autorretiene, el comprador NO
  // debe practicar retención en la fuente ni ReteICA sobre esa factura
  // (ver perfilFiscalEfectivo() en public/retenciones.js).
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS autorretenedor BOOLEAN DEFAULT false;`);
  // Número de digitación/comprobante -- lo escribe el contador cuando YA
  // registró esta factura en su propio software contable (Siigo, Alegra,
  // World Office, etc.). Mientras esté vacío, la factura se puede seguir
  // corrigiendo libremente en Enlaza; el frontend exige este número antes
  // de poder guardar/marcar como lista, para que nunca quede una factura
  // "digitada" (ya contabilizada afuera) que alguien siga editando acá
  // sin que el número contable quede desincronizado.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS numero_digitacion TEXT DEFAULT '';`);
  // Avisos informativos que la IA puede detectar en el documento -- no
  // afectan ningún cálculo, solo alimentan un aviso en la interfaz para
  // que el contador revise a mano (ej. una factura de servicios públicos
  // que muestra un "saldo vencido" de un periodo anterior ya pagado, o
  // un anticipo/avance que el proveedor ya descontó del total).
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS saldo_vencido_detectado BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS anticipo_detectado BOOLEAN DEFAULT false;`);
  // Valor que el documento indica que YA fue abonado/anticipado sobre el
  // total (ej. una cuenta de cobro que dice "de los cuales se abonaron
  // $X") -- se guarda aparte del total de la factura para que el
  // contador sepa cuánto queda realmente pendiente de pago, sin que
  // esto afecte el valor sobre el que se calcula la retención (la
  // retención se calcula sobre el valor causado/facturado completo, no
  // sobre lo efectivamente desembolsado). Vacío/'0' = no se detectó ni
  // se registró ningún abono.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valor_abonado TEXT DEFAULT '';`);
  // Desglose del subtotal por categoría, para facturas que mezclan
  // ítems de distinta naturaleza (ej. productos + mano de obra en la
  // misma factura) -- se guarda como texto JSON, ej: '{"compras":442000,"servicios":140000}'.
  // Vacío ('' o '{}') significa que toda la factura es una sola categoría.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS desglose_categorias TEXT DEFAULT '';`);
  // Igual que desglose_categorias pero sumando el componente de AIU
  // declarado por categoría (solo aplica a vigilancia_aseo/servicios_
  // temporales) -- ej: '{"vigilancia_aseo":80000}'. Una categoría con
  // baseEspecial 'aiu' que NO aparece aquí significa "AIU no se sabe
  // todavía", no "AIU es cero" (ver calcularRetencionCategoriaLinea en
  // public/retenciones.js, que distingue exactamente ese caso en vez de
  // asumir $0 de retención).
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS desglose_aiu TEXT DEFAULT '';`);
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
  // AIU (Administración + Imprevistos + Utilidad) del ítem -- SOLO
  // aplica a categorías con base especial (aseo/vigilancia, servicios
  // temporales). La retención en esas categorías NO se calcula sobre el
  // subtotal bruto del ítem sino sobre este valor (ver baseEspecial en
  // TARIFAS_RETENCION, public/retenciones.js). Cadena vacía = "no se
  // sabe todavía" (el ítem no trae AIU desglosado o el contador aún no
  // lo ha ingresado) -- nunca se guarda 0 por defecto, porque 0 se
  // leería como "AIU es cero" y dejaría de cobrar la retención mínima
  // presuntiva del 10%.
  await pool.query(`ALTER TABLE factura_items ADD COLUMN IF NOT EXISTS aiu TEXT DEFAULT '';`);
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
  // Aparte de lo anterior -- el ICA es municipal, no viene en las
  // responsabilidades del RUT que ya se leen arriba, así que no se
  // puede derivar solo: el contador lo marca a mano, una vez, en la
  // ficha del cliente. Si no está marcado, la app asume por defecto
  // que ICA no aplica y no ofrece calcularlo.
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS agente_retenedor_ica BOOLEAN DEFAULT false;`);
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
  // es que Enlaza recuerda y aplica la corrección la próxima vez,
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
      declarante_renta BOOLEAN NOT NULL DEFAULT false,
      notas TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, nit)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_terceros_fiscales_contador ON terceros_fiscales (contador_id);`);
  // CREATE TABLE IF NOT EXISTS no agrega columnas nuevas a una tabla que
  // ya existía de antes -- por eso `declarante_renta` (agregado después
  // de las cuatro banderas originales) necesita su propio ALTER TABLE.
  await pool.query(`ALTER TABLE terceros_fiscales ADD COLUMN IF NOT EXISTS declarante_renta BOOLEAN NOT NULL DEFAULT false;`);

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
  // Columna de rol -- ahora sí tiene efecto (ver requireAuth y
  // requireRole más abajo): administrador, contador, auxiliar_contable,
  // auxiliar_administrativo, solo_lectura.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'contador';`);

  // ---------- Multiempresa: firma -> usuarios ----------
  //
  // En vez de una tabla "firmas" separada, se reusa la propia tabla
  // `users`: cada fila de `users` ya es dueña de todos sus `clients`,
  // `invoices`, etc. vía `contador_id` -- eso NO cambia. Lo único nuevo
  // es `firma_id`: el id del usuario "fundador" de la firma, el mismo
  // valor que YA se usa como `contador_id` en cada tabla del sistema.
  // Así, ni una sola de las ~90 consultas `WHERE contador_id = $1` que
  // ya existían en este archivo tuvo que tocarse -- lo que cambió es
  // QUÉ id se les pasa: antes siempre `req.userId` (la persona que
  // inició sesión), ahora `req.firmaId` (la firma a la que pertenece esa
  // persona, resuelta en requireAuth). Para una cuenta que sigue sola
  // (sin invitar a nadie), `firma_id = id` siempre, así que
  // `req.firmaId === req.userId` y nada cambia en la práctica.
  //
  // `nombre_firma` es opcional -- si el administrador no le pone un
  // nombre a su firma, la UI usa su propio nombre de pila como respaldo.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS firma_id UUID;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nombre_firma TEXT DEFAULT '';`);
  // Backfill de una sola vez: toda cuenta que exista desde antes de este
  // cambio (firma_id todavía NULL) se vuelve fundadora de su propia
  // firma (firma_id = su propio id) y queda como 'administrador' -- es
  // literalmente lo que ya era (dueña de todos sus datos), solo que
  // ahora el rol lo refleja explícitamente. El WHERE firma_id IS NULL
  // hace que esto corra una única vez por cuenta, nunca de nuevo (así
  // que si un administrador más adelante se auto-degrada a 'contador',
  // este backfill no lo va a resucitar en el próximo arranque).
  await pool.query(`UPDATE users SET firma_id = id, role = 'administrador' WHERE firma_id IS NULL;`);

  // Invitaciones pendientes -- alguien todavía sin cuenta en Enlaza
  // (identificado solo por correo) al que un administrador ya le asignó
  // un rol dentro de su firma. Cuando esa persona inicie sesión con
  // Google por primera vez, si su correo coincide con una invitación
  // pendiente, se une a esa firma con ese rol en vez de fundar una
  // firma propia nueva (ver /auth/google más abajo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invitaciones_firma (
      id UUID PRIMARY KEY,
      firma_id UUID NOT NULL,
      email TEXT NOT NULL,
      rol TEXT NOT NULL,
      invitado_por UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitaciones_firma_email ON invitaciones_firma (LOWER(email));`);

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
  // factura guardada en Enlaza, para no volver a crearla si se manda
  // "Enviar" dos veces, y para mostrar el estado en Facturas. Cada
  // proveedor tiene sus propias columnas porque una misma factura se
  // podría enviar a más de uno.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS alegra_bill_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS alegra_enviada_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS siigo_bill_id TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS siigo_enviada_at TIMESTAMPTZ;`);

  // ---------- Motor contable mínimo: plan de cuentas + asientos ----------
  // Ver asientos.js para el alcance exacto (por ahora solo egresos, solo
  // causación, nunca se adivina lo que el contador no ha confirmado).
  //
  // Cada contador tiene su propia copia del plan de cuentas -- se
  // siembra la primera vez que hace falta (asegurarPlanCuentasContador,
  // más abajo), no en ensureSchema, porque sembrar necesita saber DE
  // QUÉ contador se trata.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_cuentas (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      codigo TEXT NOT NULL,
      nombre TEXT NOT NULL,
      naturaleza TEXT NOT NULL,
      clase TEXT NOT NULL,
      activa BOOLEAN NOT NULL DEFAULT true,
      creado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contador_id, codigo)
    );
  `);

  // Un asiento por factura (por ahora) -- "propuesto" es lo que generó
  // el sistema solo, "aprobado" es lo que el contador ya confirmó. Nunca
  // hay un tercer estado que se salte la aprobación humana.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asientos_contables (
      id UUID PRIMARY KEY,
      contador_id UUID NOT NULL,
      invoice_id UUID,
      fecha TEXT DEFAULT '',
      descripcion TEXT DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'propuesto',
      generado_por TEXT NOT NULL DEFAULT 'ia',
      aprobado_at TIMESTAMPTZ,
      creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asientos_contador_estado ON asientos_contables (contador_id, estado);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asientos_invoice ON asientos_contables (invoice_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asiento_lineas (
      id UUID PRIMARY KEY,
      asiento_id UUID NOT NULL,
      orden INTEGER NOT NULL DEFAULT 0,
      cuenta_codigo TEXT NOT NULL,
      cuenta_nombre TEXT NOT NULL,
      debito NUMERIC NOT NULL DEFAULT 0,
      credito NUMERIC NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asiento_lineas_asiento ON asiento_lineas (asiento_id);`);

  // ---------- Confianza de la IA + aprobación del contador (Fase 2) ----------
  // `confianza_campos`: JSON (guardado como TEXT, igual que
  // desglose_categorias) con un puntaje 0-1 por cada campo clave que
  // Gemini extrajo, para que una futura pantalla de revisión pueda
  // resaltar los campos dudosos sin que el contador tenga que adivinar
  // cuáles revisar con lupa.
  // `aprobado_por_contador`/`aprobado_at`: a diferencia de los 3 campos
  // de retención (editables por CAMPOS_EDITABLES_RETENCION) o del
  // estado de un asiento, la aprobación de la FACTURA solo cambia por
  // la ruta dedicada de abajo -- nunca es parte de SAVED_FIELDS, para
  // que guardar o editar una factura no pueda marcarla como aprobada
  // por accidente.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confianza_campos TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS aprobado_por_contador BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS aprobado_at TIMESTAMPTZ;`);

  // ---------- Cuadratura de valores (retenciones -- tema #1) ----------
  // Antes, si "valor sin IVA + IVA" no cuadraba con "valor con IVA", lo
  // único que pasaba era que generarAsientoEgreso() se negaba en
  // silencio a proponer un asiento (error 'valores_no_cuadran') -- la
  // factura quedaba guardada igual, pero sin ninguna marca visible de
  // por qué nunca apareció su asiento. Este campo hace visible y
  // PERMANENTE ese mismo chequeo (calculado una sola vez, al guardar,
  // con la misma tolerancia de $1 que ya usa asientos.js) para que
  // Facturas pueda mostrar una alerta que no dependa de que el
  // contador se acuerde de ir a revisar por qué falta un asiento.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valores_descuadrados BOOLEAN NOT NULL DEFAULT false;`);
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
app.disable('x-powered-by'); // no anunciar "Express" en cada respuesta -- un paso menos para quien busque huecos conocidos de una versión específica
app.use(cabecerasSeguridad);
// ALLOWED_ORIGINS: orígenes EXTRA (además del propio Enlaza, que nunca
// necesita estar en esta lista) a los que se les permite leer respuestas
// de la API desde el navegador -- separados por coma, ej.
// "https://app.enlaza.co,https://socios.enlaza.co". Vacío por defecto:
// hoy nadie más que el propio frontend de Enlaza llama a esta API.
app.use(crearCors((process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim())));
app.use(express.json({ limit: '20mb' })); // las facturas en base64 pueden pesar varios MB
app.use(cookieParser());

// Límite de tasa general para toda la API -- una primera barrera contra
// tráfico automatizado/abusivo antes de llegar a cualquier ruta. Los
// límites más estrictos de login e IA (más abajo, junto a sus rutas) se
// suman a este, no lo reemplazan.
const limitadorGeneral = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 600,
  mensaje: 'Demasiadas solicitudes desde este origen -- espera unos minutos e intenta de nuevo.',
});
app.use('/api', limitadorGeneral);

// Límite de tasa para el login de Google -- protege el endpoint que
// verifica tokens contra los servidores de Google de ser golpeado en
// bucle (cada verificación cuesta una llamada real a Google).
const limitadorAuth = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 20,
  mensaje: 'Demasiados intentos de inicio de sesión -- espera unos minutos e intenta de nuevo.',
});

// Límite de tasa para las rutas que llaman a Gemini -- cada llamada
// cuesta dinero real, así que esto protege el gasto además de la carga
// del servidor. Se limita por contador ya autenticado (no por IP) para
// que el tráfico de un contador no afecte a los demás; antes de que
// requireAuth haya corrido (no debería pasar, todas estas rutas lo usan
// primero) cae de vuelta a la IP.
const limitadorIA = crearLimitador({
  ventanaMs: 15 * 60 * 1000,
  maximo: 60,
  mensaje: 'Demasiadas facturas/solicitudes de IA en poco tiempo -- espera unos minutos e intenta de nuevo.',
  obtenerClave: (req) => req.firmaId,
});

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

// Los 5 roles de "Multiempresa + roles" -- administrador puede gestionar
// la firma (invitar/quitar gente, cambiar roles, Configuración e
// integraciones); contador tiene el mismo alcance operativo del día a
// día (aprobar, eliminar, configurar tarifas) pero no administra la
// firma; auxiliar_contable puede cargar y editar facturas pero no
// aprobar ni eliminar; auxiliar_administrativo solo puede escanear/subir
// documentos (captura), sin ver ni tocar cifras ya aprobadas; y
// solo_lectura únicamente consulta reportes, nunca escribe nada.
const ROLES_VALIDOS = ['administrador', 'contador', 'auxiliar_contable', 'auxiliar_administrativo', 'solo_lectura'];
// Mismos nombres en español que ya muestra public/mi-firma.html (NOMBRES_ROL) --
// duplicado a propósito porque uno vive en el navegador y el otro en el
// correo que arma el servidor; si se agrega un rol nuevo, actualizar los dos.
const NOMBRES_ROL = {
  administrador: 'Administrador',
  contador: 'Contador',
  auxiliar_contable: 'Auxiliar contable',
  auxiliar_administrativo: 'Auxiliar administrativo',
  solo_lectura: 'Solo lectura',
};

// Verifica el JWT de la cookie y, si es válido, resuelve TRES cosas:
//  - req.userId: la identidad real de quien inició sesión (para /api/me,
//    auditoría de "quién lo hizo", y el limitador de tasa de IA).
//  - req.firmaId: la firma a la que pertenece -- el id que se usa en
//    TODAS las tablas de negocio (clients, invoices, tarifas, etc.) en
//    vez de req.userId, para que los datos se compartan entre todos los
//    usuarios de una misma firma. Para una cuenta que nunca invitó a
//    nadie, firma_id === userId siempre.
//  - req.rol: uno de ROLES_VALIDOS, usado por requireRole() más abajo.
// Si no, responde 401 en JSON (nunca redirige -- esto protege rutas /api/*).
async function requireAuth(req, res, next) {
  const token = req.cookies?.kardex_session;
  if (!token) return res.status(401).json({ error: 'No has iniciado sesión.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    const { rows } = await pool.query('SELECT firma_id, role FROM users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'Tu cuenta ya no existe. Inicia sesión de nuevo.' });
    // Respaldo por si acaso (no debería pasar tras el backfill de
    // ensureSchema, pero evita un req.firmaId nulo si algo raro pasó).
    req.firmaId = rows[0].firma_id || req.userId;
    req.rol = rows[0].role || 'contador';
    // solo_lectura nunca escribe nada, en ninguna pantalla -- se aplica
    // una sola vez aquí (en vez de agregar requireRole a cada una de las
    // ~35 rutas que modifican algo) porque la regla es absoluta: no hay
    // ninguna excepción de "esto sí lo puede crear/editar". GET/HEAD
    // siempre pasan (son solo lectura, que es justo lo que sí puede hacer).
    if (req.rol === 'solo_lectura' && !['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'Tu rol es de solo lectura -- no puedes crear, editar ni eliminar nada.' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.' });
  }
}

// Restringe una ruta a ciertos roles -- se usa DESPUÉS de requireAuth
// (necesita req.rol ya resuelto). Devuelve 403, nunca 401 (la sesión sí
// es válida, solo que ese rol no puede hacer esto).
function requireRole(...rolesPermitidos) {
  return function (req, res, next) {
    if (!rolesPermitidos.includes(req.rol)) {
      return res.status(403).json({ error: 'Tu rol dentro de la firma no tiene permiso para hacer esto.' });
    }
    next();
  };
}

// Correo "te invitaron" -- mismo espíritu que compartir una carpeta de
// Drive: nombre de quien invita, a qué firma, con qué rol, y un botón
// que lleva a iniciar sesión. La invitación YA quedó activa en la base
// de datos antes de llamar esto (ver /api/firma/invitar) -- este correo
// es solo el aviso, nunca la condición para que la invitación funcione.
function plantillaCorreoInvitacion({ nombreInvita, nombreFirma, rolLabel, email, urlLogin }) {
  const petroleo = '#0B4F6C';
  const coral = '#FF6B4A';
  const tinta = '#1D2A32';
  const tintaSuave = '#4A5E68';
  const papel = '#F6FAFC';
  const linea = '#DCE7EC';
  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:${papel};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${tinta};">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:1px solid ${linea};border-radius:12px;overflow:hidden;">
    <div style="padding:28px 32px 0;">
      <div style="font-size:20px;font-weight:700;color:${petroleo};letter-spacing:-0.01em;">Enlaza</div>
    </div>
    <div style="padding:20px 32px 8px;">
      <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
        <strong>${escaparHtmlCorreo(nombreInvita)}</strong> te invitó a unirte a
        <strong>${escaparHtmlCorreo(nombreFirma)}</strong> en Enlaza, con el rol de
        <strong>${escaparHtmlCorreo(rolLabel)}</strong>.
      </p>
      <p style="font-size:14px;line-height:1.6;color:${tintaSuave};margin:0 0 24px;">
        Enlaza es la plataforma donde tu firma procesa facturas, calcula retenciones y lleva la contabilidad con ayuda de IA. Al unirte vas a ver los mismos clientes y documentos que el resto del equipo.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td style="border-radius:8px;background:${coral};">
          <a href="${urlLogin}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">Aceptar invitación</a>
        </td></tr>
      </table>
      <p style="font-size:13px;line-height:1.6;color:${tintaSuave};margin:0 0 24px;">
        Al hacer clic, inicia sesión con Google usando exactamente este correo: <strong>${escaparHtmlCorreo(email)}</strong>. Si usas una cuenta de Google distinta, no vas a entrar a ${escaparHtmlCorreo(nombreFirma)}.
      </p>
    </div>
    <div style="padding:16px 32px 24px;border-top:1px solid ${linea};">
      <p style="font-size:12px;line-height:1.5;color:${tintaSuave};margin:0;">Si no esperabas este correo, puedes ignorarlo -- no se creó ninguna cuenta a tu nombre todavía.</p>
    </div>
  </div>
</body>
</html>`;
  const texto = `${nombreInvita} te invitó a unirte a ${nombreFirma} en Enlaza, con el rol de ${rolLabel}.\n\nAcepta la invitación iniciando sesión con Google usando exactamente este correo (${email}): ${urlLogin}\n\nSi usas una cuenta de Google distinta, no vas a entrar a ${nombreFirma}.\n\nSi no esperabas este correo, puedes ignorarlo.`;
  return { html, texto };
}

function escaparHtmlCorreo(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// El remitente que se ve en la bandeja de entrada también dice quién
// invitó -- mismo patrón que "Fulano compartió una carpeta contigo (vía
// Google Drive)". La dirección de correo real se queda fija (la de
// RESEND_FROM, ej. onboarding@resend.dev hasta que haya dominio propio
// verificado en Resend); solo el nombre que se muestra cambia por
// invitación.
function remitenteConNombreDeQuienInvita(nombreInvita) {
  const correoDelRemitente = (/<([^>]+)>/.exec(RESEND_FROM) || [, RESEND_FROM])[1].trim();
  const nombreLimpio = String(nombreInvita || '').replace(/["<>]/g, '').trim() || 'Alguien de tu equipo';
  return `"${nombreLimpio} (vía Enlaza)" <${correoDelRemitente}>`;
}

// Envía el correo de invitación por la API HTTP de Resend. Nunca lanza
// -- si Resend no está configurado, tarda demasiado, o responde con
// error, se registra en consola y se devuelve false; la invitación en
// la base de datos (lo que de verdad importa) ya quedó creada antes de
// llamar esto, así que un correo que falla nunca debe tumbar la
// petición de /api/firma/invitar.
async function enviarCorreoInvitacion({ email, nombreInvita, nombreFirma, rol, urlLogin }) {
  if (!RESEND_API_KEY) return false;
  const rolLabel = NOMBRES_ROL[rol] || rol;
  const { html, texto } = plantillaCorreoInvitacion({ nombreInvita, nombreFirma, rolLabel, email, urlLogin });
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), 8000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: remitenteConNombreDeQuienInvita(nombreInvita),
        to: [email],
        subject: `${nombreInvita} te invitó a unirte a ${nombreFirma} en Enlaza`,
        html,
        text: texto,
      }),
      signal: controlador.signal,
    });
    if (!resp.ok) {
      const cuerpo = await resp.text().catch(() => '');
      console.error(`[correo] Resend respondió ${resp.status} al invitar a ${email}: ${cuerpo}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[correo] No se pudo enviar el correo de invitación a ${email}:`, err.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Nombre de quien invita y nombre de la firma, para personalizar el
// correo -- misma lógica de "nombre a mostrar" que ya usa /api/me
// (nombre_firma si lo pusieron, si no el nombre de quien la fundó).
async function obtenerContextoParaCorreoInvitacion(req) {
  const [quienInvita, firma] = await Promise.all([
    pool.query('SELECT nombre FROM users WHERE id = $1', [req.userId]),
    pool.query('SELECT nombre, nombre_firma FROM users WHERE id = $1', [req.firmaId]),
  ]);
  const nombreInvita = quienInvita.rows[0]?.nombre || 'Un compañero';
  const filaFirma = firma.rows[0] || {};
  const nombreFirma = filaFirma.nombre_firma || filaFirma.nombre || 'tu firma en Enlaza';
  return { nombreInvita, nombreFirma };
}

// Recibe el token que entrega el botón de Google (Google Identity
// Services) en el navegador, lo verifica contra los servidores de
// Google, y crea o reconoce al usuario en nuestra base de datos.
app.post('/auth/google', limitadorAuth, async (req, res) => {
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
        return res.status(403).json({ error: 'Tu correo todavía no está autorizado para usar Enlaza. Escríbele a David para que te dé acceso.' });
      }
    }

    const existing = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
    } else {
      // Cuenta nueva -- antes de fundar su propia firma, revisa si algún
      // administrador ya la invitó por este correo. Si hay una
      // invitación pendiente, se une a esa firma con el rol que le
      // asignaron, en vez de quedar como fundadora de una firma vacía.
      // Si hay varias invitaciones para el mismo correo (poco probable),
      // usa la más reciente y descarta el resto.
      const invRes = await pool.query(
        'SELECT * FROM invitaciones_firma WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
        [email]
      );
      const invitacion = invRes.rows.length > 0 ? invRes.rows[0] : null;

      const id = crypto.randomUUID();
      const firmaId = invitacion ? invitacion.firma_id : id;
      const rol = invitacion ? invitacion.rol : 'administrador';
      const { rows } = await pool.query(
        'INSERT INTO users (id, google_id, email, nombre, avatar_url, firma_id, role) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [id, googleId, email, nombre, avatarUrl, firmaId, rol]
      );
      user = rows[0];

      if (invitacion) {
        await pool.query('DELETE FROM invitaciones_firma WHERE id = $1', [invitacion.id]);
      } else {
        // Solo la fundadora de una firma nueva necesita su propio plan
        // de cuentas -- alguien que se unió por invitación ya comparte
        // el de la firma. Si esto falla, no bloquea el login (se vuelve
        // a intentar sola, sembrado es idempotente, ver
        // asegurarPlanCuentasContador).
        asegurarPlanCuentasContador(user.id).catch((err) => {
          console.error('No se pudo sembrar el plan de cuentas del nuevo contador:', err.message);
        });
      }
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
    const { rows } = await pool.query('SELECT id, email, nombre, avatar_url, role FROM users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado.' });

    // El plan y el límite de clientes son de la FIRMA, no de la persona
    // -- viven en la fila del usuario fundador (id = firma_id), que para
    // una cuenta que nunca invitó a nadie es la misma fila de arriba.
    const firmaRes = await pool.query('SELECT nombre, nombre_firma, plan FROM users WHERE id = $1', [req.firmaId]);
    const firma = firmaRes.rows[0] || {};
    const plan = firma.plan || 'solo';
    const limite = clientLimitFor(plan);
    const countRes = await pool.query('SELECT COUNT(*) FROM clients WHERE contador_id = $1', [req.firmaId]);
    const actuales = Number(countRes.rows[0].count);

    res.json({
      id: rows[0].id, email: rows[0].email, nombre: rows[0].nombre, avatarUrl: rows[0].avatar_url,
      role: rows[0].role || 'contador',
      firmaId: req.firmaId,
      nombreFirma: firma.nombre_firma || firma.nombre || rows[0].nombre,
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

// ---------- Multiempresa: gestión de la firma ----------
//
// Solo el administrador puede invitar, cambiar roles o quitar gente --
// contador tiene el mismo alcance operativo del día a día, pero la
// gestión de LA FIRMA MISMA (quién entra, con qué rol) es exclusiva del
// administrador.

// Miembros activos + invitaciones pendientes de la firma de quien
// pregunta -- una sola pantalla necesita ambas listas.
app.get('/api/firma/miembros', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const { rows: miembros } = await pool.query(
      `SELECT id, email, nombre, avatar_url, role FROM users WHERE firma_id = $1 ORDER BY nombre ASC`,
      [req.firmaId]
    );
    // "es_fundador" y el orden (fundador primero) se calculan aquí en
    // vez de en el SQL -- una expresión booleana dentro del SELECT/ORDER
    // BY es más frágil de mantener que esto, y el resultado es idéntico.
    miembros.forEach((m) => { m.es_fundador = m.id === req.firmaId; });
    miembros.sort((a, b) => (Number(b.es_fundador) - Number(a.es_fundador)) || String(a.nombre || '').localeCompare(String(b.nombre || '')));
    const { rows: invitaciones } = await pool.query(
      `SELECT id, email, rol, created_at FROM invitaciones_firma WHERE firma_id = $1 ORDER BY created_at DESC`,
      [req.firmaId]
    );
    res.json({ miembros, invitaciones });
  } catch (err) {
    console.error('Error listando miembros de la firma:', err);
    res.status(500).json({ error: 'No se pudieron leer los miembros de la firma.' });
  }
});

// Invitar a alguien nuevo por correo, con un rol ya asignado. Si esa
// persona ya tiene cuenta en Enlaza (con OTRA firma), esta invitación no
// la mueve sola -- solo aplica la primera vez que alguien inicia sesión
// SIN cuenta previa (ver /auth/google). Evita mandarla dos veces al
// mismo correo para la misma firma.
app.post('/api/firma/invitar', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const rol = String(req.body.rol || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Escribe un correo válido.' });
    if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
    if (rol === 'administrador') {
      // Un segundo administrador sí es válido (una firma puede querer
      // varios), pero se avisa aparte -- no es un error, solo se deja
      // pasar igual que cualquier otro rol.
    }

    const yaEsMiembro = await pool.query('SELECT 1 FROM users WHERE firma_id = $1 AND LOWER(email) = LOWER($2)', [req.firmaId, email]);
    if (yaEsMiembro.rows.length > 0) return res.status(400).json({ error: 'Ese correo ya es miembro de tu firma.' });

    const yaInvitado = await pool.query('SELECT 1 FROM invitaciones_firma WHERE firma_id = $1 AND LOWER(email) = LOWER($2)', [req.firmaId, email]);
    if (yaInvitado.rows.length > 0) return res.status(400).json({ error: 'Ya hay una invitación pendiente para ese correo.' });

    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO invitaciones_firma (id, firma_id, email, rol, invitado_por) VALUES ($1,$2,$3,$4,$5)',
      [id, req.firmaId, email, rol, req.userId]
    );

    // El correo es solo el aviso -- la invitación de arriba ya quedó
    // creada y funcionando aunque el envío falle (ver enviarCorreoInvitacion).
    const { nombreInvita, nombreFirma } = await obtenerContextoParaCorreoInvitacion(req);
    const urlLogin = `${req.protocol}://${req.get('host')}/login.html`;
    const correoEnviado = await enviarCorreoInvitacion({ email, nombreInvita, nombreFirma, rol, urlLogin });

    res.status(201).json({ ok: true, id, email, rol, correoEnviado });
  } catch (err) {
    console.error('Error invitando a la firma:', err);
    res.status(500).json({ error: 'No se pudo crear la invitación.' });
  }
});

// Reenviar el correo de una invitación pendiente (por si se fue a spam,
// o se creó antes de configurar RESEND_API_KEY). La invitación en sí no
// cambia -- esto solo vuelve a intentar el aviso.
app.post('/api/firma/invitaciones/:id/reenviar', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email, rol FROM invitaciones_firma WHERE id = $1 AND firma_id = $2', [req.params.id, req.firmaId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Esa invitación ya no existe.' });

    const { nombreInvita, nombreFirma } = await obtenerContextoParaCorreoInvitacion(req);
    const urlLogin = `${req.protocol}://${req.get('host')}/login.html`;
    const correoEnviado = await enviarCorreoInvitacion({ email: rows[0].email, nombreInvita, nombreFirma, rol: rows[0].rol, urlLogin });

    res.json({ ok: true, correoEnviado });
  } catch (err) {
    console.error('Error reenviando invitación:', err);
    res.status(500).json({ error: 'No se pudo reenviar el correo.' });
  }
});

// Cancelar una invitación que todavía no se ha usado.
app.delete('/api/firma/invitaciones/:id', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM invitaciones_firma WHERE id = $1 AND firma_id = $2', [req.params.id, req.firmaId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Invitación no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error cancelando invitación:', err);
    res.status(500).json({ error: 'No se pudo cancelar la invitación.' });
  }
});

// Cambiar el rol de un miembro ya activo de la firma.
app.patch('/api/firma/miembros/:id', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const rol = String(req.body.rol || '').trim();
    if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
    if (req.params.id === req.firmaId && rol !== 'administrador') {
      return res.status(400).json({ error: 'No puedes quitarte a ti mismo el rol de administrador de tu propia firma fundadora -- pídele a otro administrador que lo haga, o ascende a alguien más primero.' });
    }
    const { rowCount } = await pool.query('UPDATE users SET role = $1 WHERE id = $2 AND firma_id = $3', [rol, req.params.id, req.firmaId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Miembro no encontrado en tu firma.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error cambiando rol de miembro:', err);
    res.status(500).json({ error: 'No se pudo cambiar el rol.' });
  }
});

// Quitar a alguien de la firma -- lo separa a su PROPIA firma nueva y
// vacía (nunca se borra su cuenta ni los datos que ya se compartían, que
// se quedan con la firma; esa persona simplemente deja de verlos). Nadie
// puede quitarse a sí mismo de su propia firma fundadora.
app.delete('/api/firma/miembros/:id', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    if (req.params.id === req.firmaId) {
      return res.status(400).json({ error: 'No puedes quitarte a ti mismo -- eres quien fundó esta firma.' });
    }
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1 AND firma_id = $2', [req.params.id, req.firmaId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Miembro no encontrado en tu firma.' });
    await pool.query("UPDATE users SET firma_id = id, role = 'administrador' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error quitando miembro de la firma:', err);
    res.status(500).json({ error: 'No se pudo quitar al miembro.' });
  }
});

// Nombre visible de la firma (por defecto, el nombre de quien la fundó).
app.patch('/api/firma', requireAuth, requireRole('administrador'), async (req, res) => {
  try {
    const nombreFirma = String(req.body.nombreFirma || '').trim();
    await pool.query('UPDATE users SET nombre_firma = $1 WHERE id = $2', [nombreFirma, req.firmaId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error actualizando el nombre de la firma:', err);
    res.status(500).json({ error: 'No se pudo actualizar el nombre de la firma.' });
  }
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

// Antes esta tabla era una copia a mano de las tarifas con rango,
// separada de public/retenciones.js -- si una tarifa cambiaba allá y
// alguien olvidaba actualizar esta copia, quedaban desincronizadas sin
// que nada lo avisara. Ahora se deriva EN VIVO de la misma
// TARIFAS_RETENCION que usan Escanear/Carga masiva/Facturas (única
// fuente de verdad para toda la app, ver public/retenciones.js) --
// "con rango" son las categorías donde tarifaBaja !== tarifaAlta
// (declarante vs. no declarante); las demás tienen tarifa fija, no hay
// nada que aprender ahí.
const TARIFAS_CON_RANGO = Object.fromEntries(
  Object.entries(TARIFAS_RETENCION).filter(([, config]) => config.tarifaBaja !== config.tarifaAlta)
);

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

// ---------- Motor contable mínimo: plan de cuentas + asientos ----------

// Siembra el plan de cuentas base para un contador, si todavía no tiene
// ninguna fila (ON CONFLICT DO NOTHING hace que llamarla de más no
// duplique ni sobreescriba nada -- así se puede llamar tanto al crear
// la cuenta como, por si acaso, justo antes de generar el primer
// asiento de un contador que ya existía antes de este cambio).
async function asegurarPlanCuentasContador(contadorId) {
  for (const cuenta of PLAN_CUENTAS_SEMILLA) {
    await pool.query(
      `INSERT INTO plan_cuentas (id, contador_id, codigo, nombre, naturaleza, clase)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (contador_id, codigo) DO NOTHING`,
      [crypto.randomUUID(), contadorId, cuenta.codigo, cuenta.nombre, cuenta.naturaleza, cuenta.clase]
    );
  }
}

// Genera (o regenera) el asiento PROPUESTO de una factura ya guardada.
// Nunca lanza -- si algo sale mal, o si la factura todavía no tiene lo
// necesario para proponer un asiento (ver asientos.js), simplemente no
// se crea/actualiza nada. Se llama después de guardar o editar una
// factura, sin bloquear esa respuesta si esto falla (mismo criterio que
// guardarCorreccion/guardarTarifaProveedor, arriba).
async function generarYGuardarAsientoParaFactura(contadorId, invoiceRow) {
  try {
    const itemsRes = await pool.query(
      'SELECT categoria_concepto, subcuenta_gasto, subtotal FROM factura_items WHERE invoice_id = $1 ORDER BY orden',
      [invoiceRow.id]
    );
    const resultado = generarAsientoEgreso(invoiceRow, itemsRes.rows);
    if (resultado.error) {
      // No es un error del guardado de la factura -- solo significa que
      // todavía no hay suficiente información (o que es una factura de
      // ingreso, fuera de alcance por ahora) para proponer un asiento.
      // Si YA existía un asiento propuesto de una versión anterior de
      // esta factura (ej. el contador borró la subcuenta que había
      // elegido), se retira -- ya no sería válido con los datos de hoy.
      await pool.query(`DELETE FROM asientos_contables WHERE invoice_id = $1 AND estado = 'propuesto'`, [invoiceRow.id]);
      return;
    }

    await asegurarPlanCuentasContador(contadorId);

    const descripcion = `Factura ${invoiceRow.nombre_razon_social || 'sin nombre'} -- ${invoiceRow.concepto || ''}`.trim();
    const existente = await pool.query(
      `SELECT id FROM asientos_contables WHERE invoice_id = $1 AND estado = 'propuesto'`,
      [invoiceRow.id]
    );

    let asientoId;
    if (existente.rows.length > 0) {
      // Ya había una propuesta (sin aprobar todavía) -- se reemplaza por
      // la nueva, no se acumulan versiones viejas. Un asiento YA
      // aprobado nunca entra en esta rama (el filtro de arriba solo
      // busca 'propuesto') -- aprobar es una decisión del contador, y el
      // sistema no la deshace solo si la factura cambia después.
      asientoId = existente.rows[0].id;
      await pool.query('DELETE FROM asiento_lineas WHERE asiento_id = $1', [asientoId]);
      await pool.query(
        `UPDATE asientos_contables SET fecha = $2, descripcion = $3, creado_at = now() WHERE id = $1`,
        [asientoId, invoiceRow.fecha_factura || '', descripcion]
      );
    } else {
      asientoId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO asientos_contables (id, contador_id, invoice_id, fecha, descripcion, estado, generado_por)
         VALUES ($1,$2,$3,$4,$5,'propuesto','ia')`,
        [asientoId, contadorId, invoiceRow.id, invoiceRow.fecha_factura || '', descripcion]
      );
    }

    for (const linea of resultado.lineas) {
      await pool.query(
        `INSERT INTO asiento_lineas (id, asiento_id, orden, cuenta_codigo, cuenta_nombre, debito, credito)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), asientoId, linea.orden, linea.cuenta_codigo, linea.cuenta_nombre, linea.debito, linea.credito]
      );
    }
  } catch (err) {
    console.error('No se pudo generar el asiento propuesto de la factura:', err.message);
  }
}

const SAVED_FIELDS = [
  'tipo_doc', 'nit_cc', 'dv', 'nombre_razon_social',
  'letras_fe', 'numeros_fe', 'fecha_factura',
  'valor_sin_iva', 'valor_iva', 'valor_con_iva',
  'rete_fuente', 'rete_iva', 'rete_ica', 'concepto', 'categoria_concepto',
  'tipo_movimiento', 'adquiriente_nit', 'adquiriente_nombre', 'cliente_id',
  'regimen_simple', 'autorretenedor', 'desglose_categorias', 'desglose_aiu', 'subcuenta_gasto', 'file_hash',
  'tarifa_ica_id', 'numero_digitacion', 'saldo_vencido_detectado', 'anticipo_detectado', 'valor_abonado',
  'confianza_campos',
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
    const { rows } = await pool.query('SELECT * FROM clients WHERE contador_id = $1 ORDER BY nombre ASC', [req.firmaId]);
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo clientes:', err);
    res.status(500).json({ error: 'No se pudieron leer los clientes.' });
  }
});

// Crear un cliente nuevo, asociado a este contador -- respetando el
// tope de clientes de su plan.
app.post('/api/clients', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const {
      nombre, nit, dv, tipo_persona, direccion, ciudad, telefono, correo,
      ciiu, responsabilidades, rut_archivo, rut_archivo_nombre,
      contacto_nombre, contacto_cargo, contacto_telefono, contacto_correo,
      banco, tipo_cuenta, numero_cuenta, agente_retenedor_ica,
    } = req.body;
    if (!nombre || !nit) {
      return res.status(400).json({ error: 'Nombre y NIT son obligatorios.' });
    }

    const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [req.firmaId]);
    const plan = userRes.rows[0]?.plan || 'solo';
    const limite = clientLimitFor(plan);

    if (limite !== null) {
      const countRes = await pool.query('SELECT COUNT(*) FROM clients WHERE contador_id = $1', [req.firmaId]);
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
        banco, tipo_cuenta, numero_cuenta, agente_retenedor_ica
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING *`,
      [
        id, nombre, nit, dv || '', req.firmaId, agenteRetenedorCalculado,
        tipo_persona || '', direccion || '', ciudad || '', telefono || '', correo || '', ciiu || '', responsabilidadesStr,
        rut_archivo || '', rut_archivo_nombre || '',
        contacto_nombre || '', contacto_cargo || '', contacto_telefono || '', contacto_correo || '',
        banco || '', tipo_cuenta || '', numero_cuenta || '', !!agente_retenedor_ica,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creando cliente:', err);
    res.status(500).json({ error: 'No se pudo crear el cliente.' });
  }
});

// Eliminar un cliente (solo si es de este contador)
app.delete('/api/clients/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM clients WHERE id = $1 AND contador_id = $2', [req.params.id, req.firmaId]);
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
  // A diferencia de "agente_retenedor" (Renta -- se calcula solo de las
  // responsabilidades del RUT), el ICA es municipal y no viene en esa
  // lista -- este sí lo marca el contador a mano, así que sí se acepta
  // directo del cliente.
  'agente_retenedor_ica',
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
    if (updates.agente_retenedor_ica !== undefined) {
      updates.agente_retenedor_ica = !!updates.agente_retenedor_ica;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'No se envió ningún campo para actualizar.' });
    }

    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map((k) => updates[k]);
    const { rows } = await pool.query(
      `UPDATE clients SET ${setClause} WHERE id = $${keys.length + 1} AND contador_id = $${keys.length + 2} RETURNING *`,
      [...values, req.params.id, req.firmaId]
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
    const { rows } = await pool.query('SELECT * FROM invoices WHERE contador_id = $1 ORDER BY saved_at DESC', [req.firmaId]);
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
// por Escanear/Carga masiva/Facturas/Informe de auditoría para mostrar
// el valor exacto en vez de un rango, cuando ya sabemos qué tarifa le
// corresponde a ese proveedor (ver calcularRetencionSugerida() en
// public/retenciones.js, parámetro `tarifasAprendidas`). Se llena sola
// cuando se guarda una factura con un Rete Fuente que coincide con una
// de las dos tarifas conocidas (ver guardarTarifaProveedor()/
// detectarTarifaUsada() más arriba) -- los endpoints de abajo son para
// que el contador la vea, la corrija a mano si quedó mal aprendida, o
// la aprenda desde cero sin esperar a guardar otra factura (pantalla
// Configuración -- "Tarifas aprendidas por proveedor").
app.get('/api/tarifas-aprendidas', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nit_proveedor, categoria, tarifa, veces_confirmado, updated_at
       FROM tarifa_proveedor_aprendida WHERE contador_id = $1 ORDER BY updated_at DESC`,
      [req.firmaId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo tarifas aprendidas:', err);
    res.status(500).json({ error: 'No se pudieron leer las tarifas aprendidas.' });
  }
});

// Crear/corregir a mano una tarifa aprendida -- mismo upsert que
// guardarTarifaProveedor() (auto-aprendizaje al guardar una factura),
// pero disparado por el contador desde Configuración en vez de
// inferirse de un Rete Fuente guardado. `veces_confirmado` se reinicia
// a 1 en una creación manual nueva (no hay un conflicto todavía); si ya
// existía, el ON CONFLICT la trata igual que una reconfirmación más.
app.post('/api/tarifas-aprendidas', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const nitProveedor = String(req.body.nit_proveedor || '').trim();
    const categoria = String(req.body.categoria || '').trim().toLowerCase();
    const tarifa = Number(req.body.tarifa);

    if (!nitProveedor) return res.status(400).json({ error: 'Falta el NIT/cédula del proveedor.' });
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría.' });
    if (!Number.isFinite(tarifa) || tarifa < 0 || tarifa > 1) return res.status(400).json({ error: 'La tarifa debe ser un número entre 0 y 1 (ej. 0.04 para 4%).' });

    const { rows } = await pool.query(
      `INSERT INTO tarifa_proveedor_aprendida (id, contador_id, nit_proveedor, categoria, tarifa, veces_confirmado)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (contador_id, nit_proveedor, categoria)
       DO UPDATE SET tarifa = EXCLUDED.tarifa, veces_confirmado = tarifa_proveedor_aprendida.veces_confirmado + 1, updated_at = now()
       RETURNING id, nit_proveedor, categoria, tarifa, veces_confirmado, updated_at`,
      [crypto.randomUUID(), req.firmaId, nitProveedor, categoria, tarifa]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error guardando tarifa aprendida:', err);
    res.status(500).json({ error: 'No se pudo guardar la tarifa aprendida.' });
  }
});

// Corregir una tarifa aprendida existente -- ej. se aprendió mal (un
// error de digitación en una factura anterior coincidió por casualidad
// con la tarifa alta) y el contador la quiere dejar en el valor
// correcto sin borrar el historial de veces_confirmado.
app.put('/api/tarifas-aprendidas/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const tarifa = Number(req.body.tarifa);
    if (!Number.isFinite(tarifa) || tarifa < 0 || tarifa > 1) return res.status(400).json({ error: 'La tarifa debe ser un número entre 0 y 1 (ej. 0.04 para 4%).' });

    const { rows } = await pool.query(
      `UPDATE tarifa_proveedor_aprendida SET tarifa = $1, updated_at = now()
       WHERE id = $2 AND contador_id = $3
       RETURNING id, nit_proveedor, categoria, tarifa, veces_confirmado, updated_at`,
      [tarifa, req.params.id, req.firmaId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tarifa aprendida no encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error corrigiendo tarifa aprendida:', err);
    res.status(500).json({ error: 'No se pudo corregir la tarifa aprendida.' });
  }
});

// Olvidar una tarifa aprendida -- ej. el proveedor cambió de condición
// (pasó a declarar renta, o dejó de hacerlo) y lo aprendido antes ya no
// aplica; sin esto, calcularRetencionSugerida() seguiría usando el
// valor viejo indefinidamente en vez de volver a mostrar el rango.
app.delete('/api/tarifas-aprendidas/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tarifa_proveedor_aprendida WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.firmaId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Tarifa aprendida no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando tarifa aprendida:', err);
    res.status(500).json({ error: 'No se pudo eliminar la tarifa aprendida.' });
  }
});

// Acumulado anual pagado a un proveedor en una categoría de
// criterioTarifa:'acumulado_anual' (hoy, solo honorarios_natural -- ver
// TARIFAS_RETENCION en public/retenciones.js). Escanear/Carga masiva
// llaman esto ANTES de calcular la retención de una factura de esa
// categoría, para que calcularRetencionCategoriaLinea() pueda resolver
// sola si aplica 10% u 11% (Decreto 1625/2016 art. 1.2.4.3.1: el corte
// es el monto pagado en el año, no si el proveedor declara renta o no).
//
// Suma TODAS las facturas ya guardadas de este contador para ese NIT,
// en el mismo año de `anio`, usando montoCategoriaEnFactura() -- la
// MISMA función (misma precedencia desglose/cabecera) que ya usa
// calcularRetencionSugerida() para mostrarle al contador cuánto de esa
// categoría hay en cada factura, así que lo que se acumula aquí es
// exactamente lo mismo que el contador ya ve factura por factura.
//
// `excluir_id` es opcional -- pásalo cuando se está editando/revisando
// una factura que YA se guardó antes (ej. desde Facturas), para no
// contarla dos veces (una como "acumulado previo" y otra como el pago
// de hoy).
app.get('/api/acumulado-categoria', requireAuth, async (req, res) => {
  const nit = String(req.query.nit || '').trim();
  const categoria = String(req.query.categoria || '').trim().toLowerCase();
  const anio = Number(req.query.anio);
  const excluirId = req.query.excluir_id ? String(req.query.excluir_id) : null;

  if (!nit || !categoria || !anio) {
    return res.status(400).json({ error: 'Falta nit, categoria o anio.' });
  }
  if (!esCategoriaCriterioAcumulado(categoria)) {
    // No es un error del contador -- es que esta ruta no aplica para
    // otras categorías (declarante/no declarante, o tarifa fija). Se
    // devuelve 0 en vez de un error para que el front-end no tenga que
    // saber de antemano cuáles categorías usan este criterio.
    return res.json({ acumulado: 0, aplica: false });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, valor_sin_iva, categoria_concepto, desglose_categorias, fecha_factura
       FROM invoices WHERE contador_id = $1 AND nit_cc = $2`,
      [req.firmaId, nit]
    );
    let acumulado = 0;
    for (const row of rows) {
      if (excluirId && String(row.id) === excluirId) continue;
      if (anioDeFechaFactura(row.fecha_factura) !== anio) continue;
      acumulado += montoCategoriaEnFactura(row, categoria);
    }
    res.json({ acumulado, aplica: true });
  } catch (err) {
    console.error('Error calculando acumulado por categoría:', err);
    res.status(500).json({ error: 'No se pudo calcular el acumulado del año para este proveedor.' });
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
        [req.body.cliente_id, req.firmaId]
      );
      if (clienteRes.rows.length === 0) {
        return res.status(400).json({ error: 'El cliente indicado no existe o no te pertenece.' });
      }
    }
    if (req.body.tarifa_ica_id) {
      const tarifaRes = await pool.query(
        'SELECT 1 FROM tarifas_ica WHERE id = $1 AND contador_id = $2',
        [req.body.tarifa_ica_id, req.firmaId]
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
      const existente = await buscarFacturaPorHash(req.firmaId, req.body.file_hash);
      if (existente) {
        return res.status(409).json({
          error: 'Este documento ya se había guardado antes -- no se guardó de nuevo para evitar un duplicado.',
          duplicado: true,
          factura_existente: existente,
        });
      }
    }

    // Misma regla que ya usa generarAsientoEgreso() (tolerancia $1) --
    // se calcula UNA vez aquí, aparte de esa función, para que quede
    // guardada de forma permanente en la factura misma (columna
    // valores_descuadrados) y no dependa de que se llegue a generar un
    // asiento para que el problema quede registrado en algún lado. Solo
    // se evalúa si ambos valores base están presentes -- una factura sin
    // valor_sin_iva o sin valor_con_iva ya se rechaza antes por otro
    // motivo (campo obligatorio vacío), no hace falta duplicarlo aquí.
    const sinIvaGuardado = Number(req.body.valor_sin_iva) || 0;
    const ivaGuardado = Number(req.body.valor_iva) || 0;
    const conIvaGuardado = Number(req.body.valor_con_iva) || 0;
    const valoresDescuadrados = sinIvaGuardado > 0 && conIvaGuardado > 0 &&
      Math.abs(sinIvaGuardado + ivaGuardado - conIvaGuardado) > 1;

    const id = crypto.randomUUID();
    const values = SAVED_FIELDS.map((key) => {
      const val = req.body[key] ?? '';
      // cliente_id es de tipo UUID en la base de datos -- una cadena vacía
      // rompería la inserción, así que se convierte a NULL cuando no hay cliente.
      if (key === 'cliente_id') return val === '' ? null : val;
      // tarifa_ica_id es de tipo UUID igual que cliente_id -- mismo tratamiento.
      if (key === 'tarifa_ica_id') return val === '' ? null : val;
      // Estos campos son de tipo BOOLEAN -- convertir explícitamente.
      if (key === 'regimen_simple' || key === 'autorretenedor' || key === 'saldo_vencido_detectado' || key === 'anticipo_detectado') {
        return val === true || val === 'true';
      }
      // confianza_campos es un objeto {campo: 0-1} -- se guarda como TEXT
      // (igual que desglose_categorias), así que si llega como objeto
      // (ej. reenviado tal cual vino de /api/extract) se serializa aquí;
      // si ya llega como texto (JSON.stringify hecho en el navegador), se
      // deja igual.
      if (key === 'confianza_campos') {
        return typeof val === 'string' ? val : JSON.stringify(val || {});
      }
      return val;
    });
    const columns = [...SAVED_FIELDS, 'contador_id', 'valores_descuadrados'].join(', ');
    const placeholders = [...SAVED_FIELDS, 'contador_id', 'valores_descuadrados'].map((_, i) => `$${i + 2}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO invoices (id, ${columns}) VALUES ($1, ${placeholders}) RETURNING *`,
      [id, ...values, req.firmaId, valoresDescuadrados]
    );

    // Si el contador cambió la categoría que la IA sugirió, lo
    // guardamos como una corrección -- la próxima vez que aparezca un
    // concepto parecido, se la aplicamos sola, sin que tenga que
    // corregirla de nuevo. No bloquea el guardado si esto falla.
    const categoriaOriginal = req.body.categoria_concepto_ia || '';
    const categoriaFinal = req.body.categoria_concepto || '';
    if (categoriaOriginal && categoriaFinal && categoriaOriginal !== categoriaFinal) {
      try {
        await guardarCorreccion(req.firmaId, req.body.concepto || '', categoriaFinal);
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
          await guardarTarifaProveedor(req.firmaId, nitProveedorGuardado, categoriaGuardada, tarifaDetectada);
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
              (id, invoice_id, contador_id, orden, descripcion, cantidad, valor_unitario, subtotal, categoria_concepto, subcuenta_gasto, valor_iva, iva_mayor_valor, aiu)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              crypto.randomUUID(), id, req.firmaId, orden++,
              String(item.descripcion ?? ''), String(item.cantidad ?? ''), String(item.valor_unitario ?? ''),
              String(item.subtotal ?? ''), String(item.categoria_concepto ?? '').toLowerCase(),
              String(item.subcuenta_gasto ?? ''), String(item.valor_iva ?? ''),
              item.iva_mayor_valor === true || item.iva_mayor_valor === 'true',
              String(item.aiu ?? ''),
            ]
          );
        }
      } catch (err) {
        console.error('No se pudieron guardar los ítems de la factura:', err.message);
      }
    }

    // Propone el asiento contable de esta factura (solo egresos por
    // ahora, ver asientos.js) -- nunca bloquea ni cambia la respuesta
    // del guardado si falla o si todavía no hay suficiente información.
    await generarYGuardarAsientoParaFactura(req.firmaId, rows[0]);

    const respuesta = rowToInvoice(rows[0]);
    // La factura SÍ se guarda aunque los valores no cuadren (nunca se
    // bloquea el guardado por esto -- es el contador quien decide si
    // corrige o la deja así) -- pero la respuesta siempre lo dice
    // explícitamente, para que quien llame a este endpoint (Escanear,
    // Carga Masiva, o cualquier otro futuro) no tenga que adivinar por
    // qué esta factura en particular no tiene asiento propuesto.
    if (valoresDescuadrados) {
      respuesta.advertencia = 'Se guardó, pero "Valor sin IVA + IVA" no coincide con "Valor con IVA" -- por eso no se generó un asiento contable automático. Corrige los valores o marca esta factura para revisarla después.';
    }
    res.status(201).json(respuesta);
  } catch (err) {
    console.error('Error guardando factura:', err);
    res.status(500).json({ error: 'No se pudo guardar la factura.' });
  }
});

// Eliminar una factura guardada (solo si es de este contador)
app.delete('/api/invoices/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM invoices WHERE id = $1 AND contador_id = $2', [req.params.id, req.firmaId]);
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
    values.push(req.params.id, req.firmaId);
    const { rows } = await pool.query(
      `UPDATE invoices SET ${sets.join(', ')} WHERE id = $${i} AND contador_id = $${i + 1} RETURNING *`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada o no te pertenece.' });
    }
    // Los 3 valores de retención son justo lo que decide cuánto se le
    // acredita a cada cuenta de retención por pagar en el asiento -- si
    // cambiaron, la propuesta anterior (si no estaba aprobada todavía)
    // queda desactualizada y hay que regenerarla.
    await generarYGuardarAsientoParaFactura(req.firmaId, rows[0]);
    res.json(rowToInvoice(rows[0]));
  } catch (err) {
    console.error('Error actualizando retención de factura:', err);
    res.status(500).json({ error: 'No se pudo actualizar la factura.' });
  }
});

// El contador aprueba una factura ya revisada -- separado a propósito
// de la aprobación del asiento (arriba) y de la tarifa aprendida: son
// tres decisiones distintas que hoy viven en pantallas distintas (ver
// hoja de ruta, Fase 2), aunque terminen unificándose en una sola
// pantalla de revisión más adelante. Como con los asientos, nunca es
// automático ni se puede desaprobar desde acá -- si el contador se
// equivocó, corrige los datos primero (PUT de arriba) y aprueba de nuevo
// cuando esté conforme.
app.post('/api/invoices/:id/aprobar', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const factura = await pool.query(
      'SELECT id, aprobado_por_contador FROM invoices WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.firmaId]
    );
    if (factura.rows.length === 0) return res.status(404).json({ error: 'Factura no encontrada.' });
    if (factura.rows[0].aprobado_por_contador) {
      return res.status(400).json({ error: 'Esta factura ya estaba aprobada.' });
    }

    const { rows } = await pool.query(
      `UPDATE invoices SET aprobado_por_contador = true, aprobado_at = now() WHERE id = $1 RETURNING id, aprobado_por_contador, aprobado_at`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error aprobando factura:', err);
    res.status(500).json({ error: 'No se pudo aprobar la factura.' });
  }
});

// Ítems línea por línea de una factura (Fase 4) -- ownership por el
// contador_id guardado en cada ítem, no hace falta el join con invoices.
app.get('/api/invoices/:id/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM factura_items WHERE invoice_id = $1 AND contador_id = $2 ORDER BY orden ASC',
      [req.params.id, req.firmaId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando ítems de factura:', err);
    res.status(500).json({ error: 'No se pudieron cargar los ítems de la factura.' });
  }
});

// ---------- Motor contable mínimo: plan de cuentas + asientos ----------

// El plan de cuentas de este contador -- lo siembra si todavía no tiene
// ninguna fila (contador que existía antes de este cambio, o algo falló
// al crear la cuenta). Ordenado por código para que se vea como un
// plan de cuentas de verdad, no como una lista sin orden.
app.get('/api/plan-cuentas', requireAuth, async (req, res) => {
  try {
    const existe = await pool.query('SELECT 1 FROM plan_cuentas WHERE contador_id = $1 LIMIT 1', [req.firmaId]);
    if (existe.rows.length === 0) await asegurarPlanCuentasContador(req.firmaId);
    const { rows } = await pool.query(
      'SELECT codigo, nombre, naturaleza, clase, activa FROM plan_cuentas WHERE contador_id = $1 ORDER BY codigo',
      [req.firmaId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando el plan de cuentas:', err);
    res.status(500).json({ error: 'No se pudo cargar el plan de cuentas.' });
  }
});

// Lista los asientos de este contador -- opcionalmente filtrados por
// estado (?estado=propuesto o ?estado=aprobado) o por factura
// (?invoice_id=...). Sin filtro, los más recientes primero -- así la
// bandeja de "por aprobar" (estado=propuesto) es la vista que más se va
// a usar en el día a día.
app.get('/api/asientos', requireAuth, async (req, res) => {
  try {
    const condiciones = ['contador_id = $1'];
    const valores = [req.firmaId];
    if (req.query.estado) {
      valores.push(req.query.estado);
      condiciones.push(`estado = $${valores.length}`);
    }
    if (req.query.invoice_id) {
      valores.push(req.query.invoice_id);
      condiciones.push(`invoice_id = $${valores.length}`);
    }
    const { rows } = await pool.query(
      `SELECT id, invoice_id, fecha, descripcion, estado, generado_por, aprobado_at, creado_at
       FROM asientos_contables WHERE ${condiciones.join(' AND ')} ORDER BY creado_at DESC`,
      valores
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando asientos:', err);
    res.status(500).json({ error: 'No se pudieron cargar los asientos.' });
  }
});

// Detalle de un asiento -- cabecera + sus líneas de débito/crédito, en
// el orden en que se generaron.
app.get('/api/asientos/:id', requireAuth, async (req, res) => {
  try {
    const cabecera = await pool.query(
      `SELECT id, invoice_id, fecha, descripcion, estado, generado_por, aprobado_at, creado_at
       FROM asientos_contables WHERE id = $1 AND contador_id = $2`,
      [req.params.id, req.firmaId]
    );
    if (cabecera.rows.length === 0) return res.status(404).json({ error: 'Asiento no encontrado.' });
    const lineas = await pool.query(
      'SELECT cuenta_codigo, cuenta_nombre, debito, credito FROM asiento_lineas WHERE asiento_id = $1 ORDER BY orden',
      [req.params.id]
    );
    res.json({ ...cabecera.rows[0], lineas: lineas.rows });
  } catch (err) {
    console.error('Error cargando el detalle del asiento:', err);
    res.status(500).json({ error: 'No se pudo cargar el asiento.' });
  }
});

// El contador aprueba un asiento propuesto -- lo único que hace pasar
// un asiento de "propuesto" a "aprobado" es esta ruta, nunca algo
// automático. Antes de aprobar, se revalida que debe y haber cuadren
// sobre las líneas YA GUARDADAS (no sobre la factura en este momento,
// que pudo haber cambiado) -- una última red de seguridad antes de
// dejar algo como confirmado.
app.post('/api/asientos/:id/aprobar', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const asiento = await pool.query(
      'SELECT id, estado FROM asientos_contables WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.firmaId]
    );
    if (asiento.rows.length === 0) return res.status(404).json({ error: 'Asiento no encontrado.' });
    if (asiento.rows[0].estado === 'aprobado') {
      return res.status(400).json({ error: 'Este asiento ya estaba aprobado.' });
    }

    const lineas = await pool.query('SELECT debito, credito FROM asiento_lineas WHERE asiento_id = $1', [req.params.id]);
    const debe = lineas.rows.reduce((s, l) => s + Number(l.debito), 0);
    const haber = lineas.rows.reduce((s, l) => s + Number(l.credito), 0);
    if (Math.abs(debe - haber) > 1) {
      return res.status(400).json({ error: 'Este asiento no cuadra (débito y crédito no son iguales) -- no se puede aprobar así.' });
    }

    const { rows } = await pool.query(
      `UPDATE asientos_contables SET estado = 'aprobado', aprobado_at = now() WHERE id = $1 RETURNING id, estado, aprobado_at`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error aprobando asiento:', err);
    res.status(500).json({ error: 'No se pudo aprobar el asiento.' });
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
      [req.firmaId]
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
// de su PROPIA cuenta algo que Enlaza no puede adivinar (ej. qué
// tipo de comprobante y qué forma de pago usar). Si el adaptador
// declara `obtenerOpcionesConfiguracion` y todavía no llegó una
// `configuracion` válida en el body, esta ruta responde con las
// opciones reales de esa cuenta SIN guardar nada -- el frontend las
// muestra, el contador elige, y se vuelve a llamar esta misma ruta ya
// con `configuracion` incluida para guardar todo junto.
app.post('/api/integraciones/:proveedor/conectar', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
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
      [id, req.firmaId, proveedor, email, tokenCifrado, configuracionTexto]
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
app.delete('/api/integraciones/:proveedor', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM integraciones_contables WHERE contador_id = $1 AND proveedor = $2',
      [req.firmaId, req.params.proveedor]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'No tenías esa integración conectada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error desconectando integración:', err.message);
    res.status(500).json({ error: 'No se pudo desconectar.' });
  }
});

// Envía una factura YA guardada en Enlaza hacia el software contable
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
    const facturaRes = await pool.query('SELECT * FROM invoices WHERE id = $1 AND contador_id = $2', [id, req.firmaId]);
    if (facturaRes.rows.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada.' });
    }
    const factura = facturaRes.rows[0];

    const integracionRes = await pool.query(
      'SELECT email, token_cifrado, configuracion FROM integraciones_contables WHERE contador_id = $1 AND proveedor = $2 AND activo = true',
      [req.firmaId, proveedor]
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
      [req.firmaId, proveedor]
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

// Misma idea que llamarGeminiJSON, pero para una conversación de texto
// simple (sin archivo adjunto, sin esperar JSON de vuelta) -- la usa el
// chatbot de soporte. `historial` es un arreglo de { rol: 'usuario'|'bot',
// texto } para que la IA tenga contexto de los últimos mensajes.
async function llamarGeminiChat(systemPrompt, historial, mensajeNuevo) {
  const contents = [];
  (historial || []).slice(-8).forEach((turno) => {
    contents.push({
      role: turno.rol === 'bot' ? 'model' : 'user',
      parts: [{ text: turno.texto }],
    });
  });
  contents.push({ role: 'user', parts: [{ text: mensajeNuevo }] });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('Error de Gemini API (chat):', response.status, errText);
    const err = new Error(errText);
    err.status = response.status;
    err.publicMessage = 'No se pudo conectar con el asistente en este momento. Intenta de nuevo en un momento.';
    throw err;
  }

  const data = await response.json();
  const textOut = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOut) {
    const err = new Error('Gemini no devolvió texto.');
    err.status = 500;
    err.publicMessage = 'El asistente no pudo generar una respuesta. Intenta reformular la pregunta.';
    throw err;
  }
  return textOut.trim();
}

const SOPORTE_CHAT_PROMPT = `Eres el asistente de soporte de Enlaza, una aplicación colombiana para contadores independientes que escanea facturas y cuentas de cobro con IA, calcula retenciones, y organiza la contabilidad de sus clientes.

Tu trabajo es ser la PRIMERA capa de soporte -- responder dudas rápidas sobre cómo usar la aplicación, y explicar mensajes de error comunes -- ANTES de que el contador tenga que escribirle a soporte humano.

CÓMO ESTÁ ORGANIZADA LA APLICACIÓN (para que sepas de qué hablar):
- Lobby (inicio): lista de clientes del contador, con sus estadísticas básicas. Al elegir uno, todo lo demás queda filtrado a ese cliente.
- Escanear: subir o fotografiar una factura o cuenta de cobro para que la IA la lea.
- Facturas: historial de todo lo guardado, organizado por mes, con filtros.
- Kárdex: historial y saldo acumulado por proveedor.
- Clientes: donde se registran las empresas que atiende el contador (no los proveedores).
- Carga masiva: subir varias facturas de una vez (incluye .zip).
- Ingresos / Egresos / Balance: estadísticas y gráficas.
- Cartera: conciliación bancaria -- sube el extracto del banco y el sistema sugiere qué pagos corresponden a qué facturas pendientes.
- Integraciones: conexión con software contable externo (por ahora, Alegra).

ERRORES COMUNES Y QUÉ SIGNIFICAN:
- "Error 403" o "No se pudo verificar la sesión": la sesión expiró, o se perdió la cookie de inicio de sesión. Solución: cerrar sesión y volver a entrar con Google.
- "Este archivo no parece ser una factura de venta ni una cuenta de cobro": el sistema solo procesa esos 2 tipos de documento a propósito -- cualquier otro (extractos, comprobantes de pago, cotizaciones) se rechaza automáticamente, no es un error del sistema.
- Un aviso amarillo de "posible error de digitación": el sistema comparó el valor de retención escrito contra las tarifas típicas y no coincide -- vale la pena revisar el documento original.
- "No se pudieron leer las facturas" o error 500: normalmente es un problema temporal de conexión -- sugiere recargar la página o intentar en un momento.

REGLAS IMPORTANTES QUE SIEMPRE DEBES SEGUIR:
1. Responde siempre en español, con un tono cercano y claro -- como el resto de la aplicación (nunca uses jerga técnica sin explicarla).
2. Responde corto -- 2 a 4 frases normalmente, no un ensayo. El contador está buscando ayuda rápida, no un documento.
3. NUNCA das asesoría tributaria específica (no calcules ni confirmes si a un cliente le corresponde una retención particular, ni interpretes normas). Para eso, remite a que confirme con su propio criterio profesional o su contador -- tú solo explicas CÓMO FUNCIONA la aplicación, no qué dice la ley en su caso.
4. Si la pregunta es sobre algo que de verdad no puedes resolver (un bug real, algo que suena a error del servidor, o algo muy específico de su cuenta), dilo con honestidad y sugiere que hable directo con soporte humano por WhatsApp -- justo debajo de tu respuesta le va a aparecer un botón para eso, así que NUNCA inventes un correo, un formulario, un "chat en vivo" en otra esquina de la página, ni ningún otro canal de contacto -- solo di algo como "contacta a soporte humano por WhatsApp" y confía en que el botón aparece solo.
5. Nunca inventes funciones que la aplicación no tiene, ni canales de contacto (correos, formularios, chats) que no existen.`;

app.post('/api/soporte-chat', requireAuth, limitadorIA, async (req, res) => {
  const { mensaje, historial } = req.body;
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
    return res.status(400).json({ error: 'Escribe una pregunta antes de enviar.' });
  }
  if (mensaje.length > 1000) {
    return res.status(400).json({ error: 'El mensaje es demasiado largo -- intenta resumirlo.' });
  }
  try {
    const respuesta = await llamarGeminiChat(SOPORTE_CHAT_PROMPT, historial, mensaje.trim());
    res.json({ respuesta });
  } catch (err) {
    console.error('Error en chat de soporte:', err);
    res.status(err.status || 500).json({ error: err.publicMessage || 'No se pudo responder en este momento.' });
  }
});

// Bloque de criterios para distinguir los tres tipos de documento
// causables -- compartido, sin cambios, entre INVOICE_PROMPT (un solo
// documento por archivo) y PAQUETE_PROMPT (el archivo puede traer
// varios documentos distintos): así nunca se desalinean los criterios
// entre los dos casos.
const CRITERIOS_IDENTIFICACION_DOCUMENTO = `CÓMO IDENTIFICAR CADA TIPO (usa estas señales, no solo el título del documento):

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

FACTURA DE SERVICIOS PÚBLICOS DOMICILIARIOS -- tipo_documento = "factura_servicios_publicos":
- Es la factura periódica (mensual) de una empresa de servicios públicos: acueducto, alcantarillado, energía eléctrica, gas natural, aseo/recolección de basuras, o una combinación de varias en un mismo documento (ej. EPM, Enel-Codensa, Vanti, Aguas de ..., Enviaseo).
- Suele decir "Documento Equivalente Electrónico" o traer el nombre de la empresa prestadora de forma muy prominente (logo grande), un "período facturado", lecturas de medidor (actual/anterior) o consumos en m³/kWh, y un "Total a pagar".
- Identifica al usuario/suscriptor que paga (con NIT o cédula) y a la empresa prestadora (con su propio NIT), aunque no siempre discrimine IVA como una factura de venta común -- muchos de estos servicios son excluidos de IVA.
- A menudo aclara en letra pequeña que la empresa es "Autorretenedor" (de renta y/o de ICA) -- eso es clave para el campo "autorretenedor" más abajo.

CUALQUIER OTRO DOCUMENTO -- tipo_documento = "otro" (SIEMPRE rechazar, documento_valido debe ser false), por ejemplo:
- Comprobantes o recibos de pago, soportes o confirmaciones de transferencia bancaria, extractos bancarios.
- Cotizaciones, proformas, órdenes de compra o remisiones sin valor fiscal.
- Contratos, recibos de consignación, tickets no fiscales, reportes o resúmenes de pagos.
- Capturas de pantalla de apps de pago, comprobantes de Nequi/Daviplata/PSE, o cualquier documento que no sea una factura de venta, una cuenta de cobro, ni una factura de servicios públicos.

Si tienes dudas genuinas entre estos tres tipos válidos, elige el que mejor encaje y sigue adelante -- el rechazo (tipo_documento = "otro") es solo para documentos que claramente NO son ninguno de los tres.`;

// El objeto de campos a extraer POR CADA documento -- también
// compartido entre INVOICE_PROMPT y PAQUETE_PROMPT por la misma razón:
// un documento individual dentro de un paquete se lee EXACTAMENTE con
// las mismas reglas que un documento que llega solo.
const CAMPOS_FACTURA_JSON = `{
  "tipo_documento": "'factura_venta' si es una factura de venta (electrónica o física), 'cuenta_cobro' si es una cuenta de cobro, 'factura_servicios_publicos' si es una factura de servicios públicos domiciliarios (agua/energía/gas/aseo), 'otro' para cualquier otro documento (comprobantes de pago, extractos, cotizaciones, contratos, etc.) -- ver criterios arriba",
  "documento_valido": "true SOLO si tipo_documento es 'factura_venta', 'cuenta_cobro' o 'factura_servicios_publicos'. false para 'otro'",
  "motivo_rechazo": "si documento_valido es false, una frase breve en español explicando qué parece ser el documento en su lugar (ej: 'Este documento parece ser un comprobante de transferencia bancaria, no una factura ni una cuenta de cobro'). Si documento_valido es true, cadena vacía",
  "tipo_doc": "13 si el proveedor se identifica con cédula, 31 si es NIT. Si no es claro, usa el que aplique según el número.",
  "nit_cc": "número de identificación (NIT o cédula) del proveedor/emisor, solo dígitos. Hay documentos reales que NO traen este número (ej. cuentas de cobro de una propiedad horizontal/conjunto residencial, donde en vez de un NIT aparece algo como 'Propiedad Horizontal' o el nombre del edificio) -- en esos casos deja este campo como cadena vacía. Nunca inventes un número ni tomes prestado uno de otra parte del documento (el consecutivo de la cuenta de cobro, la fecha, el NIT del adquiriente, etc.) -- si no hay un número de identificación real y propio del emisor, va vacío.",
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
  "autorretenedor": "true si el documento menciona explícitamente que el emisor es 'Autorretenedor' (de renta y/o de ICA) -- es muy común en facturas de servicios públicos (EPM y similares suelen imprimirlo en letra pequeña cerca del NIT del emisor, ej. 'Autorretenedor Renta -- Res. ...'). false en cualquier otro caso, incluido cuando no estés seguro. Cuando es true, el comprador NO debe practicar retención en la fuente ni ReteICA sobre esta factura -- el proveedor ya se autorretiene y se la gira directamente a la DIAN/municipio.",
  "saldo_vencido_detectado": "true SOLO si el documento muestra explícitamente un 'saldo vencido', 'deuda anterior', 'saldo anterior pendiente' o similar (frecuente en facturas de servicios públicos que arrastran periodos sin pagar) -- es decir, el 'total a pagar' del documento incluye algo más que el consumo/servicio de ESTE periodo. false en cualquier otro caso, incluido cuando no estés seguro. No cambia ningún valor extraído -- solo avisa al contador para que revise si ese saldo anterior ya fue pagado antes de registrar el gasto.",
  "anticipo_detectado": "true SOLO si el documento menciona explícitamente un anticipo o avance ya entregado/descontado (ej. 'anticipo del 50% ya cancelado', 'menos avance recibido'). false en cualquier otro caso, incluido cuando no estés seguro. No cambia ningún valor extraído -- solo avisa al contador para que revise si el total de la factura ya descuenta ese anticipo.",
  "valor_abonado_detectado": "SOLO si el documento indica un valor EXACTO ya abonado/anticipado/pagado sobre el total (ej. 'de los cuales se han abonado $20.000.000', 'anticipo recibido: $5.000.000'), ese valor en pesos ENTEROS. Si el documento menciona un anticipo pero SIN dar el valor exacto, o no menciona ningún abono, usa 0 -- no calcules ni asumas un porcentaje.",
  "valor_letras_texto": "el valor total de la factura (el mismo que valor_con_iva) tal como aparece escrito EN PALABRAS/LETRAS en el documento (ej. 'Setenta y dos millones novecientos ochenta y cuatro mil quinientos setenta y ocho pesos M/CTE'), copiado tal cual. Muchas cuentas de cobro y facturas físicas lo traen debajo o al lado del valor en números. Si el documento NO escribe el valor en letras en ninguna parte, deja una cadena vacía -- no lo inventes.",
  "valor_letras_numero": "SOLO si llenaste valor_letras_texto: convierte ESAS PALABRAS a un número entero (ej. si el texto dice 'un millón cien mil pesos', este campo es 1100000), para que el sistema pueda comparar si coincide con el valor en números del documento -- esto es clave porque a veces el valor escrito en letras NO coincide con el valor escrito en números (un error de digitación o de imprenta en el documento original), y detectar esa diferencia es importante. Conviértelo con cuidado, palabra por palabra, sin asumir que necesariamente es igual a valor_con_iva. Si valor_letras_texto quedó vacío, usa 0 en este campo.",
  "categoria_concepto": "clasifica el concepto de la factura en UNA de estas categorías oficiales de retención en la fuente de la DIAN (usa exactamente uno de estos valores, en minúsculas): 'compras' (bienes/productos físicos generales, ej. útiles, insumos, mercancía), 'compras_tarjeta' (SOLO si el documento indica explícitamente que se pagó con tarjeta débito o crédito), 'servicios' (mano de obra operativa sin título profesional, ej. limpieza general, mantenimiento), 'honorarios_juridica' (servicio profesional facturado por una persona jurídica/empresa, ej. una firma de asesoría), 'honorarios_natural' (servicio profesional facturado por una persona natural con título, ej. un contador o abogado independiente), 'arrendamiento_muebles' (alquiler de equipos, vehículos, maquinaria), 'arrendamiento_inmuebles' (alquiler de local, oficina o bodega), 'transporte_carga' (transporte de mercancía/carga), 'transporte_pasajeros' (transporte terrestre de personas), 'licenciamiento_software' (licencias o derecho de uso de software), 'vigilancia_aseo' (servicios de vigilancia o aseo prestados por una empresa especializada), 'servicios_temporales' (suministro de personal temporal por una Empresa de Servicios Temporales -- EST -- legalmente constituida, distinto de una simple prestación de servicios), 'hoteles_restaurantes' (alojamiento o alimentación), 'servicios_publicos' (usa SIEMPRE esta categoría cuando tipo_documento es 'factura_servicios_publicos', sin importar cuántos servicios distintos venga combinando el documento -- acueducto, alcantarillado, energía, aseo, etc. son todos 'servicios_publicos'), 'otro' (si no encaja claramente en ninguna). Elige la que mejor describa la naturaleza real de lo facturado, no solo el nombre del producto.",
  "desglose_categorias": "IMPORTANTE: revisa la tabla de ítems de la factura línea por línea. Si TODOS los ítems son de la misma naturaleza (ej. todos productos, o todo un solo servicio), deja este campo como un objeto vacío {}. Si la factura mezcla ítems de naturaleza distinta (ej. productos Y mano de obra/servicio en la misma factura, como suele pasar en talleres, ferreterías o mantenimiento), agrupa el subtotal (sin IVA) de cada ítem según su categoría real (usa las mismas categorías del campo categoria_concepto) y devuelve un objeto JSON con cada categoría encontrada y la suma de sus ítems, ej: {\"compras\": 442000, \"servicios\": 140000}. La suma de todos los valores del objeto debe ser igual al subtotal total de la factura (valor_sin_iva). Nunca inventes una categoría que no tenga ítems reales detrás.",
  "items": "El desglose línea por línea COMPLETO de la factura -- un arreglo con CADA ítem real que aparece en la tabla de productos/servicios del documento, sin resumir ni agrupar. Cada elemento del arreglo debe tener esta forma: {\"descripcion\": \"texto breve del ítem tal como aparece\", \"cantidad\": cantidad si aparece (número), o cadena vacía si no aparece, \"valor_unitario\": valor unitario en pesos ENTEROS si aparece, o 0 si no aparece, \"subtotal\": subtotal de ESA línea SIN IVA, en pesos ENTEROS (regla de formato de más abajo), \"categoria_concepto\": clasifica ESTE ítem puntual en UNA de las mismas categorías oficiales de retención listadas en el campo categoria_concepto de arriba (usa exactamente uno de esos valores, en minúsculas), según la naturaleza real de ESE ítem, no de la factura completa, \"aiu\": SOLO si categoria_concepto de ESTE ítem es 'vigilancia_aseo' o 'servicios_temporales' Y el documento desglosa explícitamente el componente de AIU (Administración + Imprevistos + Utilidad, a veces solo 'utilidad' o escrito como 'AIU') para esa línea, el valor de ese componente en pesos ENTEROS -- cadena vacía en cualquier otro caso, incluyendo cuando no estés seguro (la mayoría de facturas de este tipo NO desglosan el AIU, y no hay que inventarlo)}. La suma de todos los \"subtotal\" del arreglo debe ser igual (o muy cercana, por redondeo) al valor_sin_iva total de la factura. Si el documento NO trae una tabla de ítems detallada (ej. una cuenta de cobro con un solo concepto global, sin líneas separadas), devuelve un arreglo con UN SOLO elemento que represente el total de la factura, usando el mismo concepto y la misma categoria_concepto que ya extrajiste arriba (y el mismo criterio de \"aiu\" si aplica). EXCEPCIÓN -- factura de servicios públicos: cuando tipo_documento es 'factura_servicios_publicos' y el documento combina varios servicios (ej. acueducto + alcantarillado + energía + aseo, cada uno con su propio subtotal), NO los separes en varios ítems -- devuelve siempre un arreglo con UN SOLO elemento por el valor TOTAL de la factura (todos los servicios sumados), \"descripcion\": 'Servicios públicos' seguido de cuáles servicios incluye (ej. 'Servicios públicos (acueducto, alcantarillado, energía, aseo)'), \"categoria_concepto\": 'servicios_publicos'. Nunca inventes ítems que no estén realmente en el documento.",
  "confianza_campos": "un objeto con un puntaje de confianza NUMÉRICO de 0 a 1 (nunca texto) para cada uno de estos campos, indicando qué tan seguro estás de haber leído ESE dato correctamente en el documento -- 1 significa perfectamente legible y sin ambigüedad, 0.5 dudoso o parcialmente ilegible (ej. una cifra borrosa, un NIT con un dígito que podría ser 3 u 8), 0 no pudiste leerlo y lo dejaste vacío o en 0. Incluye exactamente estas claves: nit_cc, nombre_razon_social, fecha_factura, valor_sin_iva, valor_iva, valor_con_iva, rete_fuente, rete_iva, rete_ica, categoria_concepto. Ejemplo: {\"nit_cc\": 0.95, \"nombre_razon_social\": 1, \"fecha_factura\": 0.6, \"valor_sin_iva\": 1, \"valor_iva\": 1, \"valor_con_iva\": 1, \"rete_fuente\": 0.4, \"rete_iva\": 1, \"rete_ica\": 1, \"categoria_concepto\": 0.8}. Sé honesto -- si el documento está borroso, mal escaneado, o girado, o un valor no se alcanza a distinguir con certeza, usa un puntaje bajo en vez de fingir seguridad. No bajes el puntaje solo porque tuviste que interpretar el formato (punto/coma) de un valor que sí se lee con claridad."
}`;

// Reglas de formato/validación de valores -- también compartidas, se
// aplican por igual a cada documento, esté solo o dentro de un paquete.
const REGLAS_FORMATO_VALORES = `REGLA DE FORMATO PARA LOS CAMPOS DE VALOR (los 3 de arriba, y también valor_unitario/subtotal de cada ítem del arreglo "items" -- muy importante, es el error más común):
Los documentos colombianos escriben los montos con PUNTO como separador de miles y COMA para los centavos (ej: "39.915,96" significa treinta y nueve mil novecientos quince pesos con noventa y seis centavos). Debes devolver el valor como un ENTERO en pesos, redondeando los centavos, SIN puntos, SIN comas, SIN concatenar los dígitos tal cual aparecen escritos.

Ejemplo correcto: si el documento muestra "39.915,96", el JSON debe llevar 39916 (no 3991596, no 39915.96, no 39915).
Ejemplo correcto: si el documento muestra "210.084,00", el JSON debe llevar 210084.
Ejemplo correcto: si el documento muestra "1.487.500", el JSON debe llevar 1487500.

Muchas facturas electrónicas colombianas incluyen una sección "Retenciones" o "Valores informativos" con Rete fuente, Rete IVA y Rete ICA (casi siempre en 0 si no aplica) — revisa si el documento la tiene antes de responder.

Si algún campo no se puede determinar con certeza, usa una cadena vacía "" para ese campo (excepto valor_iva, rete_fuente, rete_iva y rete_ica, que en ese caso van en 0). No inventes datos. Verifica que valor_sin_iva + valor_iva sea igual (o muy cercano, por redondeo de centavos) a valor_con_iva antes de responder.

Si documento_valido es false (el documento no es factura de venta, cuenta de cobro, ni factura de servicios públicos), igual completa nombre_razon_social y concepto con lo que alcances a leer si es evidente (ayuda a que el contador entienda qué era el archivo), pero deja los campos de valores en 0 y el resto en cadena vacía -- no hace falta forzar una lectura completa de un documento que de todos modos se va a rechazar.`;

const INVOICE_PROMPT = `Eres un asistente contable colombiano. Antes de extraer ningún dato, tu PRIMERA tarea es identificar qué tipo de documento es la imagen o archivo que recibiste, porque Enlaza SOLO debe procesar los tres únicos documentos que se pueden causar contablemente en Colombia: la factura de venta, la cuenta de cobro y la factura de servicios públicos domiciliarios (agua, energía, gas, aseo -- es un "documento equivalente electrónico" con la misma validez legal que una factura, según el artículo 130 de la Ley 142 de 1994). Cualquier otro tipo de documento debe rechazarse, aunque tenga valores y NIT parecidos a una factura.

${CRITERIOS_IDENTIFICACION_DOCUMENTO}

Una vez identificado el tipo, extrae EXACTAMENTE estos campos, devolviendo SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:

${CAMPOS_FACTURA_JSON}

${REGLAS_FORMATO_VALORES}`;

// Prompt para archivos que pueden traer VARIOS documentos distintos
// concatenados en un mismo PDF -- por ejemplo, varias facturas
// escaneadas una tras otra, o una factura seguida de otros soportes.
// Reutiliza EXACTAMENTE los mismos criterios de identificación y el
// mismo esquema de campos que INVOICE_PROMPT (arriba) para que un
// documento no se lea distinto solo por venir acompañado de otros --
// lo único que cambia es que primero hay que SEGMENTAR el archivo en
// documentos individuales, y devolver un arreglo con uno por cada uno.
const PAQUETE_PROMPT = `Eres un asistente contable colombiano. Vas a recibir un archivo (normalmente un PDF) que puede traer UN SOLO documento (el caso más común, incluso si ocupa varias páginas) o VARIOS documentos distintos concatenados uno tras otro en el mismo archivo -- por ejemplo, varias facturas de proveedores distintos escaneadas y unidas en un solo PDF, o una factura seguida de un extracto bancario o de otros soportes.

Tu PRIMERA tarea es SEGMENTAR el archivo: decidir cuántos documentos distintos hay en realidad, antes de extraer ningún dato. Usa estas señales para saber cuándo empieza un documento NUEVO (no bases el corte solo en el número de página):
- Aparece un encabezado o membrete distinto (otro logo, otro nombre de empresa emisora).
- Aparece un NIT/cédula del emisor distinto al del documento anterior.
- Aparece un nuevo consecutivo de factura, CUFE, o número de "Cuenta de Cobro" distinto.
- Aparece una nueva fecha de emisión y un nuevo total a pagar, sin que el documento anterior haya seguido en esa misma página con más ítems de la misma factura.
- Cambia el TIPO de documento (ej. termina una factura y empieza un extracto bancario o un comprobante de pago).

NO cortes un documento en varios solo porque tenga varias páginas: una factura de dos o tres páginas donde la tabla de ítems continúa de una página a la siguiente (mismo emisor, mismo consecutivo, mismo total) sigue siendo UN SOLO documento. La gran mayoría de los archivos que vas a recibir traen un solo documento -- solo segmenta en varios cuando de verdad encuentres las señales de arriba.

Para cada documento que identifiques, decide primero su tipo con el mismo criterio que usarías si viniera solo:

${CRITERIOS_IDENTIFICACION_DOCUMENTO}

Después, para CADA documento que hayas segmentado (esté solo o acompañado de otros), extrae EXACTAMENTE los mismos campos que extraerías si ese documento hubiera llegado solo en su propio archivo -- ni más, ni menos -- con esta forma exacta:

${CAMPOS_FACTURA_JSON}

Incluye en el arreglo TANTO los documentos válidos (factura de venta, cuenta de cobro, factura de servicios públicos) COMO los que hay que rechazar (tipo_documento "otro", documento_valido false) -- no omitas ninguno, el sistema decide después qué hacer con cada uno.

Devuelve SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin backticks, con esta forma exacta:

{
  "documentos": [ /* un elemento con la forma de arriba por cada documento distinto que identificaste, EN EL MISMO ORDEN en que aparecen en el archivo (de principio a fin) */ ]
}

Si el archivo trae un solo documento (el caso más frecuente), "documentos" debe tener exactamente un elemento.

${REGLAS_FORMATO_VALORES}

Aplica estas reglas de formato de forma independiente a CADA documento del arreglo -- los valores de un documento nunca deben mezclarse ni sumarse con los de otro.`;

// Endpoint que recibe el archivo (imagen o PDF) de una factura y llama a la API gratuita de Gemini
// Misma lógica que usaba /api/extract directamente -- ahora vive
// aparte para que el procesamiento en segundo plano de lotes.js
// también pueda usarla, sin duplicar el código.
const TIPOS_DOCUMENTO_VALIDOS = ['factura_venta', 'cuenta_cobro', 'factura_servicios_publicos'];

// Post-procesamiento que se le aplica a CUALQUIER documento ya leído por
// Gemini -- tanto si vino solo (INVOICE_PROMPT) como si es uno de los
// elementos del arreglo que devuelve PAQUETE_PROMPT. Valida el tipo de
// documento, redondea los valores numéricos, y aplica la categoría
// aprendida (si el proveedor ya tiene una corrección guardada). Nunca
// lanza error -- si el documento debe rechazarse, devuelve { ok: false,
// ... } para que cada llamador decida qué hacer con eso (procesar UN
// documento aborta con un 422; procesar un PAQUETE solo marca ESE
// documento puntual como rechazado y sigue con los demás).
// Campos sobre los que le pedimos a Gemini un puntaje de confianza --
// deliberadamente solo los que más le importan al contador para decidir
// si revisar la factura con lupa antes de guardarla (identidad del
// tercero, fecha, y los valores que alimentan directamente el asiento
// contable y las retenciones). No se pide confianza de TODOS los campos
// para no inflar aún más un prompt que ya es largo.
const CAMPOS_CON_CONFIANZA = [
  'nit_cc', 'nombre_razon_social', 'fecha_factura',
  'valor_sin_iva', 'valor_iva', 'valor_con_iva',
  'rete_fuente', 'rete_iva', 'rete_ica', 'categoria_concepto',
];

// Nunca confiar ciegamente en que Gemini devolvió el objeto con la forma
// exacta que se le pidió -- si viene mal formado (falta una clave, un
// valor no numérico, fuera de 0-1), se descarta ESE campo puntual en vez
// de tumbar toda la extracción. Un campo ausente en el resultado final
// significa "sin dato de confianza" (la futura pantalla de revisión no
// debería resaltarlo ni como confiable ni como dudoso).
function sanitizarConfianzaCampos(crudo) {
  const limpio = {};
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return limpio;
  for (const campo of CAMPOS_CON_CONFIANZA) {
    const valor = Number(crudo[campo]);
    if (!isNaN(valor)) limpio[campo] = Math.max(0, Math.min(1, valor));
  }
  return limpio;
}

async function posprocesarDocumentoExtraido(userId, parsed) {
  if (parsed.documento_valido === false || (parsed.tipo_documento && !TIPOS_DOCUMENTO_VALIDOS.includes(parsed.tipo_documento))) {
    const motivo = parsed.motivo_rechazo ? ` ${parsed.motivo_rechazo}.` : '';
    return {
      ok: false,
      tipoDocumento: parsed.tipo_documento || 'desconocido',
      publicMessage: `Este archivo no parece ser una factura de venta, una cuenta de cobro, ni una factura de servicios públicos.${motivo} Enlaza solo procesa esos tres tipos de documento, que son los únicos con validez legal para causar un ingreso o egreso.`,
    };
  }

  for (const key of ['valor_sin_iva', 'valor_iva', 'valor_con_iva', 'rete_fuente', 'rete_iva', 'rete_ica']) {
    if (parsed[key] !== undefined && parsed[key] !== '' && !isNaN(Number(parsed[key]))) {
      parsed[key] = Math.round(Number(parsed[key]));
    }
  }

  parsed.confianza_campos = sanitizarConfianzaCampos(parsed.confianza_campos);

  parsed.categoria_concepto_ia = parsed.categoria_concepto || '';
  try {
    const corregida = await buscarCorreccionAprendida(userId, parsed.concepto);
    if (corregida && corregida !== parsed.categoria_concepto) {
      parsed.categoria_concepto = corregida;
      parsed.categoria_ajustada_por_ti = true;
    }
  } catch (err) {
    console.error('No se pudo revisar correcciones aprendidas:', err.message);
  }

  return { ok: true, data: parsed };
}

async function procesarExtraccionFactura(userId, base64, effectiveMediaType, isPdf, forzar) {
  const fileHash = calcularFileHash(base64);

  if (!forzar) {
    try {
      const existente = await buscarFacturaPorHash(userId, fileHash);
      if (existente) {
        return { duplicado: true, file_hash: fileHash, factura_existente: existente };
      }
    } catch (err) {
      console.error('No se pudo revisar duplicados antes de leer con IA:', err.message);
    }
  }

  const parsed = await llamarGeminiJSON(base64, effectiveMediaType, INVOICE_PROMPT);
  parsed.file_hash = fileHash;

  const resultado = await posprocesarDocumentoExtraido(userId, parsed);
  if (!resultado.ok) {
    const err = new Error('Documento rechazado -- no es factura, cuenta de cobro, ni factura de servicios públicos (tipo detectado: ' + resultado.tipoDocumento + ').');
    err.status = 422;
    err.publicMessage = resultado.publicMessage;
    throw err;
  }

  return resultado.data;
}

// Igual que procesarExtraccionFactura, pero para un archivo (PDF) que
// puede traer VARIOS documentos distintos concatenados -- ver
// PAQUETE_PROMPT más arriba. Llama a Gemini UNA sola vez con ese
// prompt (le pide segmentar el archivo y devolver un arreglo), y le
// aplica a CADA documento detectado el mismo post-procesamiento y el
// mismo chequeo de duplicados que a un documento que llega solo.
//
// Devuelve { documentos: [...] }, con un elemento por cada documento
// que la IA identificó, en el mismo orden en que aparecen en el
// archivo. Cada elemento tiene una de estas dos formas:
//   { tipo: 'factura', data: {...} }     -- documento válido y listo
//         para guardar (data.duplicado puede venir en true, junto con
//         data.factura_existente, igual que en el flujo de un solo
//         documento).
//   { tipo: 'rechazado', mensaje: '...' } -- la IA sí lo leyó, pero no
//         es factura de venta, cuenta de cobro, ni factura de
//         servicios públicos.
//
// El file_hash de cada documento válido se deriva del hash del
// archivo completo subido: si el paquete resultó traer un solo
// documento (el caso normal, con mucha diferencia), se usa ese mismo
// hash de siempre; si trae varios, cada uno lleva un sufijo "-N" --
// así cada factura del paquete se puede guardar y detectar como
// duplicada por separado más adelante, sin que las N facturas de un
// mismo archivo choquen entre sí por compartir el hash de ese archivo.
async function procesarPaqueteDocumento(userId, base64, effectiveMediaType, forzar) {
  const fileHashArchivo = calcularFileHash(base64);

  // Si este archivo EXACTO ya se guardó antes como un solo documento
  // (el caso más común), no vale la pena gastar otra lectura de IA --
  // se avisa como duplicado a nivel de todo el paquete, igual que hacía
  // procesarExtraccionFactura para un documento suelto.
  if (!forzar) {
    try {
      const existente = await buscarFacturaPorHash(userId, fileHashArchivo);
      if (existente) {
        return { documentos: [{ tipo: 'factura', data: { duplicado: true, file_hash: fileHashArchivo, factura_existente: existente } }] };
      }
    } catch (err) {
      console.error('No se pudo revisar duplicados antes de leer un paquete con IA:', err.message);
    }
  }

  const respuesta = await llamarGeminiJSON(base64, effectiveMediaType, PAQUETE_PROMPT);
  const crudos = Array.isArray(respuesta.documentos) ? respuesta.documentos : [];

  if (crudos.length === 0) {
    const err = new Error('La IA no identificó ningún documento en el archivo.');
    err.status = 422;
    err.publicMessage = 'No se pudo identificar ningún documento en este archivo. Intenta con un archivo más claro.';
    throw err;
  }

  const documentos = [];
  for (let i = 0; i < crudos.length; i++) {
    const parsed = crudos[i] && typeof crudos[i] === 'object' ? crudos[i] : {};
    const resultado = await posprocesarDocumentoExtraido(userId, parsed);

    if (!resultado.ok) {
      documentos.push({ tipo: 'rechazado', mensaje: resultado.publicMessage });
      continue;
    }

    const data = resultado.data;
    data.file_hash = crudos.length > 1 ? `${fileHashArchivo}-${i + 1}` : fileHashArchivo;

    if (!forzar) {
      try {
        const existente = await buscarFacturaPorHash(userId, data.file_hash);
        if (existente) {
          documentos.push({ tipo: 'factura', data: { duplicado: true, file_hash: data.file_hash, factura_existente: existente } });
          continue;
        }
      } catch (err) {
        console.error('No se pudo revisar duplicados de un documento del paquete:', err.message);
      }
    }

    documentos.push({ tipo: 'factura', data });
  }

  return { documentos };
}

// Versión de servidor de la misma detección que ya hacía el navegador
// en Escanear/Carga masiva -- comparar el NIT de la factura contra los
// clientes del contador para decidir solo si es ingreso o egreso. Vive
// aquí también porque el procesamiento en segundo plano no tiene un
// navegador que lo haga por él.
async function detectarClienteYMovimientoServidor(contadorId, data) {
  const { rows: clientes } = await pool.query('SELECT id, nit, nombre FROM clients WHERE contador_id = $1', [contadorId]);
  const asComprador = clientes.find(c => c.nit && data.adquiriente_nit && c.nit === data.adquiriente_nit);
  const asVendedor = clientes.find(c => c.nit && data.nit_cc && c.nit === data.nit_cc);
  if (asComprador) return { clienteId: asComprador.id, tipoMovimiento: 'egreso', confiado: true };
  if (asVendedor) return { clienteId: asVendedor.id, tipoMovimiento: 'ingreso', confiado: true };
  return { clienteId: '', tipoMovimiento: 'egreso', confiado: false };
}

app.post('/api/extract', requireAuth, limitadorIA, async (req, res) => {
  const { base64, mediaType, isPdf, forzar } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;

  try {
    const parsed = await procesarExtraccionFactura(req.firmaId, base64, effectiveMediaType, isPdf, forzar);
    res.json(parsed);
  } catch (err) {
    console.error('Error al llamar a Gemini (factura):', err);
    res.status(err.status || 500).json({ error: err.publicMessage || 'Error de conexión con la API de Gemini.' });
  }
});

// Escanear sube un PDF a esta ruta (en vez de /api/extract) porque un
// PDF puede en teoría venir con varios documentos concatenados (un
// extracto bancario seguido de varios soportes, por ejemplo) -- el
// frontend está preparado para recibir `{ facturas: [...], otros_grupos:
// [...] }` y avisar si detecta más de un documento en el archivo.
//
// Para un PDF, esta ruta SÍ segmenta de verdad el archivo en varios
// documentos cuando corresponde (ver procesarPaqueteDocumento /
// PAQUETE_PROMPT más arriba). Cada documento identificado llega en
// `facturas` -- ya sea el objeto normal de una factura leída, o
// `{ error: true, mensaje: '...' }` si la IA lo leyó pero lo rechazó
// (no es factura/cuenta de cobro/servicios públicos). Escanear solo
// puede mostrar un formulario a la vez, así que si el total (facturas +
// otros_grupos) es mayor a 1, el frontend avisa y manda al contador a
// Carga masiva -- que sí procesa cada documento del paquete como una
// fila independiente (ver lotes.js).
app.post('/api/extract-paquete', requireAuth, limitadorIA, async (req, res) => {
  const { base64, mediaType, isPdf, forzar } = req.body;

  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Faltan datos del archivo (base64 o mediaType).' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;

  try {
    if (!isPdf) {
      // Una foto es siempre un solo documento -- no hace falta gastar
      // el prompt (más largo) de segmentación de paquete.
      const parsed = await procesarExtraccionFactura(req.firmaId, base64, effectiveMediaType, isPdf, forzar);
      return res.json({ facturas: [parsed], otros_grupos: [] });
    }

    const { documentos } = await procesarPaqueteDocumento(req.firmaId, base64, effectiveMediaType, forzar);
    const facturas = documentos.map((doc) => (doc.tipo === 'factura' ? doc.data : { error: true, mensaje: doc.mensaje }));
    res.json({ facturas, otros_grupos: [] });
  } catch (err) {
    console.error('Error al llamar a Gemini (factura, PDF):', err);
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
app.post('/api/extract-rut', requireAuth, limitadorIA, async (req, res) => {
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
    if (!(await clienteEsDelContador(req.firmaId, clienteId))) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    const facturas = await facturasConSaldo(req.firmaId, clienteId);
    const facturasPendientes = facturas.filter((f) => f.saldo_pendiente > 0);

    const { rows: movimientos } = await pool.query(
      `SELECT * FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 ORDER BY fecha DESC, created_at DESC`,
      [req.firmaId, clienteId]
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
app.post('/api/extracto/leer-pdf', requireAuth, limitadorIA, async (req, res) => {
  const { base64, mediaType, isPdf, clienteId, forzar } = req.body;
  if (!base64 || !mediaType || !clienteId) {
    return res.status(400).json({ error: 'Faltan datos del archivo o del cliente.' });
  }
  if (!(await clienteEsDelContador(req.firmaId, clienteId))) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const effectiveMediaType = isPdf ? 'application/pdf' : mediaType;
  const fileHash = calcularFileHash(base64);

  if (!forzar) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 AND file_hash = $3 LIMIT 1`,
        [req.firmaId, clienteId, fileHash]
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
  if (!(await clienteEsDelContador(req.firmaId, clienteId))) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  const fileHash = calcularFileHash(csvTexto);

  if (!forzar) {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM movimientos_banco WHERE contador_id = $1 AND cliente_id = $2 AND file_hash = $3 LIMIT 1`,
        [req.firmaId, clienteId, fileHash]
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
    if (!(await clienteEsDelContador(req.firmaId, clienteId))) {
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
        [id, req.firmaId, clienteId, extractoId, String(m.fecha || ''), String(m.descripcion || ''), String(valor), m.tipo, file_hash || '', mes]
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
      [req.params.id, req.firmaId]
    );
    if (movRows.length === 0) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const mov = movRows[0];

    const { rows: facRows } = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND contador_id = $2 AND cliente_id = $3',
      [invoiceId, req.firmaId, mov.cliente_id]
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
      [req.params.id, req.firmaId]
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
      [req.params.id, req.firmaId]
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
      [req.firmaId]
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
      [id, req.firmaId, nombre.trim(), JSON.stringify(columnas)]
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
      [nombre.trim(), JSON.stringify(columnas), req.params.id, req.firmaId]
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
      [req.params.id, req.firmaId]
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
      `SELECT nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, declarante_renta, notas, updated_at
       FROM terceros_fiscales WHERE contador_id = $1 ORDER BY updated_at DESC`,
      [req.firmaId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo terceros fiscales:', err);
    res.status(500).json({ error: 'No se pudieron cargar los perfiles fiscales.' });
  }
});

app.post('/api/terceros-fiscales', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const nit = normalizarNit(req.body.nit);
    if (!nit) return res.status(400).json({ error: 'Falta el NIT del tercero.' });
    const nombre = String(req.body.nombre || '').trim();
    const notas = String(req.body.notas || '').trim();
    const granContribuyente = !!req.body.gran_contribuyente;
    const autorretenedor = !!req.body.autorretenedor;
    const regimenSimple = !!req.body.regimen_simple;
    const agenteRetencionIva = !!req.body.agente_retencion_iva;
    const declaranteRenta = !!req.body.declarante_renta;

    // Si no queda ninguna marca activa y no hay nombre/notas, no tiene
    // sentido guardar una fila vacía -- se borra en vez de guardar.
    if (!granContribuyente && !autorretenedor && !regimenSimple && !agenteRetencionIva && !declaranteRenta && !nombre && !notas) {
      await pool.query('DELETE FROM terceros_fiscales WHERE contador_id = $1 AND nit = $2', [req.firmaId, nit]);
      return res.json({ nit, nombre: '', gran_contribuyente: false, autorretenedor: false, regimen_simple: false, agente_retencion_iva: false, declarante_renta: false, notas: '', borrado: true });
    }

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO terceros_fiscales (id, contador_id, nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, declarante_renta, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (contador_id, nit) DO UPDATE SET
         nombre = EXCLUDED.nombre, gran_contribuyente = EXCLUDED.gran_contribuyente,
         autorretenedor = EXCLUDED.autorretenedor, regimen_simple = EXCLUDED.regimen_simple,
         agente_retencion_iva = EXCLUDED.agente_retencion_iva, declarante_renta = EXCLUDED.declarante_renta,
         notas = EXCLUDED.notas, updated_at = now()
       RETURNING nit, nombre, gran_contribuyente, autorretenedor, regimen_simple, agente_retencion_iva, declarante_renta, notas, updated_at`,
      [id, req.firmaId, nit, nombre, granContribuyente, autorretenedor, regimenSimple, agenteRetencionIva, declaranteRenta, notas]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error guardando perfil fiscal del tercero:', err);
    res.status(500).json({ error: 'No se pudo guardar el perfil fiscal.' });
  }
});

app.delete('/api/terceros-fiscales/:nit', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const nit = normalizarNit(req.params.nit);
    const { rowCount } = await pool.query(
      'DELETE FROM terceros_fiscales WHERE contador_id = $1 AND nit = $2',
      [req.firmaId, nit]
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
      [req.firmaId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error leyendo tarifas de ICA:', err);
    res.status(500).json({ error: 'No se pudieron cargar las tarifas de ICA.' });
  }
});

app.post('/api/tarifas-ica', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
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
      [id, req.firmaId, municipio, actividad, tarifaPorMil, baseUvt, cuentaPuc, notas]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Error guardando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo guardar la tarifa de ICA.' });
  }
});

app.put('/api/tarifas-ica/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
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
      [municipio, actividad, tarifaPorMil, baseUvt, cuentaPuc, notas, req.params.id, req.firmaId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tarifa de ICA no encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error actualizando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo actualizar la tarifa de ICA.' });
  }
});

app.delete('/api/tarifas-ica/:id', requireAuth, requireRole('administrador', 'contador'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tarifas_ica WHERE id = $1 AND contador_id = $2',
      [req.params.id, req.firmaId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Tarifa de ICA no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando tarifa de ICA:', err);
    res.status(500).json({ error: 'No se pudo eliminar la tarifa de ICA.' });
  }
});

// ---------- Lotes de procesamiento en segundo plano ----------

app.post('/api/lotes', requireAuth, async (req, res) => {
  const { clienteId, archivos } = req.body;
  if (!Array.isArray(archivos) || archivos.length === 0) {
    return res.status(400).json({ error: 'No se recibió ningún archivo para procesar.' });
  }
  if (archivos.length > 100) {
    return res.status(400).json({ error: 'Máximo 100 archivos por lote -- sube el resto en un segundo lote.' });
  }
  try {
    const loteId = await lotes.crearLote(req.firmaId, clienteId || null, archivos);
    res.status(201).json({ loteId });
  } catch (err) {
    console.error('Error creando lote:', err);
    res.status(500).json({ error: 'No se pudo iniciar el procesamiento del lote.' });
  }
});

// El lote en curso (o el último completado, si no hay ninguno
// procesándose ahora) de este contador -- lo usa tanto el avisito
// global (en cualquier página) como Carga masiva para reconectarse.
app.get('/api/lotes/activo', requireAuth, async (req, res) => {
  try {
    const lote = await lotes.obtenerLoteActivoOUltimo(req.firmaId);
    res.json(lote || null);
  } catch (err) {
    console.error('Error leyendo el lote activo:', err);
    res.status(500).json({ error: 'No se pudo consultar el estado del procesamiento.' });
  }
});

app.post('/api/lotes/items/:id/reintentar', requireAuth, async (req, res) => {
  try {
    await lotes.reintentarItem(req.params.id, req.firmaId, !!req.body.forzar);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error reintentando ítem de lote:', err);
    res.status(500).json({ error: 'No se pudo reintentar este archivo.' });
  }
});

app.delete('/api/lotes/items/:id', requireAuth, async (req, res) => {
  try {
    await lotes.eliminarItem(req.params.id, req.firmaId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando ítem de lote:', err);
    res.status(500).json({ error: 'No se pudo quitar este archivo del lote.' });
  }
});

app.get('/api/lotes/items/:id/archivo', requireAuth, async (req, res) => {
  try {
    const archivo = await lotes.obtenerArchivoItem(req.params.id, req.firmaId);
    if (!archivo) return res.status(404).json({ error: 'No se encontró el archivo.' });
    res.json(archivo);
  } catch (err) {
    console.error('Error leyendo archivo de ítem de lote:', err);
    res.status(500).json({ error: 'No se pudo cargar el archivo original.' });
  }
});

// OJO -- antes `ensureSchema()`/`lotes.init()` corrían DENTRO del
// callback de `app.listen()`, lo que significa que Express ya estaba
// aceptando conexiones (el puerto queda abierto en cuanto se llama
// `app.listen`, no cuando termina su callback) mientras ese `await`
// seguía en curso. Cualquier request que llegara en esa ventana -- ej.
// el avisito global de lotes pidiendo /api/lotes/activo apenas carga
// cualquier página -- caía en lotes.js con su `pool` interno todavía
// sin asignar (`lotes.init()` no había corrido todavía), y explotaba
// con "Cannot read properties of undefined (reading 'query')". Con una
// base de datos remota (Supabase) esa ventana es más larga que en
// local, así que se veía siempre al arrancar. Ahora todo el setup
// async corre ANTES de abrir el puerto -- nada puede llegar a un
// `pool`/`lotes` sin inicializar.
(async () => {
  try {
    await ensureSchema();
    lotes.init({ pool, crypto, procesarExtraccionFactura, procesarPaqueteDocumento, detectarClienteYMovimientoServidor });
    await lotes.asegurarSchemaLotes();
  } catch (err) {
    console.error('\n[ERROR] No se pudo conectar/preparar la base de datos:', err.message);
    console.error('Verifica que tu DATABASE_URL en .env sea correcta.\n');
  }
  app.listen(PORT, () => {
    lotes.dispararProcesamiento(); // por si el servidor se reinició con un lote a medias
    console.log(`\n✔ Enlaza corriendo en http://localhost:${PORT}`);
    console.log(`✔ Base de datos conectada y lista\n`);
  });
})();