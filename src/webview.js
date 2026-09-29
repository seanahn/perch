'use strict';
// Panel HTML. One template for both agents; `agent` selects the mode control.

function getHtml({ agent, nonce, cspSource, modes, modeLabel, initialMode }) {
  const modeOptions = modes.map((m) => `<option value="${m}"${m === initialMode ? ' selected' : ''}>${m}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; }
  #bar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-descriptionForeground); }
  #bar .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #bar select { font-size: 11px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-green); flex: none; }
  #dot.busy { background: var(--vscode-charts-orange); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  #log { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  .user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-focusBorder); }
  .assistant { background: var(--vscode-editor-background); }
  .live { opacity: .85; }
  .thinking { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-blue); }
  .tool .name { font-weight: 600; }
  .tool .in { color: var(--vscode-descriptionForeground); white-space: pre-wrap; max-height: 6em; overflow: hidden; }
  .toolres { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-panel-border); max-height: 8em; overflow: auto; }
  .toolres.err { border-left-color: var(--vscode-charts-red); color: var(--vscode-errorForeground); }
  .status { color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center; }
  .error { color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-charts-red); }
  .result { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; }
  .perm { border: 1px solid var(--vscode-inputValidation-warningBorder); background: var(--vscode-inputValidation-warningBackground); }
  .perm .btns { display: flex; gap: 6px; margin-top: 6px; }
  button { font-size: 11px; padding: 2px 10px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #compose { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; resize: none; min-height: 40px; max-height: 160px; font-family: inherit; font-size: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
</style></head>
<body>
  <div id="bar"><span id="dot"></span><span id="status" class="grow">starting…</span><label>${modeLabel} <select id="mode">${modeOptions}</select></label></div>
  <div id="log"></div>
  <div id="compose"><textarea id="input" rows="2" placeholder="Message ${agent}… (Enter to send, Shift+Enter for newline)"></textarea><button id="send" class="primary">Send</button></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log'), input = document.getElementById('input'), status = document.getElementById('status'), dot = document.getElementById('dot'), mode = document.getElementById('mode');
  let live = null; const tools = {};
  function add(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
  function endLive() { if (live) { live.remove(); live = null; } }
  function fmtIn(input) { try { const s = typeof input === 'string' ? input : JSON.stringify(input, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch (_) { return String(input); } }
  function send() { const t = input.value; if (!t.trim()) return; vscode.postMessage({ type: 'send', text: t }); input.value = ''; }
  document.getElementById('send').onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  mode.addEventListener('change', () => vscode.postMessage({ type: 'setMode', value: mode.value }));
  window.addEventListener('message', (e) => {
    const ev = e.data; if (!ev || ev.type !== 'event') return; const m = ev.ev;
    switch (m.kind) {
      case 'user': endLive(); add('user', m.text); break;
      case 'delta': if (!live) live = add('assistant live', ''); live.textContent += m.text; log.scrollTop = log.scrollHeight; break;
      case 'text': endLive(); add('assistant', m.text); break;
      case 'thinking': endLive(); add('thinking', m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text); break;
      case 'tool_start': break;
      case 'tool_use': { endLive(); const d = add('tool', ''); d.innerHTML = '<span class="name"></span><div class="in"></div>'; d.querySelector('.name').textContent = m.name + (m.status ? ' · ' + m.status : ''); d.querySelector('.in').textContent = fmtIn(m.input); if (m.id) tools[m.id] = d; break; }
      case 'tool_result': { const d = add('toolres' + (m.isError ? ' err' : ''), (m.text || '(no output)') + (m.truncated ? '\\n…' : '')); const anchor = tools[m.id]; if (anchor && anchor.nextSibling !== d) anchor.after(d); break; }
      case 'permission': {
        const d = add('perm', ''); d.innerHTML = '<div><b>Allow ' + '</b><span class="t"></span>?</div><div class="in"></div><div class="btns"><button class="primary" data-d="allow">Allow</button><button data-d="always">Always</button><button data-d="deny">Deny</button></div>';
        d.querySelector('.t').textContent = m.tool; d.querySelector('.in').textContent = fmtIn(m.input);
        if (!m.hasSuggestions) d.querySelector('[data-d="always"]').remove();
        d.querySelectorAll('button').forEach((b) => b.onclick = () => { vscode.postMessage({ type: 'permission', id: m.id, decision: b.dataset.d }); d.className = 'msg status'; d.textContent = m.tool + ': ' + b.dataset.d; });
        break; }
      case 'result': endLive(); { const u = m.usage || {}; add('result', (m.ok ? 'done' : 'failed' + (m.error ? ': ' + m.error : '')) + (m.duration_ms ? ' · ' + (m.duration_ms / 1000).toFixed(1) + 's' : '') + (u.input !== undefined ? ' · in ' + u.input + ' · cached ' + (u.cache_read || 0) + ' · out ' + u.output : '') + (m.cost !== undefined ? ' · $' + Number(m.cost).toFixed(2) : '')); } break;
      case 'status': status.textContent = m.text; break;
      case 'note': endLive(); add('status', m.text); break;
      case 'session': status.title = 'session ' + m.id; break;
      case 'busy': dot.className = m.busy ? 'busy' : ''; break;
      case 'error': endLive(); add('error', m.text); break;
      case 'stderr': break;
      case 'clear': log.innerHTML = ''; endLive(); break;
      case 'mode': mode.value = m.value; break;
      case 'fill': input.value = m.text; input.focus(); break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

module.exports = { getHtml };
