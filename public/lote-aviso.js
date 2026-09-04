// ---------- Avisito global de Carga masiva -- widget flotante ----------
// Un solo archivo que se auto-inserta en cualquier página donde se
// incluya (<script src="/lote-aviso.js"></script> antes de </body>) --
// mismo patrón que /soporte-chat.js, para no tener que tocar el CSS/HTML
// de cada página por separado.
//
// Por qué existe: antes, "Carga masiva" solo mostraba el progreso de un
// lote DENTRO de esa misma pantalla (#progressArea) -- si el contador se
// iba a otra página mientras la IA seguía leyendo facturas en segundo
// plano (el servidor sigue aunque el navegador cambie de pantalla, ver
// public/lotes.js), no se enteraba de nada hasta volver a entrar a Carga
// masiva. Este widget consulta el mismo GET /api/lotes/activo (el mismo
// que ya usa masivo.html para reconectarse) desde CUALQUIER página, y
// avisa con una barra pequeña mientras sigue en curso, y con un aviso
// destacado apenas termina -- sin bloquear nada ni duplicar el detalle
// que ya muestra Carga masiva.
//
// A propósito NO se incluye este script en masivo.html -- esa pantalla
// ya tiene su propio progreso en detalle (#progressArea/refrescarLoteActivo)
// y su propio intervalo de 2.5s; sumar este widget ahí sería mostrar el
// mismo dato dos veces y duplicar el consumo de la API.
(function () {
  if (/\/masivo\.html/i.test(window.location.pathname)) return; // por si se coló ahí por error

  const POLL_MS = 4500;
  const CLAVE_VISTO = 'kardexIA_loteAvisoVisto'; // último lote "completado" que el contador ya vio/descartó

  const ESTILOS = `
    #loteAvisoGlobal{
      position:fixed; right:20px; bottom:20px; z-index:9998;
      width:min(300px, calc(100vw - 32px));
      background:#fff; border:1px solid #E6DECA; border-radius:12px;
      box-shadow:0 20px 44px -18px rgba(46,34,20,0.28);
      padding:13px 14px; font-family:'Inter', -apple-system, sans-serif;
      opacity:0; transform:translateY(10px); pointer-events:none;
      transition:opacity .2s cubic-bezier(0.16,1,0.3,1), transform .2s cubic-bezier(0.16,1,0.3,1);
    }
    #loteAvisoGlobal.show{ opacity:1; transform:translateY(0); pointer-events:auto; }
    #loteAvisoGlobal .la-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:7px; }
    #loteAvisoGlobal .la-titulo{
      display:flex; align-items:center; gap:6px;
      font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:600;
      text-transform:uppercase; letter-spacing:.05em; color:#6C6152;
    }
    #loteAvisoGlobal.completado .la-titulo{ color:#3E6053; }
    #loteAvisoGlobal .la-dot{ width:7px; height:7px; border-radius:50%; background:#FF5A36; flex:0 0 auto; animation:loteAvisoPulso 1.4s ease-in-out infinite; }
    #loteAvisoGlobal.completado .la-dot{ background:#5B8072; animation:none; }
    @keyframes loteAvisoPulso{ 0%,100%{ opacity:1; } 50%{ opacity:.3; } }
    #loteAvisoGlobal .la-cerrar{
      background:none; border:none; color:#A79C8B; font-size:13px; cursor:pointer;
      padding:2px 5px; border-radius:4px; line-height:1;
    }
    #loteAvisoGlobal .la-cerrar:hover{ color:#D8431F; background:#FFF0EA; }
    #loteAvisoGlobal .la-texto{ font-size:12.5px; color:#241E18; margin-bottom:9px; }
    #loteAvisoGlobal .la-barra-fondo{ height:5px; background:#F1EAD9; border-radius:100px; overflow:hidden; margin-bottom:10px; }
    #loteAvisoGlobal .la-barra{ height:100%; width:0%; background:#FF5A36; transition:width .3s cubic-bezier(0.16,1,0.3,1); }
    #loteAvisoGlobal.completado .la-barra{ background:#5B8072; }
    #loteAvisoGlobal .la-link{
      display:inline-block; font-family:'Inter',sans-serif; font-size:11.5px; font-weight:700;
      color:#3E6053; text-decoration:none; border:1px solid #5B8072; border-radius:6px;
      padding:4px 10px; transition:background .15s ease;
    }
    #loteAvisoGlobal .la-link:hover{ background:#E9F0EB; }
    @media (max-width:640px){ #loteAvisoGlobal{ left:16px; right:16px; bottom:16px; width:auto; } }
  `;
  const style = document.createElement('style');
  style.textContent = ESTILOS;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'loteAvisoGlobal';
  wrap.innerHTML = `
    <div class="la-head">
      <span class="la-titulo"><span class="la-dot"></span><span id="loteAvisoTitulo">Carga masiva</span></span>
      <button type="button" class="la-cerrar" id="loteAvisoCerrar" title="Ocultar" hidden>✕</button>
    </div>
    <div class="la-texto" id="loteAvisoTexto"></div>
    <div class="la-barra-fondo"><div class="la-barra" id="loteAvisoBarra"></div></div>
    <a class="la-link" id="loteAvisoLink" href="/masivo.html" hidden>Ver resultados en Carga masiva →</a>
  `;

  function montar() {
    document.body.appendChild(wrap);
    const cerrar = document.getElementById('loteAvisoCerrar');
    cerrar.addEventListener('click', () => {
      const loteId = wrap.dataset.loteId;
      if (loteId) {
        try { localStorage.setItem(CLAVE_VISTO, loteId); } catch (e) { /* localStorage no disponible -- se ignora */ }
      }
      ocultar();
    });
    consultar();
    setInterval(consultar, POLL_MS);
  }

  function ocultar() {
    wrap.classList.remove('show', 'completado');
  }

  function yaVisto(loteId) {
    try { return localStorage.getItem(CLAVE_VISTO) === loteId; } catch (e) { return false; }
  }

  async function consultar() {
    let res;
    try {
      res = await fetch('/api/lotes/activo');
    } catch (e) {
      return; // sin red por un momento -- se reintenta en el próximo ciclo, no hay que avisar de esto
    }
    if (!res.ok) { ocultar(); return; } // 401 (sesión vencida) -- la propia página ya se encarga de redirigir a login

    let lote;
    try { lote = await res.json(); } catch (e) { return; }
    if (!lote) { ocultar(); return; } // este contador nunca ha subido un lote

    wrap.dataset.loteId = lote.id;
    const total = Number(lote.total_items) || 0;
    const hechos = Number(lote.items_procesados) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((hechos / total) * 100)) : 0;

    if (lote.estado === 'en_cola' || lote.estado === 'procesando') {
      wrap.classList.remove('completado');
      wrap.classList.add('show');
      document.getElementById('loteAvisoTitulo').textContent = 'Carga masiva en curso';
      document.getElementById('loteAvisoTexto').textContent =
        `Procesando lote: ${hechos}/${total} factura${total === 1 ? '' : 's'}`;
      document.getElementById('loteAvisoBarra').style.width = pct + '%';
      document.getElementById('loteAvisoCerrar').hidden = true; // no se puede descartar mientras sigue en curso
      document.getElementById('loteAvisoLink').hidden = true;
    } else if (lote.estado === 'completado') {
      if (yaVisto(lote.id)) { ocultar(); return; } // ya se lo mostramos antes en otra página -- no insistir
      wrap.classList.add('show', 'completado');
      document.getElementById('loteAvisoTitulo').textContent = 'Lote completado';
      document.getElementById('loteAvisoTexto').textContent =
        `Ya terminó de procesar tu lote: ${hechos}/${total} factura${total === 1 ? '' : 's'} lista${total === 1 ? '' : 's'} para revisar.`;
      document.getElementById('loteAvisoBarra').style.width = '100%';
      document.getElementById('loteAvisoCerrar').hidden = false;
      document.getElementById('loteAvisoLink').hidden = false;
    } else {
      ocultar();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montar);
  } else {
    montar();
  }
})();
