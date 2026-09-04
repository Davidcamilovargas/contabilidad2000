// ---------- Chatbot de soporte -- widget flotante ----------
// Un solo archivo que se auto-inserta en cualquier página donde se
// incluya (<script src="/soporte-chat.js"></script> antes de
// </body>) -- no hay que tocar el HTML de cada página por separado.
// Primera capa de soporte: preguntas de "¿cómo funciona esto?" o
// "¿por qué me salió este error?", antes de escribirle a soporte
// humano. La conversación vive solo en memoria -- se reinicia si
// recargas la página, a propósito, para mantenerlo simple.

(function () {
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
  `;

  const ICONO_BOT = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C10.9 2 10 2.9 10 4C10 4.7 10.4 5.4 11 5.7V7H7C5.3 7 4 8.3 4 10V17C4 18.7 5.3 20 7 20H17C18.7 20 20 18.7 20 17V10C20 8.3 18.7 7 17 7H13V5.7C13.6 5.4 14 4.7 14 4C14 2.9 13.1 2 12 2ZM7 9H17C17.6 9 18 9.4 18 10V17C18 17.6 17.6 18 17 18H7C6.4 18 6 17.6 6 17V10C6 9.4 6.4 9 7 9ZM8.5 11.5C7.7 11.5 7 12.2 7 13C7 13.8 7.7 14.5 8.5 14.5C9.3 14.5 10 13.8 10 13C10 12.2 9.3 11.5 8.5 11.5ZM15.5 11.5C14.7 11.5 14 12.2 14 13C14 13.8 14.7 14.5 15.5 14.5C16.3 14.5 17 13.8 17 13C17 12.2 16.3 11.5 15.5 11.5Z" fill="currentColor"/></svg>`;
  const ICONO_ENVIAR = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 11L21 3L13 21L11 13L3 11Z" fill="currentColor"/></svg>`;

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