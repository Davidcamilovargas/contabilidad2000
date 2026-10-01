// Helpers de permisos para el FRONTEND -- el bloqueo real de estas
// mismas acciones ya lo hace el servidor (requireRole y el bloqueo
// global de solo_lectura en requireAuth, ver server.js). Esto es solo
// para que a alguien sin permiso ni siquiera le aparezca el botón, en
// vez de dejarlo darle clic y toparse con un error 403.
//
// Uso típico en cada página, dentro de requireAuthAndInit() después de
// leer /api/me:
//   miRol = user.role;
//   aplicarPermisosUI();
// y en el HTML, marcar cada control restringido con:
//   data-permiso="admin-contador"   -- solo administrador/contador lo ven
//   data-permiso="escritura"        -- cualquier rol EXCEPTO solo_lectura
//
// Para botones que se arman dentro de un template de JS (listas,
// filas de tabla), en vez de esperar a aplicarPermisosUI() se usa
// directamente puedeAdministrar(miRol) / puedeEscribir(miRol) al
// construir el string, para no depender de que el DOM ya exista.

function puedeAdministrar(rol) {
  return rol === 'administrador' || rol === 'contador';
}

function puedeEscribir(rol) {
  return rol !== 'solo_lectura';
}

// Mismo mapa que ya usaba public/mi-firma.html -- centralizado aquí
// para que cualquier pantalla que muestre "Tu rol: ..." use el mismo
// texto en español.
const NOMBRES_ROL = {
  administrador: 'Administrador',
  contador: 'Contador',
  auxiliar_contable: 'Auxiliar contable',
  auxiliar_administrativo: 'Auxiliar administrativo',
  solo_lectura: 'Solo lectura',
};

function aplicarPermisosUI() {
  if (typeof miRol === 'undefined' || !miRol) return;
  document.querySelectorAll('[data-permiso="admin-contador"]').forEach((el) => {
    if (!puedeAdministrar(miRol)) el.style.display = 'none';
  });
  document.querySelectorAll('[data-permiso="escritura"]').forEach((el) => {
    if (!puedeEscribir(miRol)) el.style.display = 'none';
  });
}
