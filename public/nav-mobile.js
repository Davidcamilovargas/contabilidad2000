'use strict';
// ---------- Menú hamburguesa de la barra lateral (solo en mobile) ----------
// Un solo archivo que se auto-inserta en cualquier página que use la
// barra lateral (<aside class="sidebar">) -- mismo patrón que
// /soporte-chat.js y /lote-aviso.js, para no tener que repetir esta
// lógica en las 13 páginas que la incluyen.
//
// Por qué existe: en pantallas angostas, la barra lateral se acuesta y
// se convierte en una fila horizontal de enlaces con scroll propio (ver
// @media (max-width:900px) en styles.css) -- eso obligaba a deslizar de
// lado para ver "Integraciones" o "Carga masiva", y se veía como una
// tira de botones amontonados. Ahora, en esas mismas pantallas, los
// enlaces se esconden detrás de un botón de hamburguesa junto al logo,
// y se despliegan hacia abajo como un menú normal al tocarlo.
(function () {
  const sidebar = document.querySelector('.sidebar');
  const brand = document.querySelector('.sidebar-brand');
  const nav = document.querySelector('.sidebar-nav');
  if (!sidebar || !brand || !nav) return; // páginas sin barra lateral (login, landing) no hacen nada

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sidebar-hamburger';
  btn.setAttribute('aria-label', 'Abrir menú');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  brand.appendChild(btn);

  function cerrar() {
    sidebar.classList.remove('nav-open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function alternar() {
    const abierto = sidebar.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', abierto ? 'true' : 'false');
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); alternar(); });

  // Elegir un enlace cierra el menú -- si no, se queda tapando la
  // pantalla después de haber navegado (o de recargar la misma página).
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) cerrar(); });

  // Tocar fuera del menú también lo cierra.
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('nav-open') && !sidebar.contains(e.target)) cerrar();
  });

  // Si la pantalla vuelve a ser ancha (se rota el celular, o se
  // agranda la ventana), no se queda "abierto" a la fuerza -- a ese
  // ancho la barra ya se ve completa de nuevo, sin hamburguesa.
  const mq = window.matchMedia('(min-width:901px)');
  const alCambiarAncho = (e) => { if (e.matches) cerrar(); };
  if (mq.addEventListener) mq.addEventListener('change', alCambiarAncho);
  else if (mq.addListener) mq.addListener(alCambiarAncho); // Safari viejo
})();