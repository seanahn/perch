'use strict';
// The Perch page: a tab bar over per-session panes. The host owns all state; this page
// only renders what it is sent and can be rebuilt from a replay at any time.

const LETTER = { claude: 'C', codex: 'X' };
function esc(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Glyphs are single-colour shapes, drawn as a CSS mask and tinted the way each vendor tints its own tab:
// Claude in its orange, ChatGPT in the theme's text colour so it reads on light and dark themes.
const TINT = { claude: '#D97757', codex: 'currentColor' };
function cssUrl(v) { return String(v).replace(/[^A-Za-z0-9:/._~?#@!$&*+,;=%-]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' '); }

function getHtml({ nonce, cspSource, icons = {} }) {
  const kinds = Object.keys(LETTER);
  const glyphCss = kinds.filter((k) => icons[k] && icons[k].glyph).map((k) =>
    `  .k.glyph.${k} { -webkit-mask: url("${cssUrl(icons[k].glyph)}") center / contain no-repeat; mask: url("${cssUrl(icons[k].glyph)}") center / contain no-repeat; background-color: ${TINT[k]}; }`).join('\n');
  // what the page script needs: which kinds have a glyph rule, and the image URI to fall back to
  const forPage = {}; for (const k of kinds) if (icons[k]) forPage[k] = { glyph: !!icons[k].glyph, image: icons[k].image || '' };
  // static badge for markup written in this template; the script builds the rest with badge()
  const badge = (kind) => { const i = icons[kind] || {};
    if (i.glyph) return `<span class="k glyph ${kind}"></span>`;
    if (i.image) return `<img class="k img" data-kind="${kind}" alt="" src="${esc(i.image)}">`;
    return `<span class="k ${kind}">${LETTER[kind]}</span>`; };
  const iconsJson = JSON.stringify(forPage).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; }
  #tabs { display: flex; align-items: stretch; border-bottom: 1px solid var(--vscode-panel-border); overflow-x: auto; scrollbar-width: thin; flex: none; position: relative; }
  .tab { display: flex; align-items: center; gap: 5px; padding: 5px 6px 5px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; border-right: 1px solid var(--vscode-panel-border); color: var(--vscode-tab-inactiveForeground); border-bottom: 2px solid transparent; max-width: 170px; }
  .tab:hover { background: var(--vscode-list-hoverBackground); }
  .tab.active { color: var(--vscode-tab-activeForeground); border-bottom-color: var(--vscode-focusBorder); background: var(--vscode-editor-background); }
  .k { flex: none; width: 15px; height: 15px; border-radius: 3px; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; color: #fff; }
  .k.claude { background: #c96442; } .k.codex { background: #10a37f; }
  img.k { background: none; object-fit: cover; display: inline-block; }
  .k.glyph { border-radius: 0; color: var(--vscode-foreground); }
${glyphCss}
  .tab .t { overflow: hidden; text-overflow: ellipsis; }
  .tab .b { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
  .tab.busy .b { background: var(--vscode-charts-orange); animation: pulse 1s infinite; }
  .tab.attn .b { background: var(--vscode-charts-red); animation: none; }
  .tab .x { flex: none; opacity: .5; padding: 0 3px; border-radius: 3px; }
  .tab .x:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  #add { flex: none; padding: 5px 10px; cursor: pointer; font-size: 14px; color: var(--vscode-descriptionForeground); }
  #add:hover { color: var(--vscode-foreground); }
  #menu { position: fixed; z-index: 10; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  #menu div { padding: 4px 10px; cursor: pointer; border-radius: 3px; display: flex; gap: 6px; align-items: center; font-size: 12px; }
  #menu div:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  @keyframes pulse { 50% { opacity: .3; } }
  #panes { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .bar label { flex: none; white-space: nowrap; }
  .bar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
  .bar .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar select { font-size: 11px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-green); flex: none; }
  .dot.busy { background: var(--vscode-charts-orange); animation: pulse 1s infinite; }
  .log { flex: 1; overflow-y: auto; padding: 8px; }
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
  .empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .btns { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
  .empty button { font-size: 12px; padding: 4px 12px; display: inline-flex; gap: 6px; align-items: center; }
  button { font-size: 11px; padding: 2px 10px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #compose { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); flex: none; }
  textarea { flex: 1; resize: none; min-height: 40px; max-height: 160px; font-family: inherit; font-size: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  /* last on purpose: an author display rule (.pane is flex) would otherwise override the hidden attribute */
  [hidden] { display: none !important; }
</style></head>
<body>
  <div id="tabs"><div id="add" title="New tab">+</div></div>
  <div id="panes"><div class="empty" id="empty"><div>No sessions yet.</div><div class="btns"><button id="e-claude">${badge('claude')}New Claude tab</button><button id="e-codex">${badge('codex')}New Codex tab</button></div></div></div>
  <div id="compose"><textarea id="input" rows="2" disabled placeholder="Open a tab with +"></textarea><button id="send" class="primary" disabled>Send</button></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $tabs = document.getElementById('tabs'), $add = document.getElementById('add'), $panes = document.getElementById('panes'), $empty = document.getElementById('empty');
  const $input = document.getElementById('input'), $send = document.getElementById('send');
  const panes = new Map();   // sid -> pane state
  let tabs = [], active = null, menu = null;
  const ICONS = ${iconsJson}, LETTER = { claude: 'C', codex: 'X' };

  // vendor icon when its extension is installed; a letter otherwise, or if the image fails to load
  function letter(kind) { const s = document.createElement('span'); s.className = 'k ' + kind; s.textContent = LETTER[kind] || '?'; return s; }
  function badge(kind) {
    const i = ICONS[kind];
    if (i && i.glyph) { const s = document.createElement('span'); s.className = 'k glyph ' + kind; return s; }
    if (!i || !i.image) return letter(kind);
    const img = document.createElement('img'); img.className = 'k img'; img.alt = ''; img.dataset.kind = kind; img.src = i.image;
    img.addEventListener('error', () => img.replaceWith(letter(kind)), { once: true });
    return img;
  }
  document.querySelectorAll('img.k').forEach((i) => i.addEventListener('error', () => i.replaceWith(letter(i.dataset.kind)), { once: true }));

  function el(tag, cls, text) { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }
  function fmtIn(v) { try { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch (_) { return String(v); } }

  function makePane(tab) {
    const root = el('div', 'pane'); root.hidden = true;
    const bar = el('div', 'bar'), dot = el('span', 'dot'), status = el('span', 'grow', 'idle'), label = el('label'), sel = el('select');
    label.append(tab.kind === 'claude' ? 'mode ' : 'sandbox ', sel);
    for (const m of tab.modes) { const o = el('option', null, m); o.value = m; sel.append(o); }
    sel.value = tab.mode;
    sel.addEventListener('change', () => vscode.postMessage({ type: 'setMode', sid: tab.id, value: sel.value }));
    const elabel = el('label'), eff = el('select');
    elabel.append('effort ', eff);
    for (const v of (tab.efforts || [''])) { const o = el('option', null, v || 'default'); o.value = v; eff.append(o); }
    eff.value = tab.effort || '';
    eff.title = tab.kind === 'claude' ? 'Reasoning effort. Changes apply from the next message.' : 'Reasoning effort. Set it before the first message in this tab.';
    eff.addEventListener('change', () => vscode.postMessage({ type: 'setEffort', sid: tab.id, value: eff.value }));
    bar.append(dot, status, elabel, label);
    const log = el('div', 'log');
    root.append(bar, log); $panes.append(root);
    const p = { root, log, dot, status, sel, eff, live: null, tools: {}, draft: '', kind: tab.kind };
    panes.set(tab.id, p); return p;
  }

  function add(p, cls, text) { const d = el('div', 'msg ' + cls, text); const stick = p.log.scrollHeight - p.log.scrollTop - p.log.clientHeight < 40; p.log.append(d); if (stick) p.log.scrollTop = p.log.scrollHeight; return d; }
  function endLive(p) { if (p.live) { p.live.remove(); p.live = null; } }

  function renderTabs() {
    $tabs.querySelectorAll('.tab').forEach((n) => n.remove());
    for (const t of tabs) {
      const d = el('div', 'tab' + (t.id === active ? ' active' : '') + (t.busy ? ' busy' : '') + (t.attention ? ' attn' : ''));
      d.title = t.title + ' · ' + t.kind;
      const k = badge(t.kind), tt = el('span', 't', t.title), b = el('span', 'b'), x = el('span', 'x', '×');
      x.title = 'Close tab';
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'close', sid: t.id }); });
      d.addEventListener('click', () => { if (t.id !== active) vscode.postMessage({ type: 'activate', sid: t.id }); });
      d.addEventListener('auxclick', (e) => { if (e.button === 1) vscode.postMessage({ type: 'close', sid: t.id }); });
      d.append(k, tt, b, x); $tabs.insertBefore(d, $add);
      if (t.id === active) d.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function applyTabs(next, nextActive) {
    const prev = active;
    if (prev && panes.has(prev)) panes.get(prev).draft = $input.value;
    tabs = next; active = nextActive;
    const ids = new Set(tabs.map((t) => t.id));
    for (const [id, p] of panes) if (!ids.has(id)) { p.root.remove(); panes.delete(id); }
    for (const t of tabs) { const p = panes.get(t.id) || makePane(t); p.sel.value = t.mode; p.eff.value = t.effort || ''; p.root.hidden = t.id !== active; }
    $empty.hidden = tabs.length > 0;
    renderTabs();
    const cur = tabs.find((t) => t.id === active), p = panes.get(active);
    if (prev !== active) { $input.value = p ? p.draft : ''; if (p) p.log.scrollTop = p.log.scrollHeight; }
    $input.disabled = !cur; $send.disabled = !cur;
    $input.placeholder = cur ? 'Message ' + cur.title + '… (Enter to send, Shift+Enter for newline)' : 'Open a tab with +';
    syncSend();
  }

  function syncSend() { const cur = tabs.find((t) => t.id === active); const busy = !!(cur && cur.busy); $send.textContent = busy ? 'Stop' : 'Send'; $send.className = busy ? '' : 'primary'; }

  function onEvent(sid, m) {
    const p = panes.get(sid); if (!p) return;
    switch (m.kind) {
      case 'user': endLive(p); add(p, 'user', m.text); break;
      case 'delta': if (!p.live) p.live = add(p, 'assistant live', ''); p.live.textContent += m.text; p.log.scrollTop = p.log.scrollHeight; break;
      case 'text': endLive(p); add(p, 'assistant', m.text); break;
      case 'thinking': endLive(p); add(p, 'thinking', m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text); break;
      case 'tool_use': { endLive(p); const d = add(p, 'tool', ''); d.append(el('span', 'name', m.name + (m.status ? ' · ' + m.status : '')), el('div', 'in', fmtIn(m.input))); if (m.id) p.tools[m.id] = d; break; }
      case 'tool_result': { const d = add(p, 'toolres' + (m.isError ? ' err' : ''), (m.text || '(no output)') + (m.truncated ? '\\n…' : '')); const a = p.tools[m.id]; if (a && a.nextSibling !== d) a.after(d); break; }
      case 'permission': {
        endLive(p); const d = add(p, 'perm', ''); const head = el('div'); head.append(el('b', null, 'Allow '), el('span', null, m.tool), '?');
        const btns = el('div', 'btns');
        for (const [dec, label, cls] of [['allow', 'Allow', 'primary'], ['always', 'Always', ''], ['deny', 'Deny', '']]) {
          if (dec === 'always' && !m.hasSuggestions) continue;
          const b = el('button', cls, label);
          b.addEventListener('click', () => { vscode.postMessage({ type: 'permission', sid, id: m.id, decision: dec }); d.className = 'msg status'; d.textContent = m.tool + ': ' + dec; });
          btns.append(b);
        }
        d.append(head, el('div', 'in', fmtIn(m.input)), btns); p.log.scrollTop = p.log.scrollHeight; break; }
      case 'result': { endLive(p); const u = m.usage || {}; add(p, 'result', (m.ok ? 'done' : 'failed' + (m.error ? ': ' + m.error : '')) + (m.duration_ms ? ' · ' + (m.duration_ms / 1000).toFixed(1) + 's' : '') + (u.input !== undefined ? ' · in ' + u.input + ' · cached ' + (u.cache_read || 0) + ' · out ' + u.output : '') + (m.cost !== undefined ? ' · $' + Number(m.cost).toFixed(2) : '')); break; }
      case 'note': endLive(p); add(p, 'status', m.text); break;
      case 'status': p.status.textContent = m.text; break;
      case 'session': p.status.title = 'session ' + m.id; break;
      case 'busy': p.dot.className = 'dot' + (m.busy ? ' busy' : ''); break;
      case 'error': endLive(p); add(p, 'error', m.text); break;
      case 'clear': p.log.textContent = ''; p.live = null; p.tools = {}; break;
      case 'fill': if (sid === active) { $input.value = m.text; $input.focus(); } else p.draft = m.text; break;
    }
  }

  function send() {
    const cur = tabs.find((t) => t.id === active); if (!cur) return;
    if (cur.busy) { vscode.postMessage({ type: 'stop', sid: active }); return; }
    const t = $input.value; if (!t.trim()) return;
    vscode.postMessage({ type: 'send', sid: active, text: t }); $input.value = ''; panes.get(active).draft = '';
  }
  $send.addEventListener('click', send);
  $input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const cur = tabs.find((t) => t.id === active); if (cur && !cur.busy) send(); } });

  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  $add.addEventListener('click', (e) => {
    e.stopPropagation(); if (menu) { closeMenu(); return; }
    menu = el('div'); menu.id = 'menu';
    for (const [kind, label] of [['claude', 'New Claude tab'], ['codex', 'New Codex tab']]) {
      const row = el('div'); row.append(badge(kind), label);
      row.addEventListener('click', () => { closeMenu(); vscode.postMessage({ type: 'new', kind }); });
      menu.append(row);
    }
    document.body.append(menu);
    const r = $add.getBoundingClientRect(); menu.style.top = (r.bottom + 2) + 'px'; menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4)) + 'px';
  });
  document.addEventListener('click', closeMenu);
  document.getElementById('e-claude').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'claude' }));
  document.getElementById('e-codex').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'codex' }));

  window.addEventListener('message', (e) => {
    const m = e.data; if (!m) return;
    if (m.type === 'tabs') applyTabs(m.tabs, m.active);
    else if (m.type === 'event') onEvent(m.sid, m.ev);
  });
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

module.exports = { getHtml };
