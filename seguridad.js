// ---------------------------------------------------------------------
// Endurecimiento básico de seguridad HTTP -- cabeceras, CORS y límite de
// tasa (rate limiting), escrito a mano en vez de instalar helmet/cors/
// express-rate-limit.
//
// Por qué a mano y no las librerías estándar: en el entorno donde se
// desarrolló este archivo no había acceso al registro de npm para
// instalar paquetes nuevos, y no tenía sentido agregar dependencias a
// package.json sin poder probarlas de verdad primero. Lo de aquí cubre
// exactamente lo que necesita Enlaza hoy (cabeceras de seguridad, una
// lista blanca de orígenes para CORS, y limitadores de tasa en memoria)
// sin agregar dependencias nuevas al proyecto. Si en el futuro hace
// falta algo más completo (ej. una Content-Security-Policy real, que
// requiere revisar los scripts inline de cada página primero), la forma
// más fácil de migrar es reemplazar este archivo por las librerías de
// npm -- la interfaz (funciones que reciben (req,res,next)) es la misma.
// ---------------------------------------------------------------------

// Cabeceras de seguridad tipo "helmet", pero mínimas: cubren lo que no
// depende de tocar el HTML de cada página. NO se incluye una
// Content-Security-Policy -- todas las páginas de public/ tienen scripts
// inline grandes, y una CSP estricta las rompería; hacerla bien requiere
// un refactor aparte (nonces o hashes por script) que queda fuera de
// esta tarea.
function cabecerasSeguridad(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // evita que el navegador "adivine" el tipo de un archivo servido
  res.setHeader('X-Frame-Options', 'DENY'); // nadie debería poder meter Enlaza en un <iframe> ajeno (clickjacking)
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // OJO -- 'same-origin' (el valor "estricto" típico de un hardening tipo
  // helmet) rompe el login con Google: el botón de Sign In With Google
  // abre un popup propio (accounts.google.com/gsi/transform) que le
  // reporta la sesión de vuelta a login.html vía `window.opener.postMessage(...)`.
  // Con COOP:'same-origin', el navegador aísla el grupo de contexto de
  // navegación y `window.opener` queda `null` DENTRO del popup de Google
  // -- de ahí el "Cannot read properties of null (reading 'postMessage')"
  // que se ve en la consola y el popup que se queda en blanco sin volver
  // nunca a cerrarse. 'same-origin-allow-popups' sigue aislando de
  // ventanas de OTROS orígenes (la protección que de verdad importa),
  // pero permite que un popup que ESTA página abrió pueda hablarle de
  // vuelta -- que es exactamente lo que necesita el login de Google.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  // HSTS solo tiene sentido si la conexión ya es HTTPS (si no, el propio
  // navegador la ignora) -- con `trust proxy` activado (ver server.js),
  // req.secure ya refleja el X-Forwarded-Proto que manda Render.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains'); // 180 días
  }
  next();
}

// CORS mínimo: por defecto Enlaza sirve su propio frontend (mismo
// origen), así que la mayoría de las peticiones del navegador NUNCA
// traen cabecera Origin distinta a la propia -- esas siguen funcionando
// igual, sin tocar nada. Esto solo entra en juego si algún sitio
// DISTINTO intenta llamar la API desde el navegador de un usuario
// logueado: si su origen no está en la lista blanca, el navegador no le
// deja leer la respuesta.
//
// `origenesPermitidos`: arreglo de orígenes exactos (ej.
// "https://app.enlaza.co") que si algún día se necesita permitir
// explícitamente (una app aparte, un panel de socios, etc.) se agregan
// aquí vía la variable de entorno ALLOWED_ORIGINS (separados por coma).
function crearCors(origenesPermitidos) {
  const permitidos = new Set((origenesPermitidos || []).filter(Boolean));
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next(); // sin cabecera Origin = navegación normal del mismo sitio, o herramienta no-navegador
    if (permitidos.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(permitidos.has(origin) ? 204 : 403);
    next();
  };
}

// Limitador de tasa en memoria (ventana fija). Suficiente para una sola
// instancia de servidor (que es como corre Enlaza hoy en Render, plan
// gratis) -- si algún día se escala a varias instancias en paralelo, el
// conteo dejaría de ser compartido entre ellas y habría que moverlo a un
// almacén compartido (ej. Redis). Se deja anotado acá para no olvidarlo.
//
// `obtenerClave(req)` opcional: por defecto se limita por IP (`req.ip`,
// que con `trust proxy` activado ya es la IP real del visitante detrás
// de Render, no la del proxy). Para las rutas que llaman a la IA se usa
// el id del contador ya autenticado en su lugar, para que un contador no
// se vea afectado por el tráfico de los demás.
function crearLimitador({ ventanaMs, maximo, mensaje, obtenerClave }) {
  const golpes = new Map(); // clave -> { conteo, expiraEn }

  // Barrido periódico para no acumular memoria con claves ya vencidas
  // (IPs/usuarios que no han vuelto a pedir nada en la última ventana).
  const barrido = setInterval(() => {
    const ahora = Date.now();
    for (const [clave, registro] of golpes) {
      if (registro.expiraEn <= ahora) golpes.delete(clave);
    }
  }, Math.max(ventanaMs, 60000));
  barrido.unref?.();

  return function limitador(req, res, next) {
    const clave = (obtenerClave ? obtenerClave(req) : null) || req.ip || 'sin-ip';
    const ahora = Date.now();
    let registro = golpes.get(clave);
    if (!registro || registro.expiraEn <= ahora) {
      registro = { conteo: 0, expiraEn: ahora + ventanaMs };
      golpes.set(clave, registro);
    }
    registro.conteo += 1;

    res.setHeader('X-RateLimit-Limit', String(maximo));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maximo - registro.conteo)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(registro.expiraEn / 1000)));

    if (registro.conteo > maximo) {
      const segundos = Math.max(1, Math.ceil((registro.expiraEn - ahora) / 1000));
      res.setHeader('Retry-After', String(segundos));
      return res.status(429).json({ error: mensaje || 'Demasiadas solicitudes -- espera un momento e intenta de nuevo.' });
    }
    next();
  };
}

module.exports = { cabecerasSeguridad, crearCors, crearLimitador };
