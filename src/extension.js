'use strict';
const vscode = require('vscode');
const { randomBytes, randomUUID } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');
const { loadClaudeModels, loadCodexModels, normalizeCommands } = require('./models');
const { MeterHost } = require('./meterHost');
const { VoiceHost } = require('./voiceHost');
const { resolveProgram } = require('./binaries');
const codexAuth = require('./codexAuth');
const { listSessions, renameSession, loadTranscript, cleanTitle, ago } = require('./sessionStore');

const MODES = {
  claude: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  codex: ['read-only', 'workspace-write', 'danger-full-access'],
};
// '' means "leave it to the agent's default". These lists are only the fallback used until the
// agent's own model catalog has loaded; after that, each model supplies its own effort levels.
const EFFORTS = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};
const STATE_KEY = 'perch.sessions.v1';
const UNSANDBOXED_KEY = 'perch.codex.unsandboxed';   // { hostname: true } for machines where Codex's sandbox cannot start
const PANEL_TYPE = 'perch.session';   // the webview panel type of an editor tab
// how long to wait for VS Code to bring back editor tabs before opening them ourselves (shortened by the tests)
const RESTORE_GRACE_MS = Number(process.env.PERCH_RESTORE_GRACE_MS) > 0 ? Number(process.env.PERCH_RESTORE_GRACE_MS) : 4000;
// Icons are read at runtime from the vendors' own installed extensions. perch ships no logos.
const VENDOR_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

/**
 * Each vendor extension ships a glyph (its activity-bar icon, a single-colour shape) and a
 * marketplace image (the glyph inverted on a filled tile). The glyph is what the vendor shows
 * on its own tabs, so it is preferred; the image is the fallback.
 * @returns {{ icons: Record<string,{glyph?:string,image?:string}>, roots: any[] }}
 */
function vendorIcons(webview) {
  const icons = {}; const roots = [];
  for (const [kind, id] of Object.entries(VENDOR_EXTENSIONS)) {
    try {
      const ext = vscode.extensions.getExtension(id);
      if (!ext || !ext.packageJSON) continue;               // not installed: the page falls back to a letter
      const pj = ext.packageJSON;
      const containers = (pj.contributes && pj.contributes.viewsContainers) || {};
      const bar = [...(containers.activitybar || []), ...(containers.secondarySidebar || []), ...(containers.panel || [])]
        .map((c) => c && c.icon).find((i) => typeof i === 'string' && /\.svg$/i.test(i));
      const uri = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(ext.extensionUri, rel)).toString();
      const entry = {};
      if (bar) entry.glyph = uri(bar);
      if (typeof pj.icon === 'string' && pj.icon) entry.image = uri(pj.icon);
      if (!entry.glyph && !entry.image) continue;
      icons[kind] = entry;
      roots.push(ext.extensionUri);
    } catch (_) { /* fall back to the letter badge */ }
  }
  return { icons, roots };
}
const MAX_HISTORY = 2000;
const MAX_KEPT_BYTES = 1500000;    // thumbnails saved with a tab, all messages together: about fifty screenshots at 320 px
// what both agents take as an image. The size is of the base64 text, which is what the services measure.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGES = 8, MAX_IMAGE_CHARS = 5000000;
const MAX_THUMB_CHARS = 80000;   // a thumbnail is kept in the transcript; the image itself is not
const MANY_IMAGES = 20;   // past this many images in a request, the API refuses any image of 2000 px or more; the agent keeps every earlier image until it compacts

/** The images of a message that can be sent, and how many of those offered cannot. */
function usableImages(list) {
  const all = Array.isArray(list) ? list : [], images = [];
  for (const i of all) {
    if (images.length >= MAX_IMAGES) break;
    if (i && IMAGE_TYPES.includes(i.mime) && typeof i.data === 'string' && i.data && i.data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) images.push({ mime: i.mime, data: i.data, thumb: thumbOf(i) });
  }
  return { images, dropped: all.length - images.length };
}
/** A small rendering of the image, as a data URL, for the transcript. The page makes it; the host only checks it is one. */
function thumbOf(i) {
  const t = i && i.thumb;
  return typeof t === 'string' && t.length <= MAX_THUMB_CHARS && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(t) ? t : '';
}

/**
 * The icon of an editor tab. VS Code tints nothing here, so the file must carry its own colour: Claude's glyph is
 * already orange; ChatGPT's comes in a black and a white version, for light and dark themes.
 */
function tabIcon(kind) {
  try {
    const ext = vscode.extensions.getExtension(VENDOR_EXTENSIONS[kind]);
    if (!ext || !ext.packageJSON) return undefined;
    const pj = ext.packageJSON, containers = (pj.contributes && pj.contributes.viewsContainers) || {};
    const glyph = [...(containers.activitybar || []), ...(containers.secondarySidebar || []), ...(containers.panel || [])].map((c) => c && c.icon).find((i) => typeof i === 'string' && /\.svg$/i.test(i));
    const at = (rel) => vscode.Uri.joinPath(ext.extensionUri, rel);
    const exists = (rel) => { try { return require('fs').existsSync(require('path').join(ext.extensionUri.fsPath || ext.extensionPath || '', rel)); } catch (_) { return false; } };
    if (glyph && /white/i.test(glyph)) {            // a white glyph is for dark themes; look for its dark twin
      const black = glyph.replace(/white/i, (m) => (m === 'White' ? 'Black' : m === 'WHITE' ? 'BLACK' : 'black'));
      if (exists(black)) return { light: at(black), dark: at(glyph) };
      return typeof pj.icon === 'string' && pj.icon ? at(pj.icon) : at(glyph);
    }
    if (glyph) return at(glyph);
    return typeof pj.icon === 'string' && pj.icon ? at(pj.icon) : undefined;
  } catch (_) { return undefined; }
}

/** A tab's name without the marks a tab's title carries while its session works or waits. */
function tabName(label) { return String(label || '').replace(/^\u25cf /, '').replace(/ \u2026$/, ''); }

function isPerchTab(t) { return !!(t && t.input && typeof t.input.viewType === 'string' && t.input.viewType.endsWith(PANEL_TYPE)); }

function cwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : require('os').homedir();
}
const IDE_MAX_CHARS = 12000;          // a selection longer than this is cut, and says so

/**
 * What the editor is looking at, for a Codex message: the active file and, if there is one, the selection.
 * @returns {{ block: string, tag: string } | null}  the text appended to the message, and a short label for the transcript
 */
// The file editor last focused. activeTextEditor is undefined while a Perch tab (a webview panel in the editor area) has
// the focus, which is exactly when a message is written; Claude Code's own panel remembers the last file the same way.
let lastFile = null;
function watchEditors(context) {
  const note = (ed) => { if (ed && ed.document && ed.document.uri.scheme === 'file') lastFile = ed.document.uri.fsPath; };
  note(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(note));
}
/** The editor to read: the active one, or the last file focused while it is still open somewhere on screen. */
function contextEditor() {
  const ed = vscode.window.activeTextEditor;
  if (ed) return ed;
  if (!lastFile) return null;
  return (vscode.window.visibleTextEditors || []).find((v) => v.document && v.document.uri.fsPath === lastFile) || null;
}
function ideContext() {
  const ed = contextEditor();
  if (!ed || !ed.document || ed.document.uri.scheme !== 'file') return null;
  const path = require('path');
  const abs = ed.document.uri.fsPath, r = path.relative(cwd(), abs);
  const file = r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs;
  const sel = ed.selection, lang = ed.document.languageId || '';
  const lines = ['', '', '<ide_context>', `Active file: ${file}` + (lang ? ` (${lang})` : '')];
  let tag = path.basename(file);     // the transcript's tag: the name, not the path; the agent gets the path
  if (sel && !sel.isEmpty) {
    let text = ed.document.getText(sel); const a = sel.start.line + 1, b = sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
    const cut = text.length > IDE_MAX_CHARS; if (cut) text = text.slice(0, IDE_MAX_CHARS);
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((x) => x.length + 1)));   // longer than any run inside
    lines.push(`Selection: lines ${a}-${b}` + (cut ? ` (first ${IDE_MAX_CHARS} characters)` : ''), fence + lang, text.replace(/\n$/, ''), fence);
    tag = `${path.basename(file)}:${a}` + (b > a ? `-${b}` : '');
  } else if (sel) lines.push(`Cursor: line ${sel.active.line + 1}`);
  lines.push('</ide_context>');
  return { block: lines.join('\n'), tag };
}

