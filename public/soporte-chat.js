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
      position:fixed; bottom:24px; right:24px; z-index:9999;
      width:56px; height:56px; border-radius:50%; border:none;
      background:#FF5A36; color:#fff; font-size:24px; cursor:pointer;
      box-shadow:0 12px 28px -8px rgba(0,0,0,0.5);
      display:flex; align-items:center; justify-content:center;
      transition:transform .15s cubic-bezier(0.16,1,0.3,1);
    }
    #soporteChatBtn:hover{ transform:scale(1.06); }
    #soporteChatPanel{
      position:fixed; bottom:90px; right:24px; z-index:9999;
      width:340px; max-width:calc(100vw - 32px); height:460px; max-height:70vh;
      background:#171E20; border:1px solid #2B3436; border-radius:14px;
      box-shadow:0 30px 60px -20px rgba(0,0,0,0.65);
      display:none; flex-direction:column; overflow:hidden;
      font-family:'Inter', -apple-system, sans-serif;
    }
    #soporteChatPanel.show{ display:flex; }
    #soporteChatHeader{
      background:#0E1315; padding:14px 16px; display:flex; align-items:center;
      justify-content:space-between; border-bottom:1px solid #2B3436;
    }
    #soporteChatHeader .titulo{ font-family:'Archivo',sans-serif; font-weight:800; font-size:14px; color:#fff; }
    #soporteChatHeader .subtitulo{ font-family:'JetBrains Mono',monospace; font-size:10.5px; color:rgba(255,255,255,0.5); margin-top:2px; }
    #soporteChatCerrar{ background:none; border:none; color:rgba(255,255,255,0.6); font-size:18px; cursor:pointer; padding:0 4px; }
    #soporteChatMensajes{
      flex:1; overflow-y:auto; padding:14px 14px 6px; display:flex; flex-direction:column; gap:10px;
    }
    .sc-msg{ max-width:85%; padding:9px 12px; border-radius:12px; font-size:13px; line-height:1.4; }
    .sc-msg.bot{ background:#232C2E; color:#fff; align-self:flex-start; border-bottom-left-radius:3px; }
    .sc-msg.usuario{ background:#FF5A36; color:#fff; align-self:flex-end; border-bottom-right-radius:3px; }
    .sc-msg.error{ background:#3A2420; color:#FFB4A0; align-self:flex-start; border-bottom-left-radius:3px; }
    .sc-typing{ align-self:flex-start; font-family:'JetBrains Mono',monospace; font-size:11px; color:rgba(255,255,255,0.4); padding:0 4px; }
    #soporteChatForm{ display:flex; gap:8px; padding:12px; border-top:1px solid #2B3436; }
    #soporteChatInput{
      flex:1; background:#0E1315; border:1px solid #2B3436; border-radius:8px; color:#fff;
      padding:9px 11px; font-size:13px; font-family:inherit; resize:none;
    }
    #soporteChatInput:focus{ outline:none; border-color:#FF5A36; }
    #soporteChatEnviar{
      background:#FF5A36; color:#fff; border:none; border-radius:8px; padding:0 14px;
      font-size:13px; font-weight:600; cursor:pointer;
    }
    #soporteChatEnviar:disabled{ opacity:.5; cursor:default; }
  `;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const styleEl = document.createElement('style');
  styleEl.textContent = ESTILOS;
  document.head.appendChild(styleEl);

  const btn = document.createElement('button');
  btn.id = 'soporteChatBtn';
  btn.type = 'button';
  btn.title = 'Ayuda de Kárdex IA';
  btn.textContent = '💬';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'soporteChatPanel';
  panel.innerHTML = `
    <div id="soporteChatHeader">
      <div>
        <div class="titulo">Asistente Kárdex IA</div>
        <div class="subtitulo">Primera ayuda -- no es asesoría tributaria</div>
      </div>
      <button id="soporteChatCerrar" type="button" title="Cerrar">✕</button>
    </div>
    <div id="soporteChatMensajes"></div>
    <form id="soporteChatForm">
      <textarea id="soporteChatInput" rows="1" placeholder="Escribe tu pregunta..." maxlength="1000"></textarea>
      <button id="soporteChatEnviar" type="submit">Enviar</button>
    </form>
  `;
  document.body.appendChild(panel);

  const mensajesEl = document.getElementById('soporteChatMensajes');
  const formEl = document.getElementById('soporteChatForm');
  const inputEl = document.getElementById('soporteChatInput');
  const enviarBtn = document.getElementById('soporteChatEnviar');

  let historial = []; // { rol: 'usuario'|'bot', texto }
  let abierto = false;
  let yaSaludo = false;

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
    if (!yaSaludo) {
      agregarMensaje('¡Hola! Soy el asistente de Kárdex IA. Pregúntame si algo no te queda claro -- por ejemplo, qué significa un error, o cómo funciona alguna parte de la app.', 'bot');
      yaSaludo = true;
    }
    inputEl.focus();
  }
  function cerrarPanel() {
    panel.classList.remove('show');
    abierto = false;
  }

  btn.addEventListener('click', () => (abierto ? cerrarPanel() : abrirPanel()));
  document.getElementById('soporteChatCerrar').addEventListener('click', cerrarPanel);

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