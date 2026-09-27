// ui-feedback.js -- Avisos y confirmaciones compartidos de Enlaza.
//
// Da una sola forma, consistente en toda la app, de:
//   1) avisar al usuario lo que acaba de pasar (Aviso.mostrar) -- un
//      mensaje que aparece y se cierra solo, sin bloquear la pantalla.
//   2) pedir confirmación antes de una acción que no se puede deshacer
//      (Aviso.confirmar / Aviso.confirmarEliminar) -- un cuadro con un
//      botón de acción y uno de "Cancelar", en vez del confirm() feo
//      del navegador.
//
// Uso:
//   Aviso.mostrar('Factura eliminada.');
//   Aviso.mostrar('No se pudo guardar: ' + err.message, { tipo: 'error' });
//
//   const ok = await Aviso.confirmarEliminar('¿Eliminar esta factura del kárdex?');
//   if (!ok) return;
//
//   const ok2 = await Aviso.confirmar({
//     titulo: 'Cancelar invitación',
//     mensaje: '¿Cancelar la invitación enviada a este correo?',
//     textoConfirmar: 'Cancelar invitación',
//     peligroso: true,
//   });

(function () {
  if (window.Aviso) return; // ya está cargado, no duplicar

  const ICONOS = {
    exito: '<svg viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.2v4.3M10 13.4v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v4.2M10 6.6v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    advertencia: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3.2l7.8 13.5H2.2L10 3.2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.3v3.6M10 14.3v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  function inyectarEstilos() {
    if (document.getElementById('uif-estilos')) return;
    const style = document.createElement('style');
    style.id = 'uif-estilos';
    style.textContent = `
      #uif-pila{position:fixed;z-index:99999;bottom:20px;right:20px;display:flex;flex-direction:column-reverse;gap:10px;max-width:min(380px, calc(100vw - 32px));pointer-events:none;}
      @media (max-width:640px){ #uif-pila{ left:16px; right:16px; bottom:16px; max-width:none; } }
      .uif-toast{pointer-events:auto;position:relative;overflow:hidden;display:flex;align-items:flex-start;gap:10px;background:var(--paper-raised,#fff);border:1.5px solid var(--line,#DCE7EC);border-left:4px solid var(--petroleo,#0B4F6C);border-radius:12px;box-shadow:var(--shadow-lg,0 30px 60px -28px rgba(13,30,40,0.24));padding:13px 14px 15px 13px;font-family:'Inter',-apple-system,sans-serif;color:var(--ink,#1D2A32);animation:uif-entrar .32s var(--ease,cubic-bezier(.16,1,.3,1));}
      .uif-toast.uif-saliendo{animation:uif-salir .22s ease forwards;}
      @keyframes uif-entrar{from{opacity:0;transform:translateY(10px) scale(.96);} to{opacity:1;transform:translateY(0) scale(1);}}
      @keyframes uif-salir{to{opacity:0;transform:translateX(24px) scale(.96);}}
      .uif-toast[data-tipo="exito"]{border-left-color:var(--moss,#5B8072);}
      .uif-toast[data-tipo="error"]{border-left-color:var(--coral-deep,#E0512F);}
      .uif-toast[data-tipo="advertencia"]{border-left-color:var(--clay,#AA6B5C);}
      .uif-toast[data-tipo="info"]{border-left-color:var(--petroleo,#0B4F6C);}
      .uif-toast .uif-icono{flex:none;width:19px;height:19px;margin-top:1px;}
      .uif-toast[data-tipo="exito"] .uif-icono{color:var(--moss,#5B8072);}
      .uif-toast[data-tipo="error"] .uif-icono{color:var(--coral-deep,#E0512F);}
      .uif-toast[data-tipo="advertencia"] .uif-icono{color:var(--clay,#AA6B5C);}
      .uif-toast[data-tipo="info"] .uif-icono{color:var(--petroleo,#0B4F6C);}
      .uif-toast .uif-icono svg{width:100%;height:100%;}
      .uif-toast .uif-texto{flex:1;font-size:13.5px;font-weight:600;line-height:1.42;padding-top:1px;white-space:pre-line;}
      .uif-toast .uif-cerrar{flex:none;background:none;border:none;padding:2px;margin:-2px -4px -2px 0;color:var(--ink-faint,#8AA0AC);font-size:15px;line-height:1;cursor:pointer;border-radius:6px;}
      .uif-toast .uif-cerrar:hover{color:var(--ink,#1D2A32);background:var(--paper-sunken,#EAF3F7);}
      .uif-toast .uif-barra{position:absolute;left:0;bottom:0;height:2.5px;background:currentColor;opacity:.28;width:100%;transform-origin:left;animation-name:uif-barra;animation-timing-function:linear;animation-fill-mode:forwards;}
      @keyframes uif-barra{from{transform:scaleX(1);} to{transform:scaleX(0);}}

      #uif-overlay{position:fixed;inset:0;z-index:99998;background:rgba(29,42,50,0.48);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:20px;animation:uif-fundido .18s ease;}
      @keyframes uif-fundido{from{opacity:0;} to{opacity:1;}}
      .uif-modal{width:100%;max-width:400px;background:var(--paper-raised,#fff);border-radius:16px;box-shadow:var(--shadow-lg,0 30px 60px -28px rgba(13,30,40,0.24));padding:22px 22px 18px;font-family:'Inter',-apple-system,sans-serif;color:var(--ink,#1D2A32);animation:uif-modal-entrar .24s var(--ease,cubic-bezier(.16,1,.3,1));}
      @keyframes uif-modal-entrar{from{opacity:0;transform:translateY(8px) scale(.97);} to{opacity:1;transform:translateY(0) scale(1);}}
      .uif-modal h3{font-family:'Archivo',sans-serif;font-weight:800;font-size:16.5px;margin:0 0 8px;letter-spacing:-0.01em;}
      .uif-modal p{font-size:13.5px;line-height:1.55;color:var(--ink-soft,#4A5E68);margin:0 0 20px;}
      .uif-modal .uif-botones{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;}
      .uif-modal button{font-family:inherit;font-size:13.5px;font-weight:700;border-radius:10px;padding:10px 16px;border:1.5px solid transparent;cursor:pointer;transition:transform .12s ease, box-shadow .12s ease;}
      .uif-modal button:active{transform:scale(.97);}
      .uif-modal .uif-btn-cancelar{background:var(--paper-raised,#fff);color:var(--ink,#1D2A32);border-color:var(--line,#DCE7EC);}
      .uif-modal .uif-btn-cancelar:hover{border-color:var(--ink-faint,#8AA0AC);}
      .uif-modal .uif-btn-confirmar{background:var(--petroleo,#0B4F6C);border-color:var(--petroleo,#0B4F6C);color:#fff;}
      .uif-modal .uif-btn-confirmar:hover{background:var(--petroleo-deep,#083A4F);}
      .uif-modal .uif-btn-confirmar.uif-peligro{background:var(--coral-deep,#E0512F);border-color:var(--coral-deep,#E0512F);}
      .uif-modal .uif-btn-confirmar.uif-peligro:hover{background:#c23f22;}
    `;
    document.head.appendChild(style);
  }

  function obtenerPila() {
    let pila = document.getElementById('uif-pila');
    if (!pila) {
      pila = document.createElement('div');
      pila.id = 'uif-pila';
      document.body.appendChild(pila);
    }
    return pila;
  }

  function mostrar(mensaje, opciones) {
    opciones = opciones || {};
    const tipo = opciones.tipo || 'exito'; // 'exito' | 'error' | 'info' | 'advertencia'
    const duracion = opciones.duracion != null ? opciones.duracion : (tipo === 'error' ? 5200 : 3600);
    inyectarEstilos();
    const pila = obtenerPila();

    const toast = document.createElement('div');
    toast.className = 'uif-toast';
    toast.dataset.tipo = tipo;
    toast.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    toast.innerHTML = `
      <span class="uif-icono">${ICONOS[tipo] || ICONOS.info}</span>
      <span class="uif-texto"></span>
      <button type="button" class="uif-cerrar" aria-label="Cerrar aviso">&times;</button>
      <span class="uif-barra" style="animation-duration:${duracion}ms"></span>
    `;
    toast.querySelector('.uif-texto').textContent = mensaje;
    pila.appendChild(toast);

    let cerrado = false;
    function cerrar() {
      if (cerrado) return;
      cerrado = true;
      toast.classList.add('uif-saliendo');
      setTimeout(() => toast.remove(), 220);
    }
    toast.querySelector('.uif-cerrar').addEventListener('click', cerrar);
    const temporizador = setTimeout(cerrar, duracion);
    toast.addEventListener('mouseenter', () => clearTimeout(temporizador));
  }

  function confirmar(opciones) {
    opciones = opciones || {};
    const {
      titulo = '¿Estás seguro?',
      mensaje = '',
      textoConfirmar = 'Confirmar',
      textoCancelar = 'Cancelar',
      peligroso = false,
    } = opciones;

    inyectarEstilos();

    return new Promise((resolve) => {
      const existente = document.getElementById('uif-overlay');
      if (existente) existente.remove(); // no apilar dos confirmaciones a la vez

      const overlay = document.createElement('div');
      overlay.id = 'uif-overlay';
      overlay.innerHTML = `
        <div class="uif-modal" role="alertdialog" aria-modal="true" aria-labelledby="uif-titulo">
          <h3 id="uif-titulo"></h3>
          <p></p>
          <div class="uif-botones">
            <button type="button" class="uif-btn-cancelar"></button>
            <button type="button" class="uif-btn-confirmar${peligroso ? ' uif-peligro' : ''}"></button>
          </div>
        </div>
      `;
      overlay.querySelector('h3').textContent = titulo;
      overlay.querySelector('p').textContent = mensaje;
      overlay.querySelector('.uif-btn-cancelar').textContent = textoCancelar;
      overlay.querySelector('.uif-btn-confirmar').textContent = textoConfirmar;
      document.body.appendChild(overlay);

      let resuelto = false;
      function terminar(resultado) {
        if (resuelto) return;
        resuelto = true;
        document.removeEventListener('keydown', alEscape);
        overlay.remove();
        resolve(resultado);
      }
      function alEscape(e) {
        if (e.key === 'Escape') terminar(false);
      }
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) terminar(false);
      });
      overlay.querySelector('.uif-btn-cancelar').addEventListener('click', () => terminar(false));
      overlay.querySelector('.uif-btn-confirmar').addEventListener('click', () => terminar(true));
      document.addEventListener('keydown', alEscape);
      overlay.querySelector('.uif-btn-confirmar').focus();
    });
  }

  function confirmarEliminar(mensaje, opciones) {
    opciones = opciones || {};
    return confirmar({
      titulo: opciones.titulo || 'Confirmar eliminación',
      mensaje,
      textoConfirmar: opciones.textoConfirmar || 'Eliminar',
      textoCancelar: opciones.textoCancelar || 'Cancelar',
      peligroso: true,
    });
  }

  window.Aviso = { mostrar, confirmar, confirmarEliminar };
})();