/**
 * The program an agent runs: the user's choice, else the SDK's own, else the one inside the vendor's extension.
 * @returns {{ path: string, from: string }}
 */
function program(kind) {
  let vendorRoot = ''; try { const ext = vscode.extensions.getExtension(VENDOR_EXTENSIONS[kind]); vendorRoot = (ext && (ext.extensionUri.fsPath || ext.extensionPath)) || ''; } catch (_) { /* not installed */ }
  return resolveProgram(kind, { configured: String(cfg(kind + '.executable') || ''), vendorRoot });
}
const MISSING = { claude: 'Perch runs the claude program that comes with the Claude Code extension, which is not installed here. Install it, or set perch.claude.executable to a claude program.', codex: 'Perch runs the codex program that comes with the ChatGPT extension, which is not installed here. Install it, or set perch.codex.executable to a codex program.' };

function cfg(key) { return vscode.workspace.getConfiguration('perch').get(key); }
function defaultEffort(kind) { return String((kind === 'claude' ? cfg('claude.effort') : cfg('codex.reasoningEffort')) || ''); }
function defaultModel(kind) { return String((kind === 'claude' ? cfg('claude.model') : cfg('codex.model')) || ''); }
function defaultMode(kind) { return kind === 'claude' ? (cfg('claude.permissionMode') || 'default') : (cfg('codex.sandboxMode') || 'workspace-write'); }

/** One tab: one agent process, one context. The host owns the transcript so the page can be rebuilt at any time. */
class Session {
  constructor(view, { id, kind, title, titled, unsaved, mode, effort, model, ide, resume, location, paneled, costSoFar, kept }) {
    this.view = view;
    this.id = id || randomUUID();
    this.kind = kind;
    this.title = title;
    this.titled = !!titled;          // true once the title came from the first message, or from the user
    this.unsaved = !!unsaved;        // the user's name for it has yet to reach the agent's own record of the session
    this.mode = mode || defaultMode(kind);
    this.model = typeof model === 'string' ? model : defaultModel(kind);     // '' = the agent's default model
    this.effort = typeof effort === 'string' ? effort : defaultEffort(kind);  // '' = the model's default effort
    this.actualModel = '';           // what the agent reported it is really running
    this.backend = '';               // claude only: the backend this tab's agent started on
    this.context = null;             // claude only: { percent, used, max } of the context window
    this.respondedAt = 0;            // when the agent last answered: the prompt cache is warm from then
    this.costSoFar = typeof costSoFar === 'number' ? costSoFar : null;   // claude only: the session's cost at API rates, as last reported, so each turn's own cost can be told
    this.queue = [];                 // codex only: messages waiting for the current turn to end
    this.thumbs = [];                // the thumbnails of each message sent, until the agent reports the message and they join it
    this.kept = Array.isArray(kept) ? kept : [];   // the thumbnails of every message sent with images, oldest first, saved with the tab: the agent's record has the images, not these
    this.ide = ide === undefined ? cfg('ideContext') !== false : !!ide;   // attach the active file and selection to each message, as the vendors' own panels do
    this.location = location === 'sidebar' || location === 'editor' ? location : view.where();   // which surface shows this tab
    this.paneled = !!paneled;        // an editor tab has been opened for it at some point, so VS Code will restore that tab
    this.prefill = '';               // text waiting for a page that is not ready yet
    this.reconcile();
    this.agentSessionId = resume || null;
    this.agent = null;               // started lazily on first message
    this.history = [];
    this.pending = new Map();        // permission id -> resolve
    this.busy = false;
    this.attention = false;          // a prompt is waiting while the tab is not active
    this.lastStatus = this.idleStatus();
    if (resume) { this.history.push(this.resumed = { kind: 'note', text: `resumed ${kind} session ${String(resume).slice(0, 8)} · earlier transcript is not shown, the agent still has it` }); this.loadPast(resume); }
  }

  /** Put what was said before in place of the note that says it is not shown. It is read from the agent's own record. */
  async loadPast(id) {
    let past; try { past = await loadTranscript(this.kind, id, { dir: cwd() }); } catch (_) { return; }   // the note stays as it is: the agent has the transcript, the page does not
    const at = this.history.indexOf(this.resumed);
    if (this.disposed || at < 0 || !past || !past.events.length) return;
    // the transcript speaks for itself; only what is missing from it is said, where it is missing
    const cut = past.earlier ? [{ kind: 'note', text: `${past.earlier} earlier entries are not shown, the agent still has them` }] : [];
    // the record has the images themselves, too large to show; the thumbnails saved with the tab rejoin the last messages that had images
    const withImages = past.events.filter((e) => e.kind === 'user' && e.images);
    for (let i = withImages.length - 1, k = this.kept.length - 1; i >= 0 && k >= 0; i--, k--) if (this.kept[k].some(Boolean)) withImages[i].thumbs = this.kept[k];
    this.history.splice(at, 1, ...cut, ...past.events);
    this.resumed = null;
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.view.replay(this);
  }

  idleStatus() { return 'idle'; }     // state only: mode, effort, and model have their own selectors

  // ---- what this tab may choose, given the agent's catalog and the selected model
  catalog() { return this.view.catalog[this.kind] || null; }
  selectedModel() {
    const cat = this.catalog(); if (!cat) return null;
    return this.model ? (cat.models.find((m) => m.value === this.model) || null) : cat.defaultModel;
  }
  allowedEfforts() {
    const m = this.selectedModel();
    if (m) return ['', ...m.efforts];
    return this.catalog() ? ['', ...new Set(this.catalog().models.flatMap((x) => x.efforts))] : EFFORTS[this.kind];   // unknown model, or no catalog yet
  }
  allowedModels() {
    const cat = this.catalog();
    const vals = cat ? cat.models.map((m) => m.value) : [];
    return ['', ...vals, ...(this.model && !vals.includes(this.model) ? [this.model] : [])];   // keep a saved or configured model the catalog does not list
  }
  /** Keep effort valid for the selected model. Returns true if it had to change. */
  reconcile() {
    if (this.allowedEfforts().includes(this.effort)) return false;
    this.effort = ''; return true;
  }
  modelOptions() {
    const cat = this.catalog(); const d = cat && cat.defaultModel;
    const opts = [{ value: '', label: 'default' + (d && d.label ? ' · ' + d.label : ''), title: 'The model the agent picks by default' }];
    for (const v of this.allowedModels().slice(1)) { const m = cat && cat.models.find((x) => x.value === v); opts.push({ value: v, label: m ? m.label : v, title: m ? m.description : 'not in the agent\'s model list' }); }
    return opts;
  }
  effortOptions() {
    const m = this.selectedModel(); const d = m && m.defaultEffort;
    return this.allowedEfforts().map((v) => (v ? { value: v, label: v } : { value: '', label: 'default' + (d ? ' · ' + d : '') }));
  }

  post(ev) {
    // a login that has expired shows as 401 from the API; the same offer follows the error
    if (ev.kind === 'error' && this.kind === 'codex' && /\b401\b.*Unauthorized/i.test(String(ev.text))) this.view.codexLogin(`Codex was refused: the login on ${require('os').hostname()} has expired or is missing.`);
    // Codex's Linux sandbox is bubblewrap, which needs user namespaces; a container that forbids them fails every command this way
    if (ev.kind === 'tool_result' && this.kind === 'codex' && this.mode !== 'danger-full-access' && !this.sandboxAsked && /bwrap: No permissions to create a new namespace/.test(String(ev.text))) { this.sandboxAsked = true; this.view.codexNoSandbox(this); }
    switch (ev.kind) {
      case 'status':
        this.lastStatus = ev.text;
        // the page shows whether a session works at the foot of its transcript; anything else an agent reports is part of the transcript
        if (!/^(idle|working|ready)\b/.test(String(ev.text))) this.post({ kind: 'note', text: String(ev.text) });
        break;
      case 'busy':
        if (!ev.busy && this.queue.length && this.agent && !this.stopping) { const next = this.queue.shift(); this.view.sendTabs(); setImmediate(() => { if (this.agent) this.agent.send(next.text, next.shown, next.images); }); return; }   // stay busy: the next queued message starts now
        this.stopping = false;
        if (!ev.busy && this.kind === 'codex' && this.busy) { const t = setTimeout(() => this.view.meter.refreshCodex(), 400); if (t.unref) t.unref(); }   // Codex has just recorded its limits
        if (ev.busy && !this.busy) this.busySince = Date.now(); else if (!ev.busy) this.busySince = 0;
        this.busy = !!ev.busy; this.view.sendTabs(); this.view.sendEvent(this.id, ev); this.post({ kind: 'status', text: this.busy ? 'working' : 'ready' });
        if (!this.busy) this.view.saveName(this);          // a tab named before its first turn: the agent has a record to write the name to now
        if (!this.busy && this.restartWhenIdle) { this.restart(); this.post({ kind: 'note', text: 'Moved to the new Claude backend; the conversation continues from the next message.' }); }
        return;
      case 'model': this.actualModel = ev.id; this.view.sendTabs(); return;
      case 'context': this.context = { percent: Math.max(0, Math.min(100, Math.round(ev.percent))), used: ev.used, max: ev.max }; if (ev.model) this.actualModel = ev.model; this.view.sendTabs(); return;
      case 'responded': this.respondedAt = ev.at; this.view.sendTabs(); return;
      case 'result': if (typeof ev.cost === 'number') { this.costSoFar = ev.cost; this.view.persist(); } break;
      case 'commands': this.view.setCommands(this.kind, ev.list); return;
      case 'session': this.agentSessionId = ev.id; this.view.persist(); break;
      case 'clear': this.history = []; this.resumed = null; break;
      case 'delta': case 'tool_start': case 'stderr': case 'mode': case 'fill': break;
      case 'user':
        // A queued Codex message is shown when it is queued. When its turn starts, the agent reports it again: that echo is dropped.
        if (this.kind === 'codex' && !ev.queued && this.shown && this.shown[0] === ev.text) { this.shown.shift(); return; }
        if (ev.images && this.thumbs.length) { const t = this.thumbs.shift(); if (t.some(Boolean)) ev.thumbs = t; this.keep(t); }
        if (!this.titled) { const name = ev.text.replace(/\s+/g, ' ').trim().slice(0, 28); if (name) { this.title = name; this.titled = true; this.view.sendTabs(); this.view.persist(); } }   // a message that is only an image names nothing
        this.history.push(ev); break;
      case 'permission': case 'question':
        if (!this.view.isVisible(this)) { this.attention = true; this.view.sendTabs(); }
        this.history.push(ev); break;
      default: this.history.push(ev);
    }
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.view.sendEvent(this.id, ev);
  }

  ensureAgent() {
    if (this.agent) return this.agent;
    const emit = (ev) => this.post(ev);
    const resume = this.agentSessionId || undefined;
    const prog = program(this.kind);
    if (prog.from === 'none') this.post({ kind: 'error', text: MISSING[this.kind] });
    if (this.kind === 'claude') {
      this.backend = this.view.meter ? this.view.meter.backend() : '';     // fixed for the life of the agent process
      this.agent = new ClaudeAgent({
        cwd: cwd(), emit, resume,
        permissionMode: this.mode,
        model: this.model || undefined,
        effort: this.effort || undefined,
        executable: prog.path || undefined,
        costBefore: this.costSoFar === null ? undefined : this.costSoFar,
        askPermission: (req) => new Promise((resolve) => this.pending.set(req.id, resolve)),
      });
    } else {
      this.agent = new CodexAgent({
        cwd: cwd(), emit, resume,
        sandboxMode: this.mode,
        approvalPolicy: cfg('codex.approvalPolicy'),
        model: this.model || undefined,
        reasoningEffort: this.effort || undefined,
        executable: prog.path || undefined,
      });
    }
    return this.agent;
  }

  /** A message sent while the agent is working is queued. Claude Code queues it itself; for Codex, whose SDK takes one
   * turn at a time, the queue is kept here and drained as each turn ends. */
  send(text, offered) {
    text = String(text || '');
    const { images, dropped } = usableImages(offered);
    if (dropped) this.post({ kind: 'note', text: `${dropped} image${dropped > 1 ? 's' : ''} left out: a message takes ${MAX_IMAGES} images, each a PNG, JPEG, GIF, or WebP of up to 5 MB` });
    // Once a Claude conversation carries more than 20 images, the API refuses every request in which any image is 2000 px
    // or wider, and every earlier image stays in the conversation until the agent compacts. Images pasted here are scaled
    // below that; those pasted through earlier versions, or read by Claude Code itself, may not be. The agent reports only
    // that an image could not be processed: so the tab says, once, what to do.
    if (images.length && this.kind === 'claude') {
      const before = this.history.reduce((n, h) => n + (h.kind === 'user' && h.images ? h.images : 0), 0), after = before + images.length;
      if (before < MANY_IMAGES && after >= MANY_IMAGES) this.post({ kind: 'note', text: `This conversation now carries ${after} images. Past ${MANY_IMAGES}, the API refuses a conversation holding any image 2000 px or wider, which images from earlier versions of perch or from Claude Code's own reading may be. If a turn then fails with "an image could not be processed", /compact lets the earlier images go.` });
    }
    if (!text.trim() && !images.length) return;
    // Claude with nothing to authenticate with here, on the backend it would get: hold the message, offer the way in
    if (this.kind === 'claude' && !this.agent && this.view.meter && !this.view.meter.canRun()) {
      const api = this.view.meter.backend() === 'api';
      this.post({ kind: 'note', text: api ? `Claude is set to API / Bedrock on ${require('os').hostname()}, and no credentials for it were found there. Set them up, or use your subscription, then send the message again.` : `Claude is not logged in on ${require('os').hostname()}. Log in, then send the message again.` });
      this.view.deliver(this.id, text);
      this.view.claudeLogin();
      return;
    }
    // Codex with no login here would only be refused (401, five reconnects, an error): hold the message, offer the login
    if (this.kind === 'codex' && !this.agent && !codexAuth.loggedIn()) {
      this.post({ kind: 'note', text: `Codex is not logged in on ${require('os').hostname()}. Log in, then send the message again.` });
      this.view.deliver(this.id, text);
      this.view.codexLogin();
      return;
    }
    const agent = this.ensureAgent();
    const thumbs = images.map((i) => i.thumb), sent = images.map((i) => ({ mime: i.mime, data: i.data }));
    // IDE context is read now, when the message is written, not later when a queued message starts
    const ctx = this.ide ? ideContext() : null;
    const full = ctx ? text + ctx.block : text, shown = { text, tag: ctx ? ctx.tag : undefined };
    if (this.kind !== 'codex') { if (sent.length) this.thumbs.push(thumbs); agent.send(full, sent, shown); return; }
    if (this.busy) {
      this.queue.push({ text: full, shown, images: sent }); (this.shown = this.shown || []).push(text);
      this.post(Object.assign({ kind: 'user', text, queued: true }, sent.length ? { images: sent.length } : {}, thumbs.some(Boolean) ? { thumbs } : {}, shown.tag ? { tag: shown.tag } : {}));
      this.view.sendTabs();          // the queue count is part of the tab
      return;
    }
    if (sent.length) this.thumbs.push(thumbs);
    agent.send(full, shown, sent);
  }

  setIde(on) { this.ide = !!on; this.view.persist(); }

  /** @param {Record<string,string>} [answers]  for a question: each question's answer, by the question's text */
  answerPermission(id, decision, answers) {
    const clean = answers && typeof answers === 'object' && !Array.isArray(answers) ? Object.fromEntries(Object.entries(answers).filter(([q, a]) => typeof q === 'string' && q && typeof a === 'string' && a.trim()).map(([q, a]) => [q, a.trim()])) : null;
    const r = this.pending.get(id);
    if (r) { this.pending.delete(id); r(decision === 'answer' ? { decision: clean && Object.keys(clean).length ? 'answer' : 'deny', answers: clean } : { decision }); }
    const i = this.history.findIndex((h) => (h.kind === 'permission' || h.kind === 'question') && h.id === id);
    if (i >= 0) {
      const h = this.history[i];
      if (h.kind === 'question') this.history[i] = { kind: 'answered', questions: h.questions, answers: clean || {} };
      else this.history[i] = { kind: 'note', text: `${h.tool}: ${decision}` };
    }
    if (!this.pending.size && this.attention) { this.attention = false; this.view.sendTabs(); }
  }

  setMode(value) {
    if (!MODES[this.kind].includes(value)) return;
    this.mode = value;
    this.view.persist();
    if (!this.agent) return;
    if (this.kind === 'claude') this.agent.setPermissionMode(value);
    else this.agent.setSandboxMode(value);                            // Codex: from the next turn
  }

  setEffort(value) {
    if (!this.allowedEfforts().includes(value)) return;
    this.effort = value;
    this.view.persist();
    if (!this.agent) return;
    this.agent.setEffort(value);          // Claude: from the next request. Codex: from the next turn
  }

  setModel(value) {
    if (!this.allowedModels().includes(value)) return;
    this.model = value;
    const effortReset = this.reconcile();                              // the new model may not accept the current effort
    this.view.persist();
    if (!this.agent) return;
    this.agent.setModel(value); if (effortReset) this.agent.setEffort('');
  }

  /** Stops the current turn and drops anything queued behind it. */
  interrupt() { if (!this.agent) return; if (this.queue.length) { this.post({ kind: 'note', text: `${this.queue.length} queued message${this.queue.length > 1 ? 's' : ''} dropped` }); this.queue = []; this.shown = []; this.view.sendTabs(); } this.stopping = true; this.agent.interrupt(); }
  lastAnswer() { return this.agent ? this.agent.lastAnswer : ''; }

  /** End the agent process and keep the session: the next message resumes it, as after a window reload. */
  restart() {
    this.restartWhenIdle = false;
    if (!this.agent) return;
    this.agent.dispose(); this.agent = null; this.backend = '';
    for (const r of this.pending.values()) r({ decision: 'deny', message: 'session restarted' });
    this.pending.clear();
    this.busy = false; this.busySince = 0; this.attention = false;
    this.view.sendTabs();
  }

  dispose() {
    this.disposed = true;
    if (this.agent) { this.agent.dispose(); this.agent = null; }
    for (const r of this.pending.values()) r({ decision: 'deny', message: 'session closed' });
    this.pending.clear();
  }

  toTab() {
    return {
      id: this.id, kind: this.kind, title: this.title, busy: this.busy, busySince: this.busy ? this.busySince || 0 : 0, attention: this.attention, started: !!this.agent,
      mode: this.mode, modes: MODES[this.kind],
      model: this.model, models: this.modelOptions(), actualModel: this.actualModel,
      effort: this.effort, efforts: this.effortOptions(),
      approvals: this.kind === 'codex' ? String(cfg('codex.approvalPolicy') || '') : '',
      backend: this.agent ? this.backend : '',
      queued: this.queue.length,
      ide: this.ide,
      context: this.kind === 'claude' ? this.context : null,
      // the prompt cache: how long it stays warm, and since when. Claude only; Codex does not expose its cache lifetime.
      cache: this.kind === 'claude' ? { minutes: this.view.meter.cacheMinutes(this.agent ? this.backend : ''), since: this.respondedAt } : null,
    };
  }
  toState() { return { id: this.id, kind: this.kind, title: this.title, titled: this.titled, unsaved: this.unsaved, mode: this.mode, effort: this.effort, model: this.model, ide: this.ide, resume: this.agentSessionId, location: this.location, paneled: this.paneled, costSoFar: this.costSoFar, kept: this.kept }; }

  /** Save a message's thumbnails with the tab, letting the oldest go once they would weigh too much. */
  keep(thumbs) {
    this.kept.push(thumbs.map((t) => (typeof t === 'string' ? t : '')));
    let bytes = this.kept.reduce((n, a) => n + a.reduce((m, t) => m + t.length, 0), 0);
    while (this.kept.length > 1 && bytes > MAX_KEPT_BYTES) bytes -= this.kept.shift().reduce((m, t) => m + t.length, 0);
    this.view.persist();
  }
}

/** The single Perch view: a tab bar over any number of sessions. */
/**
 * Perch itself. Sessions are shown on surfaces: the sidebar view, which has its own tab bar and shows every session that
 * lives there, and editor tabs, one session each, which are native VS Code tabs. Every surface is a page that can be
 * destroyed and rebuilt at any time, so all state lives here and is replayed to a page when it says it is ready.
 */
class PerchView {
  constructor(context) {
    this.context = context;
    this.sidebar = { view: null, ready: false };
    this.panels = new Map();         // session id -> { panel, ready }
    this.sessions = [];
    this.activeId = null;            // the active tab of the sidebar view
    this.counters = { claude: 0, codex: 0 };
    this.catalog = { claude: null, codex: null };   // filled from the agents; tabs fall back to static lists until then
    this.loading = null;
    this.commands = { claude: [], codex: [] };                 // slash commands, from the agent
    this.closing = false;
    this.graceTimer = null;
    this.meter = new MeterHost(context, (state, why, codex) => this.onMeter(state, why, codex));
    this.voice = new VoiceHost({
      root: (context.extensionUri && (context.extensionUri.fsPath || context.extensionUri.path)) || context.extensionPath || require('path').join(__dirname, '..'),
      send: (sid, ev) => this.sendEvent(sid, ev),
      deliver: (sid, text) => this.deliver(sid, text),
    });
    this.restore();
  }

  /** Where a new tab opens: as an editor tab, or in the sidebar view. */
  where() { return cfg('newTabs') === 'sidebar' ? 'sidebar' : 'editor'; }

  // kept for callers and tests that think of the sidebar as "the view"
  get view() { return this.sidebar.view; }
  get ready() { return this.sidebar.ready; }

  // ---- Claude usage and backend
  onMeter(state, why, codex) {
    this.raw({ type: 'meter', meter: state, codex });
    if (why !== 'backend') return;
    // models differ by backend, and a running process cannot change how it authenticated: so the process ends and the
    // session goes on, resumed by the next message on the new backend, as after a window reload
    this.loadCatalogs(true);
    for (const s of this.sessions) if (s.kind === 'claude' && s.agent && s.backend && s.backend !== state.backend) {
      if (s.busy) { s.restartWhenIdle = true; s.post({ kind: 'note', text: `Claude backend is now ${state.backendName}. This tab moves to it after the current turn; the conversation continues, the prompt cache starts over.` }); }
      else { s.restart(); s.post({ kind: 'note', text: `Claude backend is now ${state.backendName}. This tab continues on it from the next message; the prompt cache starts over.` }); }
    }
  }
  setCommands(kind, list) {
    const next = normalizeCommands(list);
    if (JSON.stringify(next) === JSON.stringify(this.commands[kind])) return;
    this.commands[kind] = next;
    this.raw({ type: 'commands', kind, list: next });
  }

  /** Put text into a session's message box, at the cursor. If its page is not there to take it, it waits. */
  /** Machines where Codex must run without a sandbox, by hostname; remembered across windows and reloads. */
  unsandboxedHosts() { const v = this.context.globalState.get(UNSANDBOXED_KEY); return v && typeof v === 'object' ? v : {}; }
  codexUnsandboxedHere() { return !!this.unsandboxedHosts()[require('os').hostname()]; }

  /**
   * Codex's sandbox could not start here: bubblewrap needs unprivileged user namespaces, which a container often
   * forbids, and Codex has no other sandbox on Linux (its legacy Landlock path is deprecated and, tried, fails too). The
   * way on is to run without one, which the user decides: for this tab, or for every tab on this machine from now on.
   */
  async codexNoSandbox(s) {
    if (this.sandboxOpen) return;
    this.sandboxOpen = true;
    try {
      const host = require('os').hostname();
      const pick = await vscode.window.showWarningMessage(`Codex's sandbox cannot start on ${host}: the kernel forbids the user namespaces it needs, and Codex has no other sandbox on Linux. Codex can run here without one, as you, with approvals as perch.codex.approvalPolicy says.`, 'Full Access, This Tab', `Full Access on ${host}`);
      if (!pick) return;
      if (pick !== 'Full Access, This Tab') { const hosts = this.unsandboxedHosts(); hosts[host] = true; await this.context.globalState.update(UNSANDBOXED_KEY, hosts); }
      if (s.disposed) return;
      s.setMode('danger-full-access'); this.sendTabs();
      s.post({ kind: 'note', text: `Codex runs without a sandbox in this tab${pick !== 'Full Access, This Tab' ? `, and in new tabs on ${host}` : ''}. Send the message again.` });
    } finally { this.sandboxOpen = false; }
  }

  /**
   * Offer the way into Claude, for a machine with nothing to authenticate with. On a subscription: Claude Code's own
   * sign-in (the meter's login), watched until it lands; or the switch to API / Bedrock. On API / Bedrock: the settings
   * file, where the credentials and region go; or the switch to the subscription, which offers its login. One at a time.
   */
  async claudeLogin() {
    if (this.claudeLoginOpen) return;
    this.claudeLoginOpen = true;
    try {
      const host = require('os').hostname();
      if (this.meter.backend() === 'api') {
        const pick = await vscode.window.showWarningMessage(`Claude is set to API / Bedrock on ${host}, but nothing to authenticate with was found there: no ~/.aws credentials or profile, no AWS_* variables, no ANTHROPIC_API_KEY. Put AWS credentials on ${host}, and the region and model in the env block of ${this.meter.meter.settingsPath} (AWS_REGION, ANTHROPIC_MODEL), or use your subscription.`, 'Open settings.json', 'Use Subscription');
        if (pick === 'Use Subscription') await this.meter.toggleBackend();        // with no login, the switch offers it
        else if (pick === 'Open settings.json') await this.openSettingsFile();
        return;
      }
      const pick = await vscode.window.showWarningMessage(`Claude is not logged in on ${host}. Perch runs Claude Code with its login, kept in ${this.meter.meter.claudeDir}. Log In opens Claude Code's sign-in; or use API / Bedrock credentials instead.`, 'Log In', 'Use API / Bedrock');
      if (pick === 'Use API / Bedrock') { await this.meter.toggleBackend(); return; }
      if (pick !== 'Log In') return;
      await this.meter.login();
      if (await this.meter.waitForLogin()) vscode.window.showInformationMessage('Perch: Claude is logged in. Send your message again.');
    } finally { this.claudeLoginOpen = false; }
  }

  /** Claude Code's settings file, made with an empty env block when there is none, so there is something to fill in. */
  async openSettingsFile() {
    const fs = require('fs'), path = require('path');
    const p = this.meter.meter.settingsPath;
    try { fs.accessSync(p); } catch (_) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '{\n  "env": {\n  }\n}\n'); } catch (e) { vscode.window.showErrorMessage('Perch: could not create ' + p + '. ' + e.message); return; } }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(p)));
  }

  /**
   * Offer the Codex login. "Log In" runs the browser sign-in here (`codex login`, which listens on a local port for the
   * browser's return) and opens its page on the user's machine; when remote, VS Code forwards the port, so the return
   * reaches this machine. That works for any user with a browser. "Device Code" is the terminal way, a link and a code,
   * for a ChatGPT account that allows it. One offer at a time.
   */
  async codexLogin(why) {
    if (this.codexLoginOpen) return;
    this.codexLoginOpen = true;
    try {
      const lead = why || `Codex is not logged in on ${require('os').hostname()}.`;
      const pick = await vscode.window.showWarningMessage(`${lead} Perch runs it with your ChatGPT login, kept in ${codexAuth.codexHome()}. Log In opens ChatGPT's sign-in page in your browser. Device Code prints a link and a one-time code in a terminal instead, which ChatGPT must allow first (Settings, Security and login, App security).`, 'Log In', 'Device Code');
      if (!pick) return;
      const prog = program('codex');
      if (prog.from === 'none') { vscode.window.showErrorMessage('Perch: ' + MISSING.codex); return; }
      const exe = prog.path || 'codex';
      let child = null;
      if (pick === 'Device Code') {
        const term = vscode.window.createTerminal({ name: 'Codex login' }); term.show(); term.sendText(codexAuth.loginCommand(exe));
      } else {
        let started;
        try { started = await codexAuth.startLogin(exe); } catch (e) { vscode.window.showErrorMessage('Perch: the Codex login could not start. ' + e.message); return; }
        child = started.child;
        // the browser returns to localhost on the user's machine; when remote, VS Code carries that port here
        try { await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${codexAuth.CALLBACK_PORT}`)); } catch (_) { /* no forwarding: the browser may still reach it directly */ }
        await vscode.env.openExternal(vscode.Uri.parse(started.url));
      }
      const ok = await codexAuth.waitForLogin();
      if (child) { try { child.kill(); } catch (_) { /* ended on its own */ } }
      if (ok) vscode.window.showInformationMessage('Perch: Codex is logged in. Send your message again.');
      else vscode.window.showWarningMessage('Perch: the Codex login did not complete.');
    } finally { this.codexLoginOpen = false; }
  }

  deliver(sid, text) {
    const s = this.get(sid); if (!s || !text) return;
    const f = this.surface(s);
    if (f && f.ready) this.sendEvent(sid, { kind: 'insert', text }); else s.prefill = (s.prefill ? s.prefill.replace(/\s*$/, ' ') : '') + text;
  }

  /** The + button: pick files, and mention them in the message by workspace-relative path. */
  async attach(sid) {
    const s = this.get(sid); if (!s) return;
    const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: 'Mention', defaultUri: root && root.uri, title: `Mention files in ${s.title}` });
    if (!picked || !picked.length) return;
    const rel = (u) => { const p = u.fsPath, base = cwd(); const r = require('path').relative(base, p); return r && !r.startsWith('..') && !require('path').isAbsolute(r) ? r : p; };
    this.sendEvent(sid, { kind: 'insert', text: picked.map((u) => '@' + rel(u)).join(' ') + ' ' });
  }

  /** Read both agents' model lists. Codex is a file read; Claude starts its CLI without sending a message. */
  loadCatalogs(force) {
    if (this.loading && !force) return this.loading;
    const apply = (kind, cat) => {
      if (!cat) return;
      this.catalog[kind] = cat;
      if (Array.isArray(cat.commands)) this.setCommands(kind, cat.commands);
      let changed = false; for (const s of this.sessions) if (s.kind === kind && s.reconcile()) changed = true;
      if (changed) this.persist();
      this.sendTabs();
    };
    try { apply('codex', loadCodexModels()); } catch (_) { /* keep the fallback lists */ }
    this.loading = Promise.resolve()
      .then(() => loadClaudeModels({ cwd: cwd(), executable: program('claude').path || undefined }))
      .then((cat) => apply('claude', cat))
      .catch(() => { /* keep the fallback lists */ });
    return this.loading;
  }

  // ---- persistence: tabs survive a window reload by resuming the agent's own saved session
  restore() {
    const saved = this.context.workspaceState.get(STATE_KEY);
    if (!saved || !Array.isArray(saved.sessions) || !saved.sessions.length) return;
    for (const s of saved.sessions) {
      if (s.kind !== 'claude' && s.kind !== 'codex') continue;
      this.counters[s.kind]++;
      this.sessions.push(new Session(this, s));       // a tab saved before editor tabs existed has no location: it goes where new tabs go
    }
    // counters are saved so a new tab never reuses the name of one that is still open
    for (const k of Object.keys(this.counters)) this.counters[k] = Math.max(this.counters[k], Number(saved.counters && saved.counters[k]) || 0);
    const side = this.sessions.filter((s) => s.location === 'sidebar');
    this.activeId = side.some((s) => s.id === saved.active) ? saved.active : (side[0] ? side[0].id : null);
  }
  persist() { this.context.workspaceState.update(STATE_KEY, { active: this.activeId, counters: this.counters, sessions: this.sessions.map((s) => s.toState()) }); }

  /**
   * Called once the extension is active. VS Code brings back the editor tabs that were open, through the serializer,
   * but only as each is shown: a tab behind another stays a tab without a page until it is clicked. So a session
   * whose page has not come back is not thereby without a tab. A tab that has never had an editor tab (it was moved
   * here from the sidebar by a change of setting) is opened now; one that has no tab left at all is opened after a
   * short wait, so no session is left without a surface.
   */
  start() {
    for (const s of this.sessions) if (s.location === 'editor' && !s.paneled) this.openPanel(s, { preserveFocus: true });
    if (this.sessions.some((s) => s.location === 'editor' && s.paneled)) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        const waiting = this.waitingTabs();
        for (const s of this.sessions) {
          if (s.location !== 'editor' || this.panels.has(s.id)) continue;
          const i = waiting.findIndex((t) => tabName(t.label) === s.title);
          if (i >= 0) waiting.splice(i, 1);                    // its tab is there, waiting to be shown
          else this.openPanel(s, { preserveFocus: true });
        }
      }, RESTORE_GRACE_MS);
      if (this.graceTimer.unref) this.graceTimer.unref();
    }
  }

  /**
   * An editor group that holds only sessions is locked, as a terminal's is: VS Code opens a file in the group that was
   * last used, which after a message is this one, and a locked group is passed over for the one beside it.
   */
  lockGroup() {
    if (cfg('lockGroup') === false) return;
    const g = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
    if (!g || !g.tabs || !g.tabs.length || !g.tabs.every(isPerchTab)) return;
    Promise.resolve(vscode.commands.executeCommand('workbench.action.lockEditorGroup')).catch(() => { /* an older VS Code */ });
  }

  /** Perch's editor tabs that have no page yet: VS Code has kept them, and will ask for each when it is shown. */
  waitingTabs() {
    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [], out = [];
    for (const g of groups) for (const t of g.tabs || []) if (isPerchTab(t)) out.push(t);
    // a tab with a page is known by its name; of tabs with one name, as many are waiting as have no page
    const have = [...this.panels.values()].map((e) => tabName(e.panel.title));
    return out.filter((t) => { const i = have.indexOf(tabName(t.label)); if (i < 0) return true; have.splice(i, 1); return false; });
  }

  // ---- surfaces
  mount(webview) {
    const { icons, roots } = vendorIcons(webview);
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, ...roots].filter(Boolean) };
    webview.html = getHtml({ nonce: randomBytes(16).toString('hex'), cspSource: webview.cspSource, icons });
  }

  resolveWebviewView(webviewView) {
    this.sidebar = { view: webviewView, ready: false };
    this.mount(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg, null));
    webviewView.onDidDispose(() => { if (this.sidebar.view === webviewView) this.sidebar = { view: null, ready: false }; });
  }

  /** The column new editor tabs open in: beside the other Perch tabs if there are any, otherwise beside the editor. */
  column() {
    for (const { panel } of this.panels.values()) if (panel.viewColumn !== undefined) return panel.viewColumn;
    return vscode.ViewColumn.Beside;
  }
  panelTitle(s) { return (s.attention ? '● ' : '') + s.title + (s.busy ? ' …' : ''); }

  openPanel(s, { preserveFocus } = {}) {
    if (this.panels.has(s.id)) { this.panels.get(s.id).panel.reveal(undefined, !!preserveFocus); return; }
    // a tab of its own may be waiting, without a page: the new tab takes its place, so the session has one tab
    const old = this.waitingTabs().find((t) => tabName(t.label) === s.title);
    if (old && vscode.window.tabGroups.close) Promise.resolve(vscode.window.tabGroups.close(old, true)).catch(() => { /* it went by itself */ });
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, this.panelTitle(s), { viewColumn: this.column(), preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
    this.attachPanel(s, panel);
  }

  attachPanel(s, panel) {
    const entry = { panel, ready: false };
    this.panels.set(s.id, entry);
    s.paneled = true;
    panel.title = this.panelTitle(s);
    const icon = tabIcon(s.kind); if (icon) panel.iconPath = icon;
    this.mount(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, s.id));
    panel.onDidChangeViewState(() => { if (panel.active) this.lockGroup(); if (panel.visible && s.attention && !s.pending.size) { s.attention = false; this.sendTabs(); } });
    if (panel.active) setImmediate(() => { if (panel.active && this.panels.get(s.id) === entry) this.lockGroup(); });
    // closing the editor tab closes the session, unless the tab is going away for another reason (a move, or shutdown)
    panel.onDidDispose(() => { if (this.panels.get(s.id) !== entry) return; this.panels.delete(s.id); if (!this.closing && this.get(s.id) && s.location === 'editor') this.closeSession(s.id); });
    this.persist();
  }

  /** VS Code restoring an editor tab after a reload. The page remembers which session it showed. */
  deserializeWebviewPanel(panel, state) {
    const s = state && state.sid ? this.get(state.sid) : null;
    if (!s || s.location !== 'editor' || this.panels.has(s.id)) { panel.dispose(); return Promise.resolve(); }   // the session is gone, moved, or already has a tab
    this.attachPanel(s, panel);
    return Promise.resolve();
  }

  surface(s) { if (!s) return null; if (s.location === 'editor') { const e = this.panels.get(s.id); return e ? { webview: e.panel.webview, ready: e.ready } : null; } return this.sidebar.view ? { webview: this.sidebar.view.webview, ready: this.sidebar.ready } : null; }
  isVisible(s) { if (s.location === 'editor') { const e = this.panels.get(s.id); return !!(e && e.panel.visible); } return this.activeId === s.id && !!(this.sidebar.view && this.sidebar.view.visible !== false); }

  /** To every page: things that are not about one session. */
  raw(msg) {
    if (this.sidebar.ready && this.sidebar.view) this.sidebar.view.webview.postMessage(msg);
    for (const e of this.panels.values()) if (e.ready) e.panel.webview.postMessage(msg);
  }
  sendEvent(sid, ev) { const f = this.surface(this.get(sid)); if (f && f.ready) f.webview.postMessage({ type: 'event', sid, ev }); }
  sendTabs() {
    if (this.sidebar.ready && this.sidebar.view) this.sidebar.view.webview.postMessage({ type: 'tabs', tabs: this.sessions.filter((s) => s.location === 'sidebar').map((s) => s.toTab()), active: this.activeId });
    for (const [sid, e] of this.panels) {
      const s = this.get(sid); if (!s) continue;
      const title = this.panelTitle(s); if (e.panel.title !== title) e.panel.title = title;
      if (e.ready) e.panel.webview.postMessage({ type: 'tabs', tabs: [s.toTab()], active: sid, single: true });
    }
  }
  replay(s) {
    this.sendEvent(s.id, { kind: 'clear' });
    for (const ev of s.history) this.sendEvent(s.id, ev);
    this.sendEvent(s.id, { kind: 'busy', busy: s.busy });
    this.sendEvent(s.id, { kind: 'status', text: s.lastStatus });
    if (s.prefill) { this.sendEvent(s.id, { kind: 'fill', text: s.prefill }); s.prefill = ''; }
  }
  get(id) { return this.sessions.find((s) => s.id === id); }
  /** The session the user is looking at: the focused editor tab if there is one, otherwise the sidebar's active tab. */
  active() {
    for (const [sid, e] of this.panels) if (e.panel.active) return this.get(sid);
    return this.get(this.activeId) || null;
  }

  /** @param {string|null} from  the session id of the editor tab the message came from, or null for the sidebar */
  onMessage(msg, from) {
    const s = msg.sid ? this.get(msg.sid) : null;
    switch (msg.type) {
      case 'ready': {
        const mine = from ? this.sessions.filter((x) => x.id === from) : this.sessions.filter((x) => x.location === 'sidebar');
        if (from) { const e = this.panels.get(from); if (!e) return; e.ready = true; } else this.sidebar.ready = true;
        this.sendTabs();                 // no tabs are created for you: a fresh workspace starts empty
        const to = from ? this.panels.get(from).panel.webview : this.sidebar.view.webview;
        to.postMessage({ type: 'meter', meter: this.meter.state(), codex: this.meter.codexState() });
        for (const k of Object.keys(this.commands)) if (this.commands[k].length) to.postMessage({ type: 'commands', kind: k, list: this.commands[k] });
        this.loadCatalogs();
        for (const x of mine) { this.replay(x); this.voice.resend(x.id); }
        return;
      }
      case 'send': if (s) s.send(msg.text, msg.images); return;
      case 'stop': if (s) s.interrupt(); return;
      case 'permission': if (s) s.answerPermission(msg.id, msg.decision, msg.answers); return;
      case 'setMode': if (s) { s.setMode(msg.value); this.sendTabs(); } return;
      case 'setEffort': if (s) { s.setEffort(msg.value); this.sendTabs(); } return;
      case 'setModel': if (s) { s.setModel(msg.value); this.sendTabs(); } return;
      case 'attach': this.attach(msg.sid); return;
      case 'setIde': if (s) { s.setIde(msg.value); this.sendTabs(); } return;
      case 'meterRefresh': if (msg.vendor === 'codex') this.meter.refreshCodex(); else this.meter.poll(); return;
      case 'meterToggle': this.meter.toggleBackend(); return;
      case 'meterLogin': this.meter.login(); return;
      case 'voiceStart': if (s) this.voice.start(s.id); return;
      case 'voiceStop': if (s) this.voice.stop(s.id); return;
      case 'voiceCancel': this.voice.cancel(); return;
      case 'activate': this.activate(msg.sid); return;
      case 'new': this.addSession(msg.kind); return;
      case 'close': this.closeSession(msg.sid); return;
      case 'rename': if (s) this.renameTab(s.id); return;
      case 'open': this.openTarget(msg.target); return;
      case 'copy': vscode.env.clipboard.writeText(String(msg.text || '')); return;
      case 'history': this.pickSession(); return;
      default: return;
    }
  }

  // ---- session management
  /** @param {object} [o]  `resume` opens the tab on a session the agent has already recorded, under the name it has there */
  addSession(kind, { fill, location, resume, title } = {}) {
    if (kind !== 'claude' && kind !== 'codex') return null;
    const vendor = kind === 'claude' ? 'Claude' : 'Codex';
    // a machine where Codex's sandbox cannot start (codexNoSandbox): new Codex tabs run without one, and say so
    const mode = kind === 'codex' && this.codexUnsandboxedHere() ? 'danger-full-access' : undefined;
    const s = new Session(this, resume
      ? { kind, title: cleanTitle(title) || `${vendor} ${String(resume).slice(0, 8)}`, titled: true, resume, mode, location: location || this.where() }
      : { kind, title: `${vendor} ${++this.counters[kind]}`, mode, location: location || this.where() });
    this.sessions.push(s);
    if (mode) s.history.push({ kind: 'note', text: `Codex runs without a sandbox on ${require('os').hostname()}: the kernel forbids the user namespaces its sandbox needs.` });
    if (fill) s.prefill = fill;
    if (s.location === 'editor') { this.openPanel(s); this.sendTabs(); return s; }     // its page asks for the replay when it is ready
    this.activeId = s.id;
    this.persist();
    this.sendTabs();
    this.replay(s);
    return s;
  }

  async pickNew() {
    const pick = await vscode.window.showQuickPick([{ label: 'Claude', description: 'New Claude Code tab', kind: 'claude' }, { label: 'Codex', description: 'New Codex tab', kind: 'codex' }], { placeHolder: 'New Perch tab' });
    return pick ? this.addSession(pick.kind) : null;
  }

  closeSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.sessions[i];
    this.voice.closed(id);
    s.dispose();
    this.sessions.splice(i, 1);
    const e = this.panels.get(id);
    if (e) { this.panels.delete(id); e.panel.dispose(); }
    if (this.activeId === id) { const side = this.sessions.filter((x) => x.location === 'sidebar'); const at = this.sessions.slice(0, i).filter((x) => x.location === 'sidebar').length; const next = side[Math.min(at, side.length - 1)]; this.activeId = next ? next.id : null; }
    if (!this.sessions.length) this.counters = { claude: 0, codex: 0 };   // nothing open, nothing to collide with: numbering starts over
    this.persist();
    this.sendTabs();
  }

  /** A link in an answer that names a file, as `path`, `path#L12`, `path#L12-L20`, or `path:12`. It is looked for in every workspace folder. */
  async openTarget(target) {
    const fs = require('fs'), path = require('path');
    const m = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?::\d+)?)?$/.exec(String(target || '').replace(/^file:\/\//, ''));
    let file = m[1]; try { file = decodeURIComponent(file); } catch (_) { /* it is not encoded */ }
    if (!file) return;
    const from = Number(m[2] || m[4]) || 0, to = Math.max(from, Number(m[3]) || 0);
    const roots = [...new Set([...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath), cwd()])];
    const hit = (path.isAbsolute(file) ? [file] : roots.map((r) => path.join(r, file))).find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
    if (!hit) { vscode.window.showWarningMessage(`Perch: ${file} is not a file in this workspace.`); return; }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit));
      // beside the sessions, not among them: in the first group that is not theirs
      const other = ((vscode.window.tabGroups && vscode.window.tabGroups.all) || []).find((g) => !(g.tabs || []).some(isPerchTab));
      await vscode.window.showTextDocument(doc, Object.assign({ viewColumn: other ? other.viewColumn : vscode.ViewColumn.Beside }, from ? { selection: new vscode.Range(from - 1, 0, to - 1, 0) } : {}));
    } catch (e) { vscode.window.showWarningMessage(`Perch: ${file} could not be opened. ${e.message}`); }
  }

  // ---- names, and the sessions of the past
  /**
   * Name a tab. The name also goes into the agent's own record of the session, so every client shows the same one.
   * @returns {Promise<boolean>} false if there was no name to give
   */
  async setTitle(s, title) {
    const name = cleanTitle(title);
    if (!s || !name) return false;
    s.title = name; s.titled = true; s.unsaved = true;
    this.persist();
    this.sendTabs();
    await this.saveName(s);
    return true;
  }

  /** Write a tab's name to its agent's record. A tab that has not had a turn has no record yet: this runs again when its first turn ends. */
  async saveName(s) {
    if (!s.unsaved || !s.agentSessionId) return;
    s.unsaved = false;                 // tried once: a record that cannot be written is not retried after every turn
    this.persist();
    try { await renameSession(s.kind, s.agentSessionId, s.title, { dir: cwd() }); }
    catch (e) { vscode.window.showWarningMessage(`Perch: this tab keeps its name, but ${s.kind === 'claude' ? 'Claude Code' : 'Codex'}'s record of the session could not be given it. ${e.message}`); }
  }

  askName(current) {
    return vscode.window.showInputBox({ title: 'Rename session', value: current, prompt: 'The name is saved with the session, so it is the same wherever the session is listed.', validateInput: (v) => (cleanTitle(v) ? null : 'A name cannot be empty.') });
  }

  async renameTab(id) {
    const s = (id && this.get(id)) || this.active();
    if (!s) return;
    const name = await this.askName(s.title);
    if (name !== undefined) await this.setTitle(s, name);
  }

  /** Rename a session from the list, whether or not a tab is open on it. */
  async renamePast(past) {
    const name = cleanTitle(await this.askName(past.title));
    if (!name) return;
    const open = this.sessions.find((s) => s.kind === past.kind && s.agentSessionId === past.id);
    if (open) { await this.setTitle(open, name); return; }
    try { await renameSession(past.kind, past.id, name, { dir: cwd() }); }
    catch (e) { vscode.window.showErrorMessage(`Perch: the session could not be renamed. ${e.message}`); }
  }

  /** Open a tab on a past session, or go to the tab that is already open on it: two agents must not write one record. */
  resumeSession(past) {
    const open = this.sessions.find((s) => s.kind === past.kind && s.agentSessionId === past.id);
    if (!open) return this.addSession(past.kind, { resume: past.id, title: past.title });
    this.activate(open.id);
    if (open.location === 'sidebar' && this.sidebar.view && this.sidebar.view.show) this.sidebar.view.show(true);
    return open;
  }

  /** The list of past sessions of this folder, from both agents: type to search, choose one to open it, or rename it. */
  async pickSession() {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Perch sessions'; qp.placeholder = 'Search sessions…'; qp.matchOnDescription = true; qp.busy = true;
    qp.onDidAccept(() => { const it = qp.selectedItems[0]; qp.hide(); if (it) this.resumeSession(it.past); });
    // the box that asks for the name takes the list's place, so the list is opened again afterwards, with the new name in it
    qp.onDidTriggerItemButton(async (e) => { qp.hide(); await this.renamePast(e.item.past); await this.pickSession(); });
    qp.onDidHide(() => qp.dispose());
    qp.show();
    const { sessions, failed } = await listSessions({ dir: cwd(), limit: 200 });
    const rename = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename session' };
    qp.items = sessions.map((p) => {
      const open = this.sessions.find((s) => s.kind === p.kind && s.agentSessionId === p.id);
      const past = open && open.unsaved ? Object.assign({}, p, { title: open.title }) : p;
      return { label: past.title, description: [p.kind === 'claude' ? 'Claude' : 'Codex', ago(p.updatedAt), open ? 'open' : ''].filter(Boolean).join(' · '), iconPath: tabIcon(p.kind), buttons: [rename], past };
    });
    const missing = failed.map((k) => (k === 'claude' ? 'Claude Code' : 'Codex')).join(' and ');
    if (!sessions.length) qp.placeholder = missing ? `The sessions of ${missing} could not be read` : 'No past sessions in this folder';
    else if (missing) qp.title = `Perch sessions · those of ${missing} could not be read`;
    qp.busy = false;
    return qp;
  }

  /** Bring a tab to the front, wherever it lives. */
  activate(id) {
    const s = this.get(id);
    if (!s) return;
    if (s.location === 'editor') { this.openPanel(s); if (s.attention && !s.pending.size) { s.attention = false; this.sendTabs(); } return; }
    this.activeId = id;
    if (s.attention && !s.pending.size) s.attention = false;
    this.persist();
    this.sendTabs();
  }

  /** Move a tab between the sidebar and the editor area. The session, its agent, and its transcript are untouched. */
  move(id, location) {
    const s = this.get(id);
    if (!s || s.location === location || (location !== 'editor' && location !== 'sidebar')) return;
    if (location === 'editor') {
      s.location = 'editor';
      if (this.activeId === id) { const side = this.sessions.filter((x) => x.location === 'sidebar'); this.activeId = side[0] ? side[0].id : null; }
      this.openPanel(s);
    } else {
      const e = this.panels.get(id);
      s.location = 'sidebar'; s.paneled = false;
      if (e) { this.panels.delete(id); e.panel.dispose(); }
      this.activeId = id;
    }
    this.persist();
    this.sendTabs();
    if (location === 'sidebar') { this.replay(s); if (this.sidebar.view && this.sidebar.view.show) this.sidebar.view.show(true); }
  }
  moveAll(location) { for (const s of this.sessions.slice()) this.move(s.id, location); }

  async handoff() {
    const from = this.active();
    const text = from ? from.lastAnswer() : '';
    if (!text) { vscode.window.showInformationMessage('The active Perch tab has no answer to hand off yet.'); return; }
    const items = [
      ...this.sessions.filter((s) => s.id !== from.id).map((s) => ({ label: s.title, description: s.kind, sid: s.id })),
      { label: 'New Claude tab', description: 'claude', kind: 'claude' },
      { label: 'New Codex tab', description: 'codex', kind: 'codex' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Send the last answer from "${from.title}" to…` });
    if (!pick) return;
    if (!pick.sid) { this.addSession(pick.kind, { fill: text, location: from.location }); return; }
    const to = this.get(pick.sid);
    this.activate(pick.sid);
    const f = this.surface(to);
    if (f && f.ready) this.sendEvent(pick.sid, { kind: 'fill', text }); else to.prefill = text;
    if (to.location === 'sidebar' && this.sidebar.view) this.sidebar.view.show(true);
  }

  dispose() {
    this.closing = true;             // the editor tabs are going away with the window, not being closed by the user
    clearTimeout(this.graceTimer);
    for (const s of this.sessions) s.dispose();
    this.meter.dispose();
    this.voice.dispose();
  }
}

function activate(context) {
  watchEditors(context);
  const perch = new PerchView(context);
  perch.meter.start();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.main', perch, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, perch),
    vscode.commands.registerCommand('perch.new', () => perch.pickNew()),
    vscode.commands.registerCommand('perch.newClaude', () => perch.addSession('claude')),
    vscode.commands.registerCommand('perch.newCodex', () => perch.addSession('codex')),
    vscode.commands.registerCommand('perch.stop', () => { const s = perch.active(); if (s) s.interrupt(); }),
    vscode.commands.registerCommand('perch.closeTab', () => { const s = perch.active(); if (s) perch.closeSession(s.id); }),
    vscode.commands.registerCommand('perch.handoff', () => perch.handoff()),
    vscode.commands.registerCommand('perch.sessions', () => perch.pickSession()),
    vscode.commands.registerCommand('perch.renameTab', () => perch.renameTab()),
    vscode.commands.registerCommand('perch.moveToEditor', () => { const s = perch.active(); if (s) perch.move(s.id, 'editor'); }),
    vscode.commands.registerCommand('perch.moveToSidebar', () => { const s = perch.active(); if (s) perch.move(s.id, 'sidebar'); }),
    vscode.commands.registerCommand('perch.moveAllToEditor', () => perch.moveAll('editor')),
    vscode.commands.registerCommand('perch.moveAllToSidebar', () => perch.moveAll('sidebar')),
    vscode.commands.registerCommand('perch.refreshModels', () => perch.loadCatalogs(true)),
    vscode.commands.registerCommand('perch.meter.refresh', () => perch.meter.poll()),
    vscode.commands.registerCommand('perch.meter.toggleBackend', () => perch.meter.toggleBackend()),
    vscode.commands.registerCommand('perch.meter.login', () => perch.meter.login()),
    vscode.commands.registerCommand('perch.voice.setup', async () => { const r = await perch.voice.prepare(true); if (r === 'already') vscode.window.showInformationMessage('Perch: voice input is already set up here.'); else if (r) vscode.window.showInformationMessage('Perch: voice input is ready.'); }),
    vscode.commands.registerCommand('perch.voice.toggle', () => { const s = perch.active(); if (s) perch.voice.start(s.id); }),
    vscode.commands.registerCommand('perch.voice.cancel', () => perch.voice.cancel()),
    vscode.commands.registerCommand('perch.voice.unload', () => perch.voice.unload()),
    { dispose: () => perch.dispose() },
  );
  perch.start();
  return perch;   // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
