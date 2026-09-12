// ---------- Chatbot de soporte -- widget flotante ----------
// Un solo archivo que se auto-inserta en cualquier página donde se
// incluya (<script src="/soporte-chat.js"></script> antes de
// </body>) -- no hay que tocar el HTML de cada página por separado.
// Primera capa de soporte: preguntas de "¿cómo funciona esto?" o
// "¿por qué me salió este error?", antes de escribirle a soporte
// humano. La conversación vive solo en memoria -- se reinicia si
// recargas la página, a propósito, para mantenerlo simple.

(function () {
  // Número de WhatsApp de soporte, en formato internacional SOLO DÍGITOS
  // (sin "+", sin espacios ni guiones) -- ej. 573001234567 para un celular
  // colombiano. TODO: reemplazar por el número real de soporte de Enlaza.
  const NUMERO_WHATSAPP_SOPORTE = '573142471758';

  // Arma el link de WhatsApp con un mensaje precargado -- así quien
  // atienda soporte ya ve de una vez con qué necesitaba ayuda el
  // contador, sin que tenga que volver a escribirlo.
  function enlaceWhatsApp(mensaje) {
    const texto = mensaje && mensaje.trim()
      ? `Hola, vengo del asistente de Enlaza y necesito ayuda con: ${mensaje.trim()}`
      : 'Hola, necesito ayuda con Enlaza.';
    return `https://wa.me/${NUMERO_WHATSAPP_SOPORTE}?text=${encodeURIComponent(texto)}`;
  }

  const ESTILOS = `
    #soporteChatBtn{
      position:fixed; bottom:22px; right:22px; z-index:9999;
      display:flex; align-items:center; gap:7px;
      height:42px; padding:0 16px 0 12px; border-radius:100px; border:none;
      background:#FF5A36; color:#fff; cursor:pointer;
      box-shadow:0 12px 26px -8px rgba(0,0,0,0.5);
      font-family:'Inter', -apple-system, sans-serif; font-size:13px; font-weight:700;
      transition:transform .15s cubic-bezier(0.16,1,0.3,1);
    }
    #soporteChatBtn:hover{ transform:scale(1.04); }
    #soporteChatBtn svg{ width:18px; height:18px; flex-shrink:0; }
    #soporteChatPanel{
      position:fixed; bottom:76px; right:22px; z-index:9999;
      width:320px; max-width:calc(100vw - 32px); height:420px; max-height:66vh;
      background:#fff; border-radius:16px;
      box-shadow:0 30px 60px -16px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06);
      display:none; flex-direction:column; overflow:hidden;
      font-family:'Inter', -apple-system, sans-serif;
    }
    #soporteChatPanel.show{ display:flex; }
    #soporteChatHeader{
      background:#0E1315; padding:12px 14px; display:flex; align-items:center; gap:9px;
      flex-shrink:0;
    }
    #soporteChatHeader svg{ width:20px; height:20px; flex-shrink:0; }
    #soporteChatHeader .titulos{ flex:1; min-width:0; }
    #soporteChatHeader .titulo{ font-family:'Archivo',sans-serif; font-weight:800; font-size:13px; color:#fff; line-height:1.2; }
    #soporteChatHeader .subtitulo{ font-family:'JetBrains Mono',monospace; font-size:9.5px; color:rgba(255,255,255,0.5); }
    #soporteChatCerrar{ background:none; border:none; color:rgba(255,255,255,0.6); font-size:16px; cursor:pointer; padding:2px 4px; line-height:1; }
    #soporteChatCerrar:hover{ color:#fff; }

    .sc-msg-escalar{
      align-self:flex-start; max-width:85%; margin-top:-3px;
    }
    .sc-escalar-link{
      display:inline-flex; align-items:center; gap:5px;
      background:#25D366; color:#fff; text-decoration:none;
      font-family:'Inter',sans-serif; font-size:11.5px; font-weight:700;
      padding:6px 11px; border-radius:100px;
    }
    .sc-escalar-link:hover{ background:#20BD5A; }
    .sc-escalar-link svg{ width:13px; height:13px; flex-shrink:0; }

    #soporteChatBienvenida{
      flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:20px 18px; text-align:center; gap:14px; overflow-y:auto;
    }
    #soporteChatBienvenida h3{ font-family:'Archivo',sans-serif; font-size:16px; margin:0; color:#1B2420; }
    .sc-sugerencias{ display:flex; flex-direction:column; gap:7px; width:100%; }
    .sc-sugerencia{
      background:#F6F4EC; border:1px solid #E4E0D3; border-radius:10px;
      padding:9px 12px; font-size:12px; color:#1B2420; text-align:left;
      cursor:pointer; transition:background .12s;
    }
    .sc-sugerencia:hover{ background:#EFEBDD; }

    #soporteChatMensajes{
      flex:1; overflow-y:auto; padding:14px 14px 6px; display:none; flex-direction:column; gap:9px;
    }
    #soporteChatMensajes.show{ display:flex; }
    .sc-msg{ max-width:85%; padding:8px 11px; border-radius:11px; font-size:12.5px; line-height:1.4; }
    .sc-msg.bot{ background:#F6F4EC; color:#1B2420; align-self:flex-start; border-bottom-left-radius:3px; }
    .sc-msg.usuario{ background:#FF5A36; color:#fff; align-self:flex-end; border-bottom-right-radius:3px; }
    .sc-msg.error{ background:#FBE4DE; color:#B0402D; align-self:flex-start; border-bottom-left-radius:3px; }
    .sc-typing{ align-self:flex-start; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#8A9289; padding:0 4px; }

    #soporteChatForm{
      display:flex; align-items:center; gap:8px; padding:12px 14px; flex-shrink:0;
      border-top:1px solid #EEEBE0;
    }
    #soporteChatInput{
      flex:1; background:#F6F4EC; border:1px solid #E4E0D3; border-radius:100px; color:#1B2420;
      padding:9px 14px; font-size:12.5px; font-family:inherit; resize:none; max-height:70px;
    }
    #soporteChatInput:focus{ outline:none; border-color:#FF5A36; }
    #soporteChatEnviar{
      flex-shrink:0; width:32px; height:32px; border-radius:50%; background:#FF5A36; color:#fff;
      border:none; cursor:pointer; display:flex; align-items:center; justify-content:center;
    }
    #soporteChatEnviar:disabled{ opacity:.5; cursor:default; }
    #soporteChatEnviar svg{ width:15px; height:15px; }
    #soporteChatWhatsapp{
      flex-shrink:0; width:32px; height:32px; border-radius:50%; background:#25D366; color:#fff;
      display:flex; align-items:center; justify-content:center; text-decoration:none;
    }
    #soporteChatWhatsapp:hover{ background:#20BD5A; }
    #soporteChatWhatsapp svg{ width:16px; height:16px; flex-shrink:0; }
  `;

  const ICONO_BOT = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C10.9 2 10 2.9 10 4C10 4.7 10.4 5.4 11 5.7V7H7C5.3 7 4 8.3 4 10V17C4 18.7 5.3 20 7 20H17C18.7 20 20 18.7 20 17V10C20 8.3 18.7 7 17 7H13V5.7C13.6 5.4 14 4.7 14 4C14 2.9 13.1 2 12 2ZM7 9H17C17.6 9 18 9.4 18 10V17C18 17.6 17.6 18 17 18H7C6.4 18 6 17.6 6 17V10C6 9.4 6.4 9 7 9ZM8.5 11.5C7.7 11.5 7 12.2 7 13C7 13.8 7.7 14.5 8.5 14.5C9.3 14.5 10 13.8 10 13C10 12.2 9.3 11.5 8.5 11.5ZM15.5 11.5C14.7 11.5 14 12.2 14 13C14 13.8 14.7 14.5 15.5 14.5C16.3 14.5 17 13.8 17 13C17 12.2 16.3 11.5 15.5 11.5Z" fill="currentColor"/></svg>`;
  const ICONO_ENVIAR = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 11L21 3L13 21L11 13L3 11Z" fill="currentColor"/></svg>`;
  const ICONO_WHATSAPP = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.5 2 2 6.5 2 12C2 13.8 2.5 15.5 3.3 17L2 22L7.2 20.7C8.6 21.5 10.3 22 12 22C17.5 22 22 17.5 22 12C22 6.5 17.5 2 12 2ZM12 20.2C10.4 20.2 8.9 19.7 7.6 18.9L7.3 18.7L4.4 19.4L5.2 16.6L5 16.3C4.1 14.9 3.7 13.5 3.7 12C3.7 7.4 7.4 3.7 12 3.7C16.6 3.7 20.3 7.4 20.3 12C20.3 16.6 16.6 20.2 12 20.2ZM16.6 14.1C16.3 14 15 13.3 14.8 13.2C14.5 13.1 14.3 13.1 14.1 13.4C13.9 13.7 13.4 14.3 13.2 14.5C13 14.7 12.9 14.8 12.6 14.6C12.3 14.5 11.5 14.2 10.5 13.3C9.7 12.6 9.2 11.8 9 11.5C8.9 11.2 9 11.1 9.2 10.9C9.3 10.8 9.5 10.6 9.6 10.4C9.7 10.3 9.8 10.1 9.9 10C10 9.8 9.9 9.6 9.9 9.5C9.8 9.4 9.3 8.1 9.1 7.6C8.9 7.1 8.7 7.2 8.5 7.2C8.4 7.2 8.2 7.2 8 7.2C7.8 7.2 7.5 7.2 7.2 7.5C7 7.8 6.3 8.4 6.3 9.7C6.3 11 7.2 12.3 7.4 12.5C7.5 12.6 9.2 15.3 11.9 16.4C13.4 17 13.9 17.1 14.6 17C15 17 15.9 16.5 16.1 15.9C16.3 15.3 16.3 14.8 16.2 14.7C16.2 14.6 16 14.5 16.6 14.1Z" fill="currentColor"/></svg>`;

  const SUGERENCIAS = [
    '¿Qué significa el error 403?',
    '¿Cómo subo varias facturas a la vez?',
    '¿Qué es la conciliación de Cartera?',
    '¿Cómo conecto con Alegra?',
  ];

  const styleEl = document.createElement('style');
  styleEl.textContent = ESTILOS;
  document.head.appendChild(styleEl);

  const btn = document.createElement('button');
  btn.id = 'soporteChatBtn';
  btn.type = 'button';
  btn.title = 'Ayuda de Kárdex IA';
  btn.innerHTML = ICONO_BOT + '<span>Ayuda</span>';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'soporteChatPanel';
  panel.innerHTML = `
    <div id="soporteChatHeader">
      ${ICONO_BOT.replace('fill="currentColor"', 'fill="#FF5A36"')}
      <div class="titulos">
        <div class="titulo">Asistente Kárdex IA</div>
        <div class="subtitulo">No es asesoría tributaria</div>
      </div>
      <button id="soporteChatCerrar" type="button" title="Cerrar">✕</button>
    </div>
    <div id="soporteChatBienvenida">
      <h3>¿En qué puedo ayudarte hoy?</h3>
      <div class="sc-sugerencias">
        ${SUGERENCIAS.map((s) => `<button type="button" class="sc-sugerencia">${s}</button>`).join('')}
      </div>
    </div>
    <div id="soporteChatMensajes"></div>
    <form id="soporteChatForm">
      <textarea id="soporteChatInput" rows="1" placeholder="Escribe tu pregunta..." maxlength="1000"></textarea>
      <a id="soporteChatWhatsapp" href="${enlaceWhatsApp('')}" target="_blank" rel="noopener" title="Hablar directo con una persona de soporte por WhatsApp">${ICONO_WHATSAPP}</a>
      <button id="soporteChatEnviar" type="submit">${ICONO_ENVIAR}</button>
    </form>
  `;
  document.body.appendChild(panel);

  const bienvenidaEl = document.getElementById('soporteChatBienvenida');
  const mensajesEl = document.getElementById('soporteChatMensajes');
  const formEl = document.getElementById('soporteChatForm');
  const inputEl = document.getElementById('soporteChatInput');
  const enviarBtn = document.getElementById('soporteChatEnviar');

  let historial = []; // { rol: 'usuario'|'bot', texto }
  let abierto = false;

  function mostrarVistaConversacion() {
    bienvenidaEl.style.display = 'none';
    mensajesEl.classList.add('show');
  }

  function agregarMensaje(texto, tipo) {
    const div = document.createElement('div');
    div.className = 'sc-msg ' + tipo;
    div.textContent = texto;
    mensajesEl.appendChild(div);
    mensajesEl.scrollTop = mensajesEl.scrollHeight;
    return div;
  }

  function abrirPanel() {
    panel.classList.add('show');
    abierto = true;
    inputEl.focus();
  }
  function cerrarPanel() {
    panel.classList.remove('show');
    abierto = false;
  }

  btn.addEventListener('click', () => (abierto ? cerrarPanel() : abrirPanel()));
  document.getElementById('soporteChatCerrar').addEventListener('click', cerrarPanel);

  document.querySelectorAll('.sc-sugerencia').forEach((el) => {
    el.addEventListener('click', () => {
      inputEl.value = el.textContent;
      formEl.requestSubmit();
    });
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mensaje = inputEl.value.trim();
    if (!mensaje) return;

    mostrarVistaConversacion();
    agregarMensaje(mensaje, 'usuario');
    historial.push({ rol: 'usuario', texto: mensaje });
    inputEl.value = '';
    inputEl.disabled = true;
    enviarBtn.disabled = true;

    const typingEl = document.createElement('div');
    typingEl.className = 'sc-typing';
    typingEl.textContent = 'Escribiendo...';
    mensajesEl.appendChild(typingEl);
    mensajesEl.scrollTop = mensajesEl.scrollHeight;

    try {
      const res = await fetch('/api/soporte-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje, historial: historial.slice(0, -1) }),
      });
      const data = await res.json();
      typingEl.remove();
      if (!res.ok) throw new Error(data.error || 'No se pudo responder.');
      agregarMensaje(data.respuesta, 'bot');
      historial.push({ rol: 'bot', texto: data.respuesta });

      // Si el asistente mismo dice que esto ya se sale de lo que puede
      // resolver (regla #4 de su prompt: "sugiere contactar soporte
      // humano"), no lo dejamos ahí en solo texto -- se le pone de una
      // vez el botón de WhatsApp con el mensaje del contador ya
      // precargado, para que no tenga que ir a buscar el contacto aparte.
      if (/soporte (humano|técnico)|equipo (humano|de soporte)|chat en vivo|soporte@/i.test(data.respuesta)) {
        const escalarEl = document.createElement('div');
        escalarEl.className = 'sc-msg-escalar';
        escalarEl.innerHTML = `<a class="sc-escalar-link" href="${enlaceWhatsApp(mensaje)}" target="_blank" rel="noopener">${ICONO_WHATSAPP}<span>Hablar con soporte por WhatsApp</span></a>`;
        mensajesEl.appendChild(escalarEl);
        mensajesEl.scrollTop = mensajesEl.scrollHeight;
      }
    } catch (err) {
      typingEl.remove();
      agregarMensaje('No se pudo conectar con el asistente: ' + err.message, 'error');
    } finally {
      inputEl.disabled = false;
      enviarBtn.disabled = false;
      inputEl.focus();
    }
  });
})();