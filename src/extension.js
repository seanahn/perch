'use strict';
const vscode = require('vscode');
const { randomBytes, randomUUID } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');
const { loadClaudeModels, loadCodexModels, normalizeCommands, modelEntry, modelLabel, sameModel, fallbackNote } = require('./models');
const { MeterHost } = require('./meterHost');
const { VoiceHost } = require('./voiceHost');
const { CodeIndex } = require('./codeIndex');
const { resolveProgram, sdkCodex, terminalRun } = require('./binaries');
const codexAuth = require('./codexAuth');
const Gateway = require('./gateway');
const Prices = require('./prices');
const { shortModel } = require('./relay');
const { listSessions, renameSession, deleteSession, loadTranscript, cleanTitle, ago, titleOf, sessionUsage, claudeSessionUsage } = require('./sessionStore');
const Handoff = require('./handoff');

const VENDOR = { claude: 'Claude', codex: 'Codex' };
const MODE_NAMES = { default: 'Ask', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass', 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access' };

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
const GATEWAY_DEFAULT_KEY = 'perch.claude.newTabsOnGateway';   // true once the gateway was chosen for a tab, until the subscription or API / Bedrock is; new Claude tabs follow it
const REFUSED_LOGIN_KEY = 'perch.codex.refusedLogin';   // the authStamp of the Codex login Codex last refused here, until auth.json holds another
const UNSANDBOXED_KEY = 'perch.codex.unsandboxed';   // { hostname: true } for machines where Codex's sandbox cannot start
const PANEL_TYPE = 'perch.session';   // the webview panel type of an editor tab
// how long to wait for VS Code to bring back editor tabs before opening them ourselves (shortened by the tests)
const RESTORE_GRACE_MS = Number(process.env.PERCH_RESTORE_GRACE_MS) > 0 ? Number(process.env.PERCH_RESTORE_GRACE_MS) : 4000;
// how long after a Perch tab leaves a group its lock is looked at: a tab that takes the place of another opens a moment
// after the old one closes (shortened by the tests)
const UNLOCK_DELAY_MS = Number(process.env.PERCH_UNLOCK_DELAY_MS) > 0 ? Number(process.env.PERCH_UNLOCK_DELAY_MS) : 150;
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
const MAX_PAST_SHOWN = 1000;   // entries of a switched tab's earlier transcript shown, as sessionStore shows of one record
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

function isUri(v) { return !!(v && typeof v === 'object' && typeof v.scheme === 'string'); }

/** Every resource a tab shows: its file, both sides of a diff, each pair of a multi-file diff, the files of a merge. */
function tabUris(t) {
  const out = [], add = (v) => { if (isUri(v)) out.push(String(v)); };
  for (const v of Object.values((t && t.input) || {})) if (Array.isArray(v)) { for (const d of v) Object.values(d || {}).forEach(add); } else add(v);
  return out;
}

/** The ids `workbench.editor.autoLockGroups` knows a tab's editor by, as far as the tab API tells. */
function editorIds(t) {
  const i = t && t.input;
  if (!i) return [];
  if (typeof vscode.TabInputTerminal === 'function' && i instanceof vscode.TabInputTerminal) return ['terminalEditor'];
  const ids = [];
  if (typeof i.viewType === 'string') ids.push(i.viewType);           // a webview's (mainThreadWebview-…) or a custom editor's
  if (typeof i.notebookType === 'string') ids.push(i.notebookType);
  if (i.inputBoxUri) ids.push('workbench.input.interactive');
  else if (!ids.length && (i.uri || i.modified)) ids.push('default');   // text, and a text diff
  return ids;
}

/** Whether a version such as VS Code's '1.92.0' is at least major.minor. */
function atLeast(version, major, minor) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

function cwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : require('os').homedir();
}

/** Every folder in a multi-root workspace except the primary working directory. */
function additionalCwds() {
  const primary = cwd();
  return [...new Set((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath))].filter((p) => p !== primary);
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
/** Settles when `term` is closed: by the user, or, for a terminal that runs a program itself, as the program ends. `dispose` stops listening. */
function whenClosed(term) {
  let sub = null;
  const p = new Promise((resolve) => { sub = vscode.window.onDidCloseTerminal((t) => { if (t === term) { sub.dispose(); resolve(); } }); });
  p.dispose = () => sub.dispose();
  return p;
}
const MISSING = { claude: 'Perch runs the claude program that comes with the Claude Code extension, which is not installed here. Install it, or set perch.claude.executable to a claude program.', codex: 'Perch runs the codex program that comes with the ChatGPT extension, which is not installed here. Install it, or set perch.codex.executable to a codex program.' };

function cfg(key) { return vscode.workspace.getConfiguration('perch').get(key); }
function defaultEffort(kind) { return String((kind === 'claude' ? cfg('claude.effort') : cfg('codex.reasoningEffort')) || ''); }
function defaultModel(kind) { return String((kind === 'claude' ? cfg('claude.model') : cfg('codex.model')) || ''); }
function defaultMode(kind) { return kind === 'claude' ? (cfg('claude.permissionMode') || 'default') : (cfg('codex.sandboxMode') || 'workspace-write'); }

/** One tab: one agent process, one context. The host owns the transcript so the page can be rebuilt at any time. */
/** The answers to a question Codex asked without waiting, as the message that carries them to it. */
function codexAnswer(questions, answers) {
  const qs = (questions || []).filter((q) => q && typeof q.question === 'string');
  const lines = qs.map((q) => `- ${q.question}\n  ${answers[q.question] || '(no answer)'}`);
  return (qs.length > 1 ? 'Answers to the questions you asked:' : 'An answer to the question you asked:') + '\n' + lines.join('\n');
}

/** What a sub-agent's own thread file has said of it, as the page shows it: its model and effort, turns, tokens, nickname, and every model it used when there was more than one. */
function collabInfo(a) {
  const out = { model: a.model, effort: a.effort || '', turns: a.turns || 0, tokens: Object.assign({ input: 0, cached: 0, output: 0 }, a.tokens || {}) };
  if (a.nickname) out.nickname = a.nickname;
  if (Array.isArray(a.models) && a.models.length > 1) out.models = a.models;
  return out;
}

class Session {
  constructor(view, { id, kind, title, titled, unsaved, named, mode, effort, model, ide, resume, location, paneled, costSoFar, kept, gateway, gatewayCost, gatewayEstimate, periods, left, handoff }) {
    this.view = view;
    this.id = id || randomUUID();
    this.kind = kind;
    this.title = title;
    this.titled = !!titled;          // true once the title came from the first message, or from the user
    this.unsaved = !!unsaved;        // the user's name for it has yet to reach the agent's own record of the session
    this.named = !!named;            // the user named this tab: its title is theirs, and the agent's own title for the session does not replace it
    this.mode = mode || defaultMode(kind);
    this.model = typeof model === 'string' ? model : defaultModel(kind);     // '' = the agent's default model
    this.effort = typeof effort === 'string' ? effort : defaultEffort(kind);  // '' = the model's default effort
    this.actualModel = '';           // what the agent reported it is really running
    this.swap = null;                // claude only: Claude Code moved this session to another model after a refusal: { from, to, category }
    this.search = '';                // the folders the agent's process searches (codeindex/), as it was given them; '' for none
    this.backend = '';               // claude only: the backend this tab's agent started on
    this.gateway = kind === 'claude' && !!gateway;   // claude only: this tab runs through the gateway (src/gateway.js), whatever the window's backend
    this.via = {};                   // gateway only: the models that answered this turn's requests, by name, with how many each
    this.lastVia = '';               // gateway only: the model that answered most recently, for the tooltip
    this.viaCost = null;             // gateway only: the gateway's own figure for this turn so far, summed over its requests; null until one is reported
    this.gatewayCost = typeof gatewayCost === 'number' ? gatewayCost : 0;   // gateway only: the gateway's figure for the whole session, saved with the tab
    this.viaQueue = [];              // gateway only: the models that answered this turn's requests, in order, until each response's token counts arrive
    this.viaEstimate = null;         // gateway only: this turn so far at the answering models' list rates (src/prices.js); null until a response is priced
    this.gatewayEstimate = typeof gatewayEstimate === 'number' ? gatewayEstimate : 0;   // gateway only: that, for the whole session, saved with the tab
    this.keySpend = null;            // gateway only: what the gateway says this token has spent in all, as of its last response
    this.context = null;             // claude only: { percent, used, max } of the context window
    this.respondedAt = 0;            // when the agent last answered: the prompt cache is warm from then
    this.costSoFar = typeof costSoFar === 'number' ? costSoFar : null;   // claude only: the session's cost at API rates, as last reported, so each turn's own cost can be told
    this.collab = new Map();         // codex only: the sub-agents of the running turn, by name: { state: working|finished|interrupted, at, reports }
    this.queue = [];                 // codex only: messages waiting for the current turn to end
    this.thumbs = [];                // the thumbnails of each message sent, until the agent reports the message and they join it
    this.kept = Array.isArray(kept) ? kept : [];   // the thumbnails of every message sent with images, oldest first, saved with the tab: the agent's record has the images, not these
    this.ide = ide === undefined ? cfg('ideContext') !== false : !!ide;   // attach the active file and selection to each message, as the vendors' own panels do
    this.location = location === 'sidebar' || location === 'editor' ? location : view.where();   // which surface shows this tab
    this.paneled = !!paneled;        // an editor tab has been opened for it at some point, so VS Code will restore that tab
    this.prefill = '';               // text waiting for a page that is not ready yet
    this.reconcile();
    this.agentSessionId = resume || null;
    // the vendors this tab has been on, in order, each with its agent's session (note 202); the last is the current one.
    // A tab that has never switched has one.
    this.periods = Array.isArray(periods) && periods.length && periods[periods.length - 1].kind === kind
      ? periods.filter((p) => p && (p.kind === 'claude' || p.kind === 'codex')).map((p) => Object.assign({ kind: p.kind, resume: p.resume || null, said: p.said !== false }, typeof p.note === 'string' ? { note: p.note } : {}, p.warn ? { warn: true } : {}))
      : [{ kind, resume: this.agentSessionId, said: !!this.agentSessionId }];   // said: something was said in it, or it opened on a record that has words
    this.periods[this.periods.length - 1].resume = this.agentSessionId;
    this.left = left && typeof left === 'object' ? left : {};       // a vendor this tab left: its settings and its session, for a switch back
    this.handoff = handoff && typeof handoff.text === 'string' ? handoff : null;   // the earlier conversation, sent ahead of the first message after a switch
    this.agent = null;               // started lazily on first message
    this.history = [];
    this.pending = new Map();        // permission id -> resolve
    this.busy = false;
    this.attention = false;          // a prompt is waiting while the tab is not active
    this.lastStatus = this.idleStatus();
    if (this.periods.length > 1) { this.history.push(this.resumed = { kind: 'note', text: 'earlier transcript is not shown yet, the agents still have it' }); this.loadPeriods(); }
    else if (resume) { this.history.push(this.resumed = { kind: 'note', text: `resumed ${kind} session ${String(resume).slice(0, 8)} · earlier transcript is not shown, the agent still has it` }); this.loadPast(resume); }
  }

  /**
   * Where this tab's agent runs, for a switch to say where the conversation goes: the service by name, and the account it is
   * billed to when that is the user's own rather than the vendor's ('aws' for Bedrock, 'gateway'), else ''.
   */
  where() {
    const m = this.view.meter;
    if (this.kind === 'claude') {
      if (this.gateway) return { kind: 'claude', name: 'the LLM gateway', account: 'gateway' };
      return m && m.backend() === 'api' ? { kind: 'claude', name: 'API / Bedrock', account: 'aws' } : { kind: 'claude', name: 'your Claude subscription', account: '' };
    }
    const b = m ? m.codexBackend() : 'chatgpt';
    return b === 'bedrock' ? { kind: 'codex', name: 'Amazon Bedrock', account: 'aws' } : b === 'api' ? { kind: 'codex', name: 'an OpenAI API key', account: '' } : { kind: 'codex', name: 'your ChatGPT login', account: '' };
  }

  /** What this tab's switch to a vendor says in its transcript: the divider. */
  switchNote(p) {
    const h = p.handoff;
    return { kind: 'note', vendor: p.kind, ...(p.live && h ? { actions: [{ id: 'handoffPreview', label: 'Preview' }] } : {}), ...(h && h.leaves ? { level: 'warn' } : {}), text: `Continued on ${VENDOR[p.kind]}${p.model ? ' with ' + p.model : ''}` + (h ? ` · read ${h.messages} message${h.messages === 1 ? '' : 's'} of the conversation above (about ${Math.max(1, Math.round(h.tokens / 1000))}K tokens)${h.fits ? '' : `, all ${h.total} in a file`}` : '') + (h && h.route ? ` · ${h.route}` : '') + (p.resumed ? ` · its own conversation from before goes on` : '') };
  }

  /**
   * A tab that has been on both vendors: its transcript is read back from each agent's own record, in the order the tab
   * went, each record cut where the tab came back to it (Handoff.stretches), with the divider at each switch.
   */
  async loadPeriods() {
    const records = new Map();
    try {
      for (const p of this.periods) {
        const key = p.kind + ':' + p.resume;
        if (!p.resume || records.has(key)) continue;
        const past = await loadTranscript(p.kind, p.resume, { dir: cwd(), limit: Infinity });
        records.set(key, Handoff.stretches(past.events));
      }
    } catch (_) { return; }   // the note stays: the agents have the transcript, the page does not
    const at = this.history.indexOf(this.resumed);
    if (this.disposed || at < 0) return;
    const events = [];
    this.periods.forEach((p, i) => {
      // the last switch's conversation not sent yet: its divider keeps its Preview through a reload
      const waiting = i === this.periods.length - 1 && this.handoff && !this.handoffSent;
      if (i) events.push(Object.assign(this.switchNote(Object.assign({}, p, waiting ? { live: true, handoff: this.handoff } : {})), p.note ? { text: p.note } : {}, p.warn ? { level: 'warn' } : {}));
      const list = p.resume && p.said ? records.get(p.kind + ':' + p.resume) : null;   // a stretch with nothing said yet has nothing on record
      if (list && list.length) events.push(...list.shift());
    });
    const earlier = Math.max(0, events.length - MAX_PAST_SHOWN);
    const shown = earlier ? [{ kind: 'note', text: `${earlier} earlier entries are not shown, the agents still have them` }, ...events.slice(earlier)] : events;
    this.history.splice(at, 1, ...shown);
    this.resumed = null;
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.view.replay(this);
  }

  /**
   * What the other vendor would be handed, were this tab to switch now: this vendor's part of the conversation since the
   * tab last came to it. Null when there is nothing to hand over (no turn yet).
   */
  async prepareHandoff() {
    if (!this.agentSessionId) return null;
    const events = await Handoff.loadDiscussion(this.kind, this.agentSessionId, { dir: cwd() });
    const parts = Handoff.stretches(events), mine = parts[parts.length - 1];
    if (!mine || !mine.length) return null;
    const n = this.periods.length, file = Handoff.handoffFile(this.id, n);
    const cat = this.catalog(), model = this.running() ? modelLabel(cat, this.running()) || this.running() : this.model ? modelLabel(cat, this.model) || this.model : '';
    const r = Handoff.handoffText(mine, { agent: VENDOR[this.kind], model, cwd: cwd(), file });
    if (!r.messages) return null;
    return Object.assign(r, { file });
  }

  /**
   * Go on in this tab with the other vendor (note 202). The conversation cannot move, so the new agent is given this one's
   * words ahead of the user's next message: a new conversation, or the one this tab had with that vendor before, which
   * goes on. Settings are the vendor's own: those the tab had on it before, else its defaults; a mode is never carried
   * across. Only an idle tab switches.
   * @param {'claude'|'codex'} kind
   * @param {{ model?: string, handoff?: object|null }} [o]  `handoff` as prepareHandoff made it
   */
  switchVendor(kind, { model, handoff } = {}) {
    if ((kind !== 'claude' && kind !== 'codex') || kind === this.kind || this.busy || this.pending.size) return false;
    if (handoff && !handoff.fits) Handoff.writeHandoff(handoff.file, handoff.full);
    const from = this.where();
    this.left[this.kind] = { model: this.model, effort: this.effort, mode: this.mode, gateway: this.gateway, costSoFar: this.costSoFar, resume: this.agentSessionId };
    this.restart();
    const back = this.left[kind] || null;
    delete this.left[kind];
    this.kind = kind;
    this.agentSessionId = back && back.resume ? back.resume : null;
    this.model = typeof model === 'string' ? model : back ? back.model : defaultModel(kind);
    this.effort = back ? back.effort : defaultEffort(kind);
    this.mode = back && MODES[kind].includes(back.mode) ? back.mode : kind === 'codex' && this.view.codexUnsandboxedHere() ? 'danger-full-access' : defaultMode(kind);
    this.gateway = kind === 'claude' && !!(back && back.gateway);
    this.costSoFar = back && typeof back.costSoFar === 'number' ? back.costSoFar : null;
    this.context = null; this.respondedAt = 0; this.collab.clear(); this.queue = []; this.shown = []; this.via = {}; this.lastVia = ''; this.viaQueue = [];
    this.reconcile();
    // where the conversation goes: from one company's service, or account, to another's. Said on the divider; marked when it
    // leaves an account of the user's own (Bedrock, a gateway) for a vendor's service
    const to = this.where();
    this.handoff = handoff ? { text: handoff.text, messages: handoff.inlineMessages, total: handoff.messages, tokens: handoff.tokens, fits: handoff.fits, route: `sent from ${VENDOR[from.kind]} on ${from.name} to ${VENDOR[kind]} on ${to.name}`, leaves: from.account && from.account !== to.account } : null;
    const cat = this.catalog(), label = this.model ? modelLabel(cat, this.model) || this.model : (cat && cat.defaultModel && cat.defaultModel.label) || '';
    const divider = this.switchNote({ kind, model: label, handoff: this.handoff, resumed: !!this.agentSessionId, live: true });
    // a stretch in which nothing was said leaves nothing to read back: it is dropped, whether or not it resumed a record
    // (seen 2026-10-27: a tab switched back and forth without a word kept every empty stretch, and a reload then put the
    // records' stretches under the wrong dividers)
    if (this.periods.length && !this.periods[this.periods.length - 1].said) this.periods.pop();
    const prev = this.periods[this.periods.length - 1];
    if (!(prev && prev.kind === kind && prev.resume === this.agentSessionId)) this.periods.push(Object.assign({ kind, resume: this.agentSessionId, said: false, note: divider.text }, divider.level ? { warn: true } : {}));   // else back where it was: that stretch goes on
    this.view.trace(`switched tab ${this.id.slice(0, 8)} "${this.title}": ${from.kind} → ${kind}, model ${JSON.stringify(this.model)}${this.agentSessionId ? ', resuming ' + String(this.agentSessionId).slice(0, 8) : ', a new conversation'}`);
    this.post(divider);
    this.post({ kind: 'note', text: `Mode: ${MODE_NAMES[this.mode] || this.mode}, ${VENDOR[kind]}'s own${back ? ', as this tab had it' : ''}. ` + (this.agentSessionId ? `Its earlier conversation is read from the prompt cache if that is still warm.` : `The prompt cache starts cold.`) + (this.handoff ? ' The conversation above goes with your next message.' : '') });
    this.view.persist();
    this.view.vendorChanged(this);
    return true;
  }

  /**
   * A model chosen after a switch and before anything was said on it: the divider names the model the tab goes on with,
   * not the one first picked.
   */
  renameDivider() {
    const p = this.periods[this.periods.length - 1];
    if (this.periods.length < 2 || !p.note || this.agentSessionId || this.agent) return;
    const h = [...this.history].reverse().find((e) => e.kind === 'note' && e.vendor === this.kind);
    if (!h || h.text !== p.note) return;
    const cat = this.catalog(), label = this.model ? modelLabel(cat, this.model) || this.model : (cat && cat.defaultModel && cat.defaultModel.label) || '';
    const text = this.switchNote({ kind: this.kind, model: label, handoff: this.handoff, resumed: false }).text;
    if (text === p.note) return;
    h.text = p.note = text;
    this.view.replay(this);
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
  /** On the gateway the choices are the file's names (src/gateway.js), not Claude Code's catalog. */
  catalog() { return this.gateway ? Gateway.gatewayModels(this.view.gateway().vars) : this.view.catalog[this.kind] || null; }
  /**
   * The catalog's entry for a model the tab names: by its value, else by the model the id names, so a model given by its
   * id (`claude-fable-5-1[1m]`: Fable 5.1 with the 1M context window, chosen in Claude Code or saved by an older Perch) is
   * still that model, with its name and its efforts.
   */
  entryOf(v) { const cat = this.catalog(); return cat && v ? cat.models.find((m) => m.value === v) || modelEntry(cat, v) : null; }
  /** A model's name in the menu and on the pill; the 1M context window said, when the id asks for it and the entry does not. */
  nameOf(v) { const m = this.entryOf(v); if (!m) return v; return m.label + (/\[1m\]$/i.test(v) && !/\[1m\]$/i.test(m.value) && !/1m/i.test(m.label) ? ' (1M)' : ''); }
  selectedModel() {
    const cat = this.catalog(); if (!cat) return null;
    if (this.model) return this.entryOf(this.model);
    return modelEntry(cat, this.runningDefault()) || cat.defaultModel;   // on default, a running session's choices are its model's
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
  /**
   * Claude on default, off the gateway, while its process runs: the model the process says it is running. The catalog
   * names the default by what a new session starts on, and a session can leave that: chosen in a running session,
   * default is Claude Code's built-in one.
   */
  runningDefault() { return this.kind === 'claude' && !this.gateway && !this.model && this.agent ? this.running() : ''; }
  /**
   * The model the session runs, as Claude Code last said: the one it moved the session to after a refusal, which holds
   * until another is chosen (a report naming the model asked for does not undo it), else the one the process reports.
   */
  running() { return this.swap ? this.swap.to : this.actualModel; }
  /**
   * The model this session is meant to run, as an id: the one Claude Code moved it off, else the one chosen, by the id
   * the catalog resolves it to. '' on default, whose label follows what the session runs, and for a name the catalog lacks.
   */
  wanted() {
    if (this.swap) return this.swap.from;
    if (!this.model) return '';
    const m = this.entryOf(this.model);
    return m ? m.resolved || m.value : '';
  }
  /**
   * Claude off the gateway, while its process runs: the model the session runs when it is not the one meant, for the
   * pill to name, as { model, label, title }; else null. Claude Code moves a session itself when the model's safeguards
   * refuse a response: it retries the response on a fallback model and keeps the session there.
   */
  offModel() {
    if (this.kind !== 'claude' || this.gateway || !this.agent) return null;
    const run = this.running(), want = this.wanted();
    if (!run || !want || sameModel(run, want)) return null;
    const cat = this.catalog(), name = (id) => modelLabel(cat, id) || id;
    const title = this.swap
      ? `Running ${name(run)} (${run}), not ${name(want)}: Claude Code moved this session to it when ${name(want)}'s safeguards stopped a response${this.swap.category ? ' (' + this.swap.category + ')' : ''}.`
      : `Running ${name(run)} (${run}), as Claude Code reports, not ${name(want)} (${want}).`;
    return { model: run, label: name(run), title };
  }
  /** The agent says which model it runs. On default the effort choices follow it, so one that model lacks goes back to default. */
  ran(id) {
    if (!id || id === this.actualModel) return;
    this.actualModel = id;
    if (this.runningDefault() && this.reconcile()) { this.view.persist(); this.agent.setEffort(''); }
  }
  modelOptions() {
    const cat = this.catalog(); const d = cat && cat.defaultModel;
    const live = this.runningDefault();
    const name = live ? modelLabel(cat, live) : d && d.label;
    const title = live && live !== (d && d.model) ? 'Claude Code says this session is running ' + live + (d && d.label ? '; new sessions start on ' + d.label : '') + '.'
      : d && d.description ? d.description : 'The model the agent picks by default';
    const opts = [{ value: '', label: 'default' + (name ? ' · ' + name : ''), title }];
    for (const v of this.allowedModels().slice(1)) { const m = this.entryOf(v); opts.push({ value: v, label: this.nameOf(v), title: m ? m.description : 'not in the agent\'s model list' }); }
    return opts;
  }
  effortOptions() {
    const m = this.selectedModel(); const d = m && m.defaultEffort;
    return this.allowedEfforts().map((v) => (v ? { value: v, label: v } : { value: '', label: 'default' + (d ? ' · ' + d : '') }));
  }

  post(ev) {
    // Codex's own word that its ChatGPT login was refused (revoked, invalidated, ended): acted on once the error is shown
    const refusedLogin = ev.kind === 'error' && this.kind === 'codex' && !(this.view.meter && this.view.meter.codexBackend() !== 'chatgpt') && codexAuth.refused(ev.text);
    // Codex's Linux sandbox is bubblewrap, which needs user namespaces; a container that forbids them fails every command this way
    if (ev.kind === 'tool_result' && this.kind === 'codex' && this.mode !== 'danger-full-access' && !this.sandboxAsked && /bwrap: No permissions to create a new namespace/.test(String(ev.text))) { this.sandboxAsked = true; this.view.codexNoSandbox(this); }
    switch (ev.kind) {
      case 'status':
        this.lastStatus = ev.text;
        // the page shows whether a session works at the foot of its transcript; anything else an agent reports is part of the transcript
        if (!/^(idle|working|ready)\b/.test(String(ev.text))) this.post({ kind: 'note', text: String(ev.text) });
        break;
      case 'busy':
        if (!ev.busy && this.queue.length && this.agent && !this.stopping) { const next = this.queue.shift(); this.started(next.qid); this.view.sendTabs(); setImmediate(() => { if (this.agent) this.agent.send(next.text, next.shown, next.images); }); return; }   // stay busy: the next queued message starts now
        this.stopping = false;
        if (!ev.busy && this.kind === 'codex' && this.busy) { const t = setTimeout(() => this.view.meter.refreshCodex(), 400); if (t.unref) t.unref(); }   // Codex has just recorded its limits
        if (ev.busy && !this.busy) { this.busySince = Date.now(); this.refusedTurn = false; } else if (!ev.busy) this.busySince = 0;
        this.busy = !!ev.busy; if (!this.busy) this.collab.clear();   // a turn's sub-agents end with its process
        this.view.sendTabs(); this.view.sendEvent(this.id, ev); this.post({ kind: 'status', text: this.busy ? 'working' : 'ready' });
        if (!this.busy) this.view.saveName(this);          // a tab named before its first turn: the agent has a record to write the name to now
        if (!this.busy) this.view.syncTitle(this);         // and a tab the user has not named takes the title its agent's record has by now
        if (!this.busy && this.restartWhenIdle) {   // true: a backend switch; else the note to give, once restarted
          const note = typeof this.restartWhenIdle === 'string' ? this.restartWhenIdle : 'Moved to the new Claude backend; the conversation continues from the next message.';
          this.restart(); this.post({ kind: 'note', text: note });
        }
        return;
      case 'model': this.ran(ev.id); this.view.sendTabs(); return;
      case 'fallback': {             // Claude: the model's safeguards refused a response, and Claude Code retried it on another model
        if (ev.scope !== 'local' && ev.to) {   // for the session, from now on; a sub-agent's one response leaves it where it was
          this.swap = { from: ev.from || '', to: ev.to, category: ev.category || '' };
          if (this.runningDefault() && this.reconcile()) { this.view.persist(); this.agent.setEffort(''); }   // on default the efforts follow the model, as when it reports one (ran)
          this.view.sendTabs();
        }
        this.post({ kind: 'note', level: 'warn', text: fallbackNote({ content: ev.text, from: ev.from, to: ev.to, scope: ev.scope }) });
        return;
      }
      case 'relay':                  // one response through the gateway: which model it came from, and what the gateway charged, for this turn
        if (typeof ev.cost === 'number' && Number.isFinite(ev.cost)) this.viaCost = (this.viaCost || 0) + ev.cost;
        if (typeof ev.keySpend === 'number') this.keySpend = ev.keySpend;
        if (!ev.model) return;
        if (ev.status === 200 && /^\/v1\/messages/.test(ev.path || '')) this.viaQueue.push(ev.model);   // its token counts follow from the agent, in the same order
        this.via[ev.model] = (this.via[ev.model] || 0) + 1;
        if (this.lastVia !== ev.model) { this.lastVia = ev.model; this.view.sendTabs(); }
        return;
      case 'usage': {                // one response's token counts: on the gateway, priced at the answering model's list rates, for when the gateway gives no figure
        if (!this.gateway) return;
        const model = this.viaQueue.shift() || this.lastVia;
        const rate = model && this.view.prices ? this.view.prices.rateFor(model) : null;
        if (rate) this.viaEstimate = (this.viaEstimate || 0) + Prices.costOf(rate, ev.usage);
        return;
      }
      case 'context': this.context = { percent: Math.max(0, Math.min(100, Math.round(ev.percent))), used: ev.used, max: ev.max }; this.ran(ev.model); this.view.sendTabs(); return;
      case 'responded': this.respondedAt = ev.at; this.view.sendTabs(); return;
      case 'result': {
        if (typeof ev.cost === 'number') { this.costSoFar = ev.cost; this.view.persist(); }
        if (this.handoffSent) { this.handoff = null; this.handoffSent = false; this.view.persist(); }
        const via = Object.entries(this.via).map(([model, n]) => ({ model, short: shortModel(model), n }));
        if (via.length) ev.via = via;   // what answered this turn, for the line under the answer; kept with the transcript
        this.via = {};
        // off the gateway, whose relay says what answered (via): the models whose responses answered the turn, as each response
        // named its model, when one is not the model meant (Claude Code moved the session after a refusal, say)
        if (this.kind === 'claude' && !this.gateway && Array.isArray(ev.models) && ev.models.length) {
          const want = this.wanted(), cat = this.catalog();
          if (want && ev.models.some((id) => !sameModel(id, want))) { ev.answered = ev.models.map((id) => ({ model: id, label: modelLabel(cat, id) || id })); ev.wanted = want; }
        }
        delete ev.models;
        // the gateway's own figure for the turn, in place of Claude Code's estimate, which prices a gateway's names by guess
        if (this.viaCost !== null) { this.gatewayCost += this.viaCost; ev.gatewayCost = this.viaCost; ev.gatewayCostSoFar = this.gatewayCost; this.viaCost = null; this.view.persist(); }
        // and, for a streamed response the gateway puts no price on, the turn at the answering models' list rates
        if (this.viaEstimate !== null) { this.gatewayEstimate += this.viaEstimate; ev.gatewayEstimate = this.viaEstimate; ev.gatewayEstimateSoFar = this.gatewayEstimate; this.viaEstimate = null; this.view.persist(); }
        if (this.keySpend !== null) ev.keySpend = this.keySpend;
        this.viaQueue = [];
        // Codex: the turn's sub-agents as they ended, each with its model and cost, under the line that ends the turn
        if (this.kind === 'codex' && this.collab.size) ev.subagents = this.collabSummary();
        break;
      }
      case 'subagent': {             // Codex: a sub-agent's life, read from the thread's file (src/codexWatch.js)
        if (ev.state === 'usage') {  // and, from its own file, which model answers it and what its turns cost
          if (ev.name) {
            const a = this.collab.get(ev.name) || { state: 'working', at: Date.now(), reports: 0 };
            Object.assign(a, { model: ev.model || '', effort: ev.effort || '', turns: ev.turns || 0, tokens: ev.tokens || { input: 0, cached: 0, output: 0 } });
            if (ev.nickname) a.nickname = ev.nickname;
            if (ev.models) a.models = ev.models;
            this.collab.set(ev.name, a);
            this.view.sendTabs();
          }
          return;
        }
        if (ev.name) {
          const was = this.collab.get(ev.name), now = Date.now();
          // a progress report can be delivered after its sender finished: it does not make a finished sub-agent work again
          const state = { started: 'working', tasked: 'working', finished: 'finished', answered: 'finished', interrupted: 'interrupted' }[ev.state] || (was ? was.state : 'working');
          this.collab.set(ev.name, Object.assign(was || {}, { state, at: now, reports: ((was && was.reports) || 0) + (ev.state === 'reported' || ev.state === 'answered' ? 1 : 0) }));
          this.view.sendTabs();
        }
        // in the transcript: its start, its follow-up tasks, its reports, its end. The root's own messages to it are not
        // shown (they are encrypted, and many), nor its final answer, which follows its end
        if (['started', 'tasked', 'reported', 'finished', 'interrupted'].includes(ev.state) && ev.name) {
          // its end keeps what its file has said of it by then, as a past turn's end lines do (sessionStore.addSubagentUsage)
          if (ev.state === 'finished' || ev.state === 'interrupted') { const a = this.collab.get(ev.name); if (a && a.model) ev.info = collabInfo(a); }
          this.history.push(ev); break;
        }
        if (ev.state === 'waiting') this.view.sendEvent(this.id, ev);   // what the foot of the transcript says, not a line of it
        return;
      }
      case 'dequeued': this.started(ev.qid); return;   // Claude: a turn has taken up a queued message
      case 'commands': this.view.setCommands(this.kind, ev.list); return;
      case 'session': { const fresh = this.agentSessionId !== ev.id; this.agentSessionId = ev.id; this.periods[this.periods.length - 1].resume = ev.id; if (fresh && this.named && this.periods.length > 1) this.unsaved = true; /* a new record after a switch takes the tab's name too */ this.view.persist(); if (fresh && this.kind === 'codex') this.view.sendTabs(); break; }   // a thread to read the usage of: the footer offers its table
      case 'clear': this.history = []; this.resumed = null; break;
      case 'delta': case 'tool_start': case 'stderr': case 'mode': case 'fill': break;
      case 'user': {
        const period = this.periods[this.periods.length - 1];
        if (period && !period.said) { period.said = true; this.view.persist(); }   // this stretch of the tab has words now: it is kept, and read back
      }
        if (this.kind === 'codex' && !ev.queued) this.turnText = ev.text;   // the running turn's message: put back in the box if Codex's login is refused
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
    if (refusedLogin) this.loginRefused();
  }

  ensureAgent() {
    if (this.agent) return this.agent;
    const emit = (ev) => this.post(ev);
    const resume = this.agentSessionId || undefined;
    const prog = program(this.kind);
    if (prog.from === 'none') this.post({ kind: 'error', text: MISSING[this.kind] });
    if (this.kind === 'claude') {
      // fixed for the life of the agent process: a process cannot change how it authenticated
      this.backend = this.gateway ? 'gateway' : this.view.meter ? this.view.meter.backend() : '';
      const gw = this.gateway ? this.view.gateway() : null;
      if (gw) this.view.prices.load();   // the list prices a streamed response is priced at, for the turn's figure
      const pinned = !gw && !!this.view.pinnedGatewayUrl();   // the machine pins a gateway for all Claude Code; a non-gateway tab must escape it
      const launchCat = this.catalog();
      // a model saved under another backend's name (Bedrock's `us.anthropic.…` on the subscription, say) is given the name
      // this backend has for it, its 1M context kept; the tab keeps the name it runs
      const named = this.launchModel(launchCat);
      if (named !== this.model) { this.model = named; this.view.persist(); }
      const search = this.view.codeSearch();
      this.search = search ? JSON.stringify(search.args) : '';   // what this process searches: a change restarts it
      this.agent = new ClaudeAgent({
        search: search || undefined,
        cwd: cwd(), emit, resume,
        permissionMode: this.mode,
        // off a pinned gateway the subscription does not know the gateway's model names: keep the model only if the catalog has it
        model: (this.model && (!pinned || !launchCat || modelEntry(launchCat, this.model))) ? this.model : undefined,
        effort: this.effort || undefined,
        executable: prog.path || undefined,
        costBefore: this.costSoFar === null ? undefined : this.costSoFar,
        env: gw ? Gateway.gatewayEnv(gw.vars) : undefined,
        gateway: gw ? { target: gw.vars.ANTHROPIC_BASE_URL } : undefined,   // through the relay, which sees which model answers
        offGateway: pinned && this.backend ? { bedrock: this.backend !== 'subscription' } : undefined,   // take a sub/API tab off the pinned gateway
        askPermission: (req) => new Promise((resolve) => this.pending.set(req.id, resolve)),
      });
    } else {
      const search = this.view.codeSearch();
      this.search = search ? JSON.stringify(search.args) : '';
      this.agent = new CodexAgent({
        search: search || undefined,
        cwd: cwd(), emit, resume,
        additionalDirectories: additionalCwds(),
        sandboxMode: this.mode,
        approvalPolicy: cfg('codex.approvalPolicy'),
        model: this.model || undefined,
        reasoningEffort: this.effort || undefined,
        executable: prog.path || undefined,
        apiKey: this.view.meter && this.view.meter.codexBackend() === 'api' ? this.view.meter.codexApiKey() : undefined,
        bedrock: this.view.meter && this.view.meter.codexBackend() === 'bedrock' ? this.view.codexBedrock() : undefined,
      });
      this.backend = this.view.meter ? this.view.meter.codexBackend() : '';
    }
    if (this.search) this.view.offerSearch();   // once a machine: search by meaning is an install, keywords are not
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
    // Claude on the gateway with no gateway to reach: the file is missing or incomplete. Hold the message, say what to do.
    // (The window being on API / Bedrock is no obstacle: the tab's process is given the gateway's variables as its own settings.)
    if (this.kind === 'claude' && !this.agent && this.gateway && this.view.meter) {
      const gw = this.view.gateway();
      if (!gw.ok) {
        // the ways on are buttons under the note, which stay; the notification beside them says more and is gone in seconds
        this.post({ kind: 'note', text: `This tab is on the gateway, but ${Gateway.describe(gw)} Fill it in, or take this tab off the gateway, then send the message again.`, actions: [{ id: 'gatewayFile', label: 'Open the File' }, { id: 'gatewayLeave', label: 'Leave the Gateway' }] });
        this.view.deliver(this.id, text);
        this.view.gatewayHelp(this, gw);
        return;
      }
    }
    // Claude with nothing to authenticate with here, on the backend it would get: hold the message, offer the way in
    if (this.kind === 'claude' && !this.agent && !this.gateway && this.view.meter && !this.view.meter.canRun()) {
      const api = this.view.meter.backend() === 'api';
      this.post({ kind: 'note', text: api ? `Claude is set to API / Bedrock on ${require('os').hostname()}, and no credentials for it were found there. Set them up, or use your subscription, then send the message again.` : `Claude is not logged in on ${require('os').hostname()}. Log in, then send the message again.`,
        actions: api ? [{ id: 'claudeSettings', label: 'Open settings.json' }, { id: 'claudeSubscription', label: 'Use Subscription' }] : [{ id: 'claudeLogin', label: 'Log In' }, { id: 'claudeApi', label: 'Use API / Bedrock' }] });
      this.view.deliver(this.id, text);
      this.view.claudeLogin();
      return;
    }
    // Codex on Bedrock with nothing to sign with: hold the message, say what Bedrock needs, offer the way back
    if (this.kind === 'codex' && !this.agent && this.view.meter && this.view.meter.codexBackend() === 'bedrock' && !this.view.meter.meter.apiCredentialsPresent()) {
      const b = this.view.meter.codexBedrock();
      this.post({ kind: 'note', text: `Codex is set to Amazon Bedrock on ${require('os').hostname()} (${b.region}${b.profile ? ', profile ' + b.profile : ''}), and no AWS credentials were found there: no ~/.aws credentials or profile, no AWS_* variables. Set them up, or use the ChatGPT login, then send the message again.`, actions: [{ id: 'codexChatgpt', label: 'Use ChatGPT' }] });
      this.view.deliver(this.id, text);
      return;
    }
    // Codex with no login here, or with one Codex has refused, would only be refused again (401, reconnects, an error): hold
    // the message, offer the login. A refused login is held until auth.json holds another (PerchView.codexLoginRefused).
    if (this.kind === 'codex' && !(this.view.meter && this.view.meter.codexBackend() !== 'chatgpt') && (!codexAuth.loggedIn() || this.view.codexLoginRefused()) && (!this.agent || !this.busy)) {
      const none = !codexAuth.loggedIn(), host = require('os').hostname();
      this.post({ kind: 'note', nid: 'codexLogin', text: none ? `Codex is not logged in on ${host}. Log in, then send the message again.` : `Codex's login on ${host} was refused, and no new one has been made: log in again, then send the message again.`, actions: [{ id: 'codexLogin', label: 'Log In' }, { id: 'codexDevice', label: 'Device Code' }] });
      this.view.deliver(this.id, text);
      this.view.codexLogin(none ? undefined : `Codex's login on ${host} was refused.`);
      return;
    }
    const agent = this.ensureAgent();
    const thumbs = images.map((i) => i.thumb), sent = images.map((i) => ({ mime: i.mime, data: i.data }));
    // IDE context is read now, when the message is written, not later when a queued message starts
    const ctx = this.ide ? ideContext() : null;
    // the first message after a switch carries the conversation before it (note 202); the transcript shows the words only
    // it is let go once a turn has ended (result): a turn that never got going sends it again with the next message
    const carried = this.handoff && !this.handoffSent ? this.handoff.text + '\n\n' : '';
    if (carried) this.handoffSent = true;
    const full = carried + (ctx ? text + ctx.block : text), shown = { text, tag: ctx ? ctx.tag : undefined };
    if (this.kind !== 'codex') { if (sent.length) this.thumbs.push(thumbs); agent.send(full, sent, shown); return; }
    if (this.busy) {
      const qid = require('crypto').randomUUID();
      this.queue.push({ qid, text: full, shown, images: sent }); (this.shown = this.shown || []).push(text);
      this.post(Object.assign({ kind: 'user', text, queued: true, qid }, sent.length ? { images: sent.length } : {}, thumbs.some(Boolean) ? { thumbs } : {}, shown.tag ? { tag: shown.tag } : {}));
      this.view.sendTabs();          // the queue count is part of the tab
      return;
    }
    if (sent.length) this.thumbs.push(thumbs);
    agent.send(full, shown, sent);
  }

  setIde(on) { this.ide = !!on; this.view.persist(); }

  /**
   * Codex refused its ChatGPT login (codexAuth.refused). Remember which login, so messages are held until there is another;
   * put this turn's message, and any queued behind it, back in the box; say why, with the ways to log in again. Once a turn:
   * Codex says it each time it retries.
   */
  loginRefused() {
    const first = !this.view.codexLoginRefused();
    this.view.codexRefused();
    if (this.refusedTurn) return;
    this.refusedTurn = true;
    const back = [this.turnText].concat(this.queue.map((q) => q.shown && q.shown.text)).filter((t) => t && String(t).trim());
    for (const q of this.queue) this.gone(q.qid, true);
    this.queue = []; this.shown = [];
    const host = require('os').hostname();
    this.post({ kind: 'note', nid: 'codexLogin', text: `Codex's login on ${host} was refused: ChatGPT ended its session, by a logout, a password change, a revoked session, or the same login refreshed on another machine (a copy of another machine's auth.json ends when either copy refreshes). Log in again here, with this machine's own login.` + (back.length ? ` ${back.length > 1 ? 'The messages are' : 'The message is'} back in the box.` : ''), actions: [{ id: 'codexLogin', label: 'Log In' }, { id: 'codexDevice', label: 'Device Code' }] });
    if (back.length) this.view.deliver(this.id, back.join('\n\n'));
    this.view.sendTabs();
    if (first) this.view.codexLogin(`Codex's login on ${host} was refused: ChatGPT ended its session.`);
  }

  /** A queued message has started: its bubble is an ordinary one from now, in the page and in what is replayed. */
  started(qid, tell = true) {
    if (!qid) return;
    const h = this.history.find((x) => x.kind === 'user' && x.qid === qid);
    if (h) { h.queued = false; delete h.qid; }
    if (tell) this.view.sendEvent(this.id, { kind: 'dequeued', qid });
  }
  /** A queued message is gone, taken back or dropped with a stopped turn: from the page, and from what is replayed. */
  gone(qid, quiet) {
    if (!qid) return;
    const i = this.history.findIndex((x) => x.kind === 'user' && x.qid === qid);
    if (i >= 0) this.history.splice(i, 1);
    this.view.sendEvent(this.id, Object.assign({ kind: 'unqueued', qid, ok: true }, quiet ? { quiet: true } : {}));
  }
  /**
   * Take a queued message back, at the user's word (the x on its bubble): a Codex one from perch's own queue, a Claude one
   * from Claude Code's (src/claudeAgent.js, unqueue). One a turn has taken up already cannot be.
   */
  async unqueue(qid) {
    if (!qid) return;
    let r = { ok: false, why: 'taken' };
    if (this.kind === 'codex') {
      const i = this.queue.findIndex((q) => q.qid === qid);
      if (i >= 0) {
        // its echo, which would have been dropped when it started: the echoes wait in the queue's order, behind at most one
        // of a message that has just started and not yet echoed, so its place there is known, whatever the words
        const shown = this.shown || [], at = shown.length - this.queue.length + i;
        const [q] = this.queue.splice(i, 1);
        if (at >= 0 && shown[at] === q.shown.text) shown.splice(at, 1); else { const k = shown.indexOf(q.shown.text); if (k >= 0) shown.splice(k, 1); }
        r = { ok: true };
      }
    } else if (this.agent && typeof this.agent.unqueue === 'function') {
      try { r = await this.agent.unqueue(qid); } catch (_) { r = { ok: false, why: 'unsupported' }; }
    }
    if (r.ok) this.gone(qid);
    else {
      if (r.why === 'taken') this.started(qid, false);
      this.view.sendEvent(this.id, { kind: 'unqueued', qid, ok: false, why: r.why || 'taken' });
    }
    this.view.sendTabs();          // the queue count is part of the tab
  }

  /**
   * The running turn's sub-agents, for the foot of the transcript: how many work, have finished, were stopped, and each by
   * name with its reports and, once its own file has said so, its model, effort, turns and tokens (collabInfo).
   */
  collabSummary() {
    const list = [...this.collab.entries()].map(([name, a]) => Object.assign({ name, state: a.state, reports: a.reports }, a.model ? collabInfo(a) : {}));
    const count = (st) => list.filter((x) => x.state === st).length;
    return { working: count('working'), finished: count('finished'), interrupted: count('interrupted'), list };
  }

  /**
   * Put this tab on the gateway, or take it off, for its next process. A running process cannot change how it authenticates,
   * so it ends (after the current turn, if one is running) and the next message resumes the session, as a backend switch does.
   */
  setGateway(on) {
    on = this.kind === 'claude' && !!on;
    if (on === this.gateway) return;
    this.gateway = on;
    // a model of Claude Code's catalog means nothing to the gateway: back to the file's default, which the pill then shows
    if (on && this.model && !['opus', 'sonnet', 'haiku'].includes(this.model)) { this.model = ''; this.effort = ''; }
    this.view.persist();
    this.view.sendTabs();                // the choice shows at once, whether or not the process has moved yet
    const to = on ? 'the LLM gateway' : this.view.meter ? this.view.meter.state().backendName : 'the window\'s backend';
    if (!this.agent) return;
    if (this.busy) { this.restartWhenIdle = true; this.post({ kind: 'note', text: `This tab moves to ${to} after the current turn; the conversation continues, the prompt cache starts over.` }); }
    else { this.restart(); this.post({ kind: 'note', text: `This tab is on ${to} from the next message; the conversation continues, the prompt cache starts over.` }); }
  }

  /** @param {Record<string,string>} [answers]  for a question: each question's answer, by the question's text */
  answerPermission(id, decision, answers) {
    const clean = answers && typeof answers === 'object' && !Array.isArray(answers) ? Object.fromEntries(Object.entries(answers).filter(([q, a]) => typeof q === 'string' && q && typeof a === 'string' && a.trim()).map(([q, a]) => [q, a.trim()])) : null;
    const r = this.pending.get(id);
    if (r) { this.pending.delete(id); r(decision === 'answer' ? { decision: clean && Object.keys(clean).length ? 'answer' : 'deny', answers: clean } : { decision }); }
    const i = this.history.findIndex((h) => (h.kind === 'permission' || h.kind === 'question') && h.id === id);
    if (i >= 0) {
      const h = this.history[i];
      if (h.kind === 'question') {
        this.history[i] = { kind: 'answered', questions: h.questions, answers: clean || {} };
        // a question Codex asked without waiting: nothing is waiting for the answer, so it goes as the next message, queued
        // behind the turn if one is running
        if (h.async && decision === 'answer' && clean && Object.keys(clean).length) this.send(codexAnswer(h.questions, clean));
      }
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
    if (this.agent) this.actualModel = '';   // until the agent says what it runs now, which Claude is asked at once
    this.swap = null;                        // a model chosen: the one Claude Code moved the session to is no longer the word
    // the new model may not accept the current effort. Default in a running Claude session is whatever Claude says it now
    // runs, so the effort is checked when it says (ran)
    const effortReset = !(value === '' && this.agent && this.kind === 'claude' && !this.gateway) && this.reconcile();
    this.renameDivider();
    this.view.persist();
    if (!this.agent) return;
    this.agent.setModel(value); if (effortReset) this.agent.setEffort('');
  }

  /** Stops the current turn and drops anything queued behind it. */
  interrupt() { if (!this.agent) return; if (this.queue.length) { this.post({ kind: 'note', text: `${this.queue.length} queued message${this.queue.length > 1 ? 's' : ''} dropped` }); for (const q of this.queue) this.gone(q.qid, true); this.queue = []; this.shown = []; this.view.sendTabs(); } this.stopping = true; this.agent.interrupt(); }
  lastAnswer() { return this.agent ? this.agent.lastAnswer : ''; }

  /** End the agent process and keep the session: the next message resumes it, as after a window reload. */
  restart() {
    this.restartWhenIdle = false;
    if (!this.agent) return;
    this.agent.dispose(); this.agent = null; this.handoffSent = false; this.backend = ''; this.actualModel = ''; this.swap = null; this.search = ''; this.via = {}; this.viaCost = null;
    if (this.reconcile()) this.view.persist();   // on default, the next process starts on the model new sessions start on, which may lack the effort
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
      thread: !!this.agentSessionId,   // a session on record: its usage, thread by thread, can be read from the agent's files
      index: this.view.searchRoots().length > 0,   // codebase search is on for a folder of the workspace: the footer offers the index's state
      mode: this.mode, modes: MODES[this.kind],
      model: this.model, models: this.modelOptions(), actualModel: this.running(),
      off: this.offModel(),            // the session runs another model than the one meant: the pill names it
      effort: this.effort, efforts: this.effortOptions(),
      approvals: this.kind === 'codex' ? String(cfg('codex.approvalPolicy') || '') : '',
      switchTo: this.switchTo(),       // the other vendor's models, for the footer's menu (note 202)
      path: this.path(),               // the vendors this tab has been on, in order, when more than one
      backend: this.agent ? this.backend : '',
      gateway: this.gateway,
      gatewayWarn: this.gateway && !this.view.gateway().ok,   // the file is missing or incomplete: the first message will say so
      via: this.gateway ? this.lastVia : '',                   // the model that last answered through the gateway
      queued: this.queue.length,
      subagents: this.kind === 'codex' && this.busy && this.collab.size ? this.collabSummary() : null,
      ide: this.ide,
      context: this.kind === 'claude' ? this.context : null,
      // the prompt cache: how long it stays warm, and since when. Claude only; Codex does not expose its cache lifetime.
      cache: this.kind === 'claude' ? { minutes: this.view.meter.cacheMinutes(this.agent ? this.backend : this.gateway ? 'gateway' : '', this.gateway ? this.view.gateway().vars : undefined), since: this.respondedAt } : null,
    };
  }
  /** The vendors this tab has been on, in order, each run of one vendor once: ['claude', 'codex', 'claude']. Null for one. */
  path() { const out = []; for (const p of this.periods) if (out[out.length - 1] !== p.kind) out.push(p.kind); return out.length > 1 ? out : null; }
  /** The tab's model as the catalog of its backend names it: itself when listed, else the entry for the same model, if any. */
  launchModel(cat) {
    const m = this.model;
    if (!m || this.gateway || !cat || !Array.isArray(cat.models) || cat.models.some((x) => x.value === m)) return m;
    const e = modelEntry(cat, m);
    if (!e) return m;
    const wide = /\[1m\]$/i.test(m) && !/\[1m\]$/i.test(e.value);
    return e.value + (wide ? '[1m]' : '');
  }
  /** The other vendor and its models, as the footer's menu offers them: default first, named as the catalog names it. */
  switchTo() {
    const kind = this.kind === 'claude' ? 'codex' : 'claude', cat = this.view.catalog[kind];
    const d = cat && cat.defaultModel && cat.defaultModel.label;
    return { kind, models: [{ value: '', label: 'default' + (d ? ' · ' + d : '') }, ...((cat && cat.models) || []).map((m) => ({ value: m.value, label: m.label }))] };
  }
  toState() { return { id: this.id, kind: this.kind, title: this.title, titled: this.titled, unsaved: this.unsaved, named: this.named, mode: this.mode, effort: this.effort, model: this.model, ide: this.ide, resume: this.agentSessionId, location: this.location, paneled: this.paneled, costSoFar: this.costSoFar, kept: this.kept, gateway: this.gateway, gatewayCost: this.gatewayCost, gatewayEstimate: this.gatewayEstimate, periods: this.periods, left: this.left, handoff: this.handoff }; }

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
    this.out = typeof vscode.window.createOutputChannel === 'function' ? vscode.window.createOutputChannel('Perch') : null;   // View › Output › Perch
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
    this.leftGroups = new Set();     // editor groups a Perch tab has just left, looked at by unlockGroups
    this.unlockTimer = null;
    this.meter = new MeterHost(context, (state, why, codex) => this.onMeter(state, why, codex), { program: () => program('claude') });
    // list prices for a gateway's models, in the extension's own storage: read when a tab goes through the gateway
    this.prices = Prices.createPrices({ file: require('path').join((context.globalStorageUri && context.globalStorageUri.fsPath) || require('path').join(require('os').tmpdir(), 'perch'), 'litellm-prices.json') });
    this.root = (context.extensionUri && (context.extensionUri.fsPath || context.extensionUri.path)) || context.extensionPath || require('path').join(__dirname, '..');
    this.voice = new VoiceHost({
      root: this.root,
      send: (sid, ev) => this.sendEvent(sid, ev),
      deliver: (sid, text) => this.deliver(sid, text),
    });
    // codebase search, the MCP server Perch gives its tabs (codeindex/, src/codeIndex.js). Off by default, and then nothing
    // of it runs: whether this machine's Python can run it is asked once the setting is on, and a tab started before the
    // answer simply goes without
    this.searchUsable = false; this.searchProbed = null;
    this.codeIndex = new CodeIndex({ root: this.root, python: cfg('codebaseIndex.python') || undefined });
    if (this.searchRoots().length) this.probeSearch();
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
    if (why === 'codexBackend') {
      // Codex takes its key and its --config overrides per process, so every tab moves on its next turn; nothing is restarted
      const backend = this.meter.codexBackend(), key = backend === 'api' ? this.meter.codexApiKey() : null, bedrock = backend === 'bedrock' ? this.codexBedrock() : undefined;
      for (const s of this.sessions) if (s.kind === 'codex' && s.agent && s.backend !== backend) {
        s.agent.setBackend({ apiKey: key, bedrock }); s.backend = backend;
        s.post({ kind: 'note', text: backend === 'api' ? 'Codex backend is now your OpenAI API key, from the next message; billed per token, no plan limits.'
          : backend === 'bedrock' ? `Codex backend is now Amazon Bedrock (${bedrock.endpoint === 'runtime' ? 'the runtime endpoint' : 'Mantle'}, ${bedrock.region}), from the next message; billed to the AWS account, no plan limits.`
          : 'Codex backend is now your ChatGPT login, from the next message.' });
      }
      this.sendTabs();
      return;
    }
    if (why !== 'backend') return;
    // models differ by backend, and a running process cannot change how it authenticated: so the process ends and the
    // session goes on, resumed by the next message on the new backend, as after a window reload. A tab on the gateway
    // has its own backend and is left alone.
    this.loadCatalogs(true);
    for (const s of this.sessions) if (s.kind === 'claude' && !s.gateway && s.agent && s.backend && s.backend !== state.backend) {
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

  // ---- codebase search (codeindex/, src/codeIndex.js, docs/notes/201-codebase-indexing.md)
  /** Whether this machine's Python can run the search server: asked once, and only once search is wanted. */
  probeSearch() {
    if (!this.searchProbed) this.searchProbed = this.codeIndex.probe().then((ok) => { this.searchUsable = ok; return ok; });
    return this.searchProbed;
  }
  /**
   * The workspace's folders codebase search covers: those with the setting on, read per folder (the setting's scope is
   * resource: a folder's own .vscode/settings.json decides for it, else the workspace's, else the user's). In order.
   */
  searchRoots() {
    const roots = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      let on;
      try { on = vscode.workspace.getConfiguration('perch', f.uri).get('codebaseIndex.enabled') === true; } catch (_) { on = cfg('codebaseIndex.enabled') === true; }
      if (on && !roots.includes(f.uri.fsPath)) roots.push(f.uri.fsPath);
    }
    return roots;
  }
  /** The search server for a tab's next process, or null: no folder on (the default), or no Python here that can run it. */
  codeSearch() {
    const roots = this.searchRoots();
    if (!roots.length || !this.searchUsable) return null;
    return this.codeIndex.mcpServer(roots);
  }
  /**
   * The setting, or the workspace's folders, changed. A tab takes it from its process's next start: a Claude tab is
   * restarted after its turn, as on a backend switch, since the tool list is part of the cached prompt; a Codex tab's
   * next turn is a new process anyway.
   */
  async searchChanged() {
    const python = cfg('codebaseIndex.python') || undefined;
    if ((python || (process.platform === 'win32' ? 'python' : 'python3')) !== this.codeIndex.python) {
      this.codeIndex = new CodeIndex({ root: this.root, python });
      this.searchUsable = false; this.searchProbed = null;
    }
    if (this.searchRoots().length) await this.probeSearch();
    const search = this.codeSearch(), want = search ? JSON.stringify(search.args) : '';
    const names = search ? search.args.slice(1).map((p) => require('path').basename(p)) : [];
    const what = !search ? 'Codebase search is off' : names.length > 1 ? 'Codebase search covers ' + names.join(', ') : 'Codebase search is on';
    for (const s of this.sessions) {
      if (!s.agent || s.search === want) continue;
      if (s.kind === 'codex') { s.agent.setSearch(search); s.search = want; s.post({ kind: 'note', text: `${what} for this tab from its next turn.` }); }
      else if (s.busy) { s.restartWhenIdle = `${what} for this tab; the conversation continues, the prompt cache starts over.`; s.post({ kind: 'note', text: `${what}. This tab takes it up after the current turn.` }); }
      else { s.restart(); s.post({ kind: 'note', text: `${what} for this tab from the next message; the conversation continues, the prompt cache starts over.` }); }
    }
    if (search) this.offerSearch();
    this.sendTabs();                                 // the footer's "index" shows while a folder has search on
  }
  /** Turn codebase search on or off where it is set: in the workspace's settings if they have it, else the user's. */
  async toggleSearch() {
    const c = vscode.workspace.getConfiguration('perch'), i = (c.inspect && c.inspect('codebaseIndex.enabled')) || {};
    const was = c.get('codebaseIndex.enabled') === true;
    const target = i.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update('codebaseIndex.enabled', !was, target);
    const usable = was || await this.probeSearch();   // turned on: the Python check runs now, and the word waits for it
    vscode.window.showInformationMessage(`Perch: codebase search is ${was ? 'off' : 'on'}${!was && !usable ? ', but no Python here can run it (3.8 or newer, with SQLite FTS5): set perch.codebaseIndex.python' : ''}. Each tab takes it up from its next message.`);
  }
  /** Once a machine, as a tab starts with codebase search: keywords need nothing; meaning is an install. */
  async offerSearch() {
    if (this.searchOffered || this.codeIndex.isInstalled() || this.context.globalState.get('perch.codebaseIndex.offered')) return;
    this.searchOffered = true;
    const pick = await vscode.window.showInformationMessage('Perch: Claude and Codex tabs can search this workspace by keywords (codebase search). Install search by meaning as well? About 300 MB, once, in ~/.local/share/perch/codeindex; the code never leaves this machine.', 'Install', 'Not Now', 'Turn Off');
    if (pick) await this.context.globalState.update('perch.codebaseIndex.offered', true);
    if (pick === 'Install') await this.installSearch();
    else if (pick === 'Turn Off') await vscode.workspace.getConfiguration('perch').update('codebaseIndex.enabled', false, vscode.ConfigurationTarget.Global);
  }
  /** Install search by meaning, its progress in a notification. Running search servers move onto it by themselves. */
  async installSearch() {
    if (this.codeIndex.isInstalled()) { vscode.window.showInformationMessage('Perch: search by meaning is already installed here.'); return true; }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Perch: installing search by meaning' }, (progress) => {
        let last = 0;
        return this.codeIndex.install((message, pct) => { progress.report({ message, increment: Math.max(0, pct - last) }); last = pct; });
      });
      vscode.window.showInformationMessage('Perch: search by meaning is installed. Codebase search moves to it by itself; until a workspace\'s index has its vectors, a few minutes the first time, it searches by keywords.');
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('Perch: search by meaning could not be installed: ' + String((e && e.message) || e) + ' Search by keywords goes on.');
      return false;
    }
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
  async claudeLogin(choice) {
    if (choice) {                    // from a note's button (the notification may be gone, or still waiting unseen): log in, if that is still what is missing
      if (choice !== 'Log In' || this.meter.backend() === 'api') return;
      if (this.meter.canRun()) { vscode.window.showInformationMessage('Perch: Claude is logged in. Send your message again.'); return; }
      await this.claudeSignIn();
      return;
    }
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
      await this.claudeSignIn();
    } finally { this.claudeLoginOpen = false; }
  }

  /**
   * Log In, for a message held back: Claude Code's sign-in, or the one waiting already (opened by the backend switch, say,
   * which brings it back), and said once when the login lands, however often Log In is pressed meanwhile.
   */
  async claudeSignIn() {
    const opened = await this.meter.login();
    if (!opened && !this.meter.signIn) return;        // no way in was found, and the user has been told
    if (this.claudeSignInWatched) return;             // a press before this one waits for it already, and will say
    this.claudeSignInWatched = true;
    try { if (await this.meter.waitForLogin()) vscode.window.showInformationMessage('Perch: Claude is logged in. Send your message again.'); }
    finally { this.claudeSignInWatched = false; }
  }

  // ---- the gateway: an Anthropic-compatible endpoint a Claude tab can be put on, described by a file of the user's
  /** How a Codex process is to reach Bedrock: the meter's settings, and the catalog's default model, which Codex's own default (config.toml) does not serve there. */
  codexBedrock() {
    const b = this.meter.codexBedrock();
    const d = this.catalog.codex && this.catalog.codex.defaultModel;
    return Object.assign({}, b, { defaultModel: (d && d.slug) || '' });
  }

  /** Where the gateway's file is, by the setting or the default. */
  gatewayPath() { return Gateway.gatewayFile(cfg('claude.gatewayEnv')); }
  /** The gateway as its file describes it now. Read each time: the file is small, and the user may be editing it. */
  gateway() { return Gateway.readGateway(this.gatewayPath()); }
  /** What a page needs to know of the gateway, with the tabs: whether to offer it, and whether it is in order. */
  gatewayInfo() { const gw = this.gateway(); return { file: gw.file, exists: gw.exists, ok: gw.ok }; }
  /** Tells VS Code whether there is a gateway file, so the menus offer a tab on it only then. */
  syncGatewayContext() {
    const exists = this.gateway().exists;
    if (exists === this.gatewayShown) return;
    this.gatewayShown = exists;
    Promise.resolve(vscode.commands.executeCommand('setContext', 'perch.gateway', exists)).catch(() => { /* an older VS Code */ });
  }

  /** The gateway's file, made from the template when there is none, so there is something to fill in. Owner-readable only. */
  async openGatewayFile() {
    const p = this.gatewayPath();
    try { require('fs').accessSync(p); } catch (_) { try { Gateway.createTemplate(p); } catch (e) { vscode.window.showErrorMessage('Perch: could not create ' + p + '. ' + e.message); return; } }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(p)));
  }

  /**
   * A tab on the gateway cannot reach it: the file is missing or incomplete, or Claude is on API / Bedrock, which Claude Code's
   * settings apply over a process's environment. Offer the way on: the file, the subscription, or this tab off the gateway.
   */
  async gatewayHelp(s, gw) {
    if (this.gatewayOpen) return;
    this.gatewayOpen = true;
    try {
      const off = 'Leave the Gateway';
      const pick = await vscode.window.showWarningMessage(`This tab is on the LLM gateway, but ${Gateway.describe(gw)} Perch gives a tab on the gateway the variables in that file (export KEY=VALUE lines, as a shell reads them): ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, and any model names. Nothing is written to Claude Code's settings.`, 'Open the File', off);
      if (pick === off) { if (!s.disposed) s.setGateway(false); }
      else if (pick === 'Open the File') await this.openGatewayFile();
    } finally { this.gatewayOpen = false; }
  }

  /**
   * The backend of one Claude tab, from the footer's menu. The gateway is the tab's own; subscription and API / Bedrock are
   * the window's, set with the switch every tab follows, and take the tab off the gateway if it was on it.
   */
  setBackend(s, value) {
    if (!s || s.kind !== 'claude') return;
    // the choice sticks: the next new Claude tab starts where this one was put (subscription and API / Bedrock stick through Claude Code's own setting)
    if (value === 'gateway' || value === 'subscription' || value === 'api') this.context.globalState.update(GATEWAY_DEFAULT_KEY, value === 'gateway');
    if (value === 'gateway') { s.setGateway(true); return; }
    if (value !== 'subscription' && value !== 'api') return;
    if (s.gateway) s.setGateway(false);
    if (this.meter.backend() !== value) this.meter.toggleBackend();
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
  /** Whether Codex on this machine is on a login Codex has refused: the one recorded is still the one auth.json holds. A new
   * login, or a refresh by another Codex here, rewrites the file and ends it. Kept across window reloads. */
  codexLoginRefused() {
    const was = this.context.globalState.get(REFUSED_LOGIN_KEY);
    if (!was) return false;
    if (codexAuth.authStamp() === was) return true;
    this.context.globalState.update(REFUSED_LOGIN_KEY, undefined);
    return false;
  }
  /** Codex has refused the login auth.json holds now. */
  codexRefused() { const st = codexAuth.authStamp(); if (st) this.context.globalState.update(REFUSED_LOGIN_KEY, st); }

  async codexLogin(why) {
    if (this.codexLoginOpen) return;
    this.codexLoginOpen = true;
    try {
      const lead = why || `Codex is not logged in on ${require('os').hostname()}.`;
      const pick = await vscode.window.showWarningMessage(`${lead} Perch runs it with your ChatGPT login, kept in ${codexAuth.codexHome()}. Log In opens ChatGPT's sign-in page in your browser. Device Code prints a link and a one-time code in a terminal instead, which ChatGPT must allow first (Settings, Security and login, App security).`, 'Log In', 'Device Code');
      if (!pick) return;
      await this.codexLoginRun(pick);
    } finally { this.codexLoginOpen = false; }
  }

  /** Run the Codex login the user chose ("Log In" or "Device Code"), from the notification or from a note's button. One at
   * a time: the browser sign-in listens on a fixed port. */
  async codexLoginRun(pick) {
    // one at a time, since the browser sign-in listens on a fixed port: pressed again while one waits (from a note, the
    // notification, another tab), the waiting one is brought back, its sign-in page or its terminal, and said so
    if (this.codexLoginRunning) {
      if (this.codexLoginUrl) { vscode.env.openExternal(vscode.Uri.parse(this.codexLoginUrl)); vscode.window.showInformationMessage('Perch: a Codex login is already waiting for you: its sign-in page is open again in your browser.'); }
      else if (this.codexLoginTerminal) { this.codexLoginTerminal.show(); vscode.window.showInformationMessage('Perch: a Codex login is already waiting for you, in the Codex login terminal.'); }
      return;
    }
    this.codexLoginRunning = true;
    let closed = null;               // the Device Code terminal's closing: the sign-in in it is over then, logged in or not
    try {
      const prog = program('codex');
      if (prog.from === 'none') { vscode.window.showErrorMessage('Perch: ' + MISSING.codex); return; }
      // the program itself: the SDK's own when it runs its own (resolveProgram leaves that path to the SDK), since a login is
      // run here, and `codex` alone names nothing unless one is on PATH
      const exe = prog.path || (prog.from === 'sdk' ? sdkCodex() : '') || 'codex';
      const since = codexAuth.authStamp();   // the login there now, if any, refused or not: only a new one ends the wait
      let child = null;
      if (pick === 'Device Code') {
        // the device-code sign-in prints a link and a one-time code; ChatGPT must allow it (a setting, off by default)
        const run = terminalRun(exe, ['login', '--device-auth']);
        const term = vscode.window.createTerminal(Object.assign({ name: 'Codex login' }, run.options));
        term.show();
        if (run.text) term.sendText(run.text);
        this.codexLoginTerminal = term;
        closed = whenClosed(term);
      } else {
        let started;
        try { started = await codexAuth.startLogin(exe); } catch (e) { vscode.window.showErrorMessage('Perch: the Codex login could not start. ' + e.message); return; }
        child = started.child;
        // the browser returns to localhost on the user's machine; when remote, VS Code carries that port here
        try { await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${codexAuth.CALLBACK_PORT}`)); } catch (_) { /* no forwarding: the browser may still reach it directly */ }
        this.codexLoginUrl = started.url;
        await vscode.env.openExternal(vscode.Uri.parse(started.url));
      }
      const ok = await codexAuth.waitForLogin(closed ? { since, until: closed } : { since });
      if (child) { try { child.kill(); } catch (_) { /* ended on its own */ } }
      if (ok) { this.context.globalState.update(REFUSED_LOGIN_KEY, undefined); this.codexLoginDone(); }
      if (ok) vscode.window.showInformationMessage('Perch: Codex is logged in. Send your message again.');
      else vscode.window.showWarningMessage('Perch: the Codex login did not complete.');
    } finally { if (closed) closed.dispose(); this.codexLoginRunning = false; this.codexLoginUrl = null; this.codexLoginTerminal = null; }
  }

  /** Codex is logged in: every login note, in every Codex tab, says so in place of its buttons, and so in what is replayed. */
  codexLoginDone() {
    const at = new Date(), hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
    const text = `Logged in on ${require('os').hostname()} at ${hhmm}: send the message again.`;
    for (const s of this.sessions) {
      if (s.kind !== 'codex') continue;
      let had = false;
      for (const h of s.history) if (h.kind === 'note' && h.nid === 'codexLogin' && h.actions) { delete h.actions; h.done = text; had = true; }
      if (had) this.sendEvent(s.id, { kind: 'noteDone', nid: 'codexLogin', text });
    }
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

  /**
   * The gateway ~/.claude/settings.json pins for every Claude Code (an env.ANTHROPIC_BASE_URL with an apiKeyHelper, as
   * a managed machine may set), or '' if none. A non-gateway tab inherits this pin unless it is overridden, so Perch uses it to
   * decide when a subscription / API tab needs offGatewaySettings and when the Claude catalog must load off the gateway.
   */
  pinnedGatewayUrl() {
    try {
      const p = this.meter && this.meter.meter && this.meter.meter.settingsPath;
      if (!p) return '';
      const d = JSON.parse(require('fs').readFileSync(p, 'utf8')) || {};
      const url = d.env && d.env.ANTHROPIC_BASE_URL;
      return (typeof url === 'string' && url && d.apiKeyHelper) ? url : '';
    } catch (_) { return ''; }
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
    // Claude's models are named by its backend: on Bedrock `us.anthropic.claude-fable-5-1`, "Fable"; on the subscription
    // `claude-fable-5-1`, "Fable 5.1". So the catalog is loaded for the backend the window's tabs run on, said outright rather
    // than left to whatever the environment holds; and only the latest load is kept, so a slower one started before a
    // backend switch cannot put the other backend's names back (seen 2026-10-27: a subscription tab given Bedrock's id).
    // When the machine pins a gateway for all Claude Code, the catalog is loaded off it, so non-gateway tabs list native
    // models rather than the gateway's anthropic/… names. Gateway tabs use Gateway.gatewayModels instead.
    const gen = this.catalogGen = (this.catalogGen || 0) + 1;
    const api = !!(this.meter && this.meter.backend() === 'api');
    this.loading = Promise.resolve()
      .then(() => loadClaudeModels({ cwd: cwd(), executable: program('claude').path || undefined, settings: this.pinnedGatewayUrl() ? Gateway.offGatewaySettings(api) : { env: { CLAUDE_CODE_USE_BEDROCK: api ? '1' : '0' } } }))
      .then((cat) => { if (gen === this.catalogGen) apply('claude', cat); })
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

  /** A Perch tab closed, or went to another group, which VS Code tells as a close in the group it left: that group is looked at. */
  tabsChanged(e) {
    for (const t of (e && e.closed) || []) if (isPerchTab(t) && t.group) this.leftGroups.add(t.group);
    if (!this.leftGroups.size || this.closing) return;
    clearTimeout(this.unlockTimer);
    this.unlockTimer = setTimeout(() => { this.unlockTimer = null; this.unlockGroups(); }, UNLOCK_DELAY_MS);
    if (this.unlockTimer.unref) this.unlockTimer.unref();
  }

  /**
   * A group whose last Perch tab has gone, and which still holds other tabs, is unlocked. Perch locked it while it held
   * only sessions; files that came in later left it locked, and a file opened from the Explorer then went past it into a
   * new group. A group holding an editor that locks a group by itself (workbench.editor.autoLockGroups: a terminal's, say)
   * keeps its lock, which may be that editor's.
   *
   * The unlock command is pointed at the group by a file open in it: VS Code takes the first group, most recently used
   * first, that has the file. So the file is one open in no other group, unless this group is the active one, which comes
   * first. Given a file it cannot find VS Code unlocks the active group. Before 1.92 it looked only at each group's active
   * editor, and named the group it found by its place in the window where an id was wanted, which can be another group
   * (1.90, 1.91). So Perch passes only a file it has just seen in the group, and before 1.92 does nothing.
   */
  unlockGroups() {
    const left = [...this.leftGroups];
    this.leftGroups.clear();
    if (this.closing || cfg('lockGroup') === false || !atLeast(vscode.version, 1, 92)) return;
    const tg = vscode.window.tabGroups, all = (tg && tg.all) || [], active = tg && tg.activeTabGroup;
    const auto = vscode.workspace.getConfiguration('workbench.editor').get('autoLockGroups');
    const locksItself = (t) => !!auto && typeof auto === 'object' && editorIds(t).some((id) => auto[id] === true);
    for (const g of left) {
      const tabs = (all.includes(g) && g.tabs) || [];
      if (!tabs.length || tabs.some(isPerchTab) || tabs.some(locksItself)) continue;
      const elsewhere = new Set(all.filter((o) => o !== g).flatMap((o) => (o.tabs || []).flatMap(tabUris)));
      const t = tabs.find((x) => x.input && isUri(x.input.uri) && (g === active || !elsewhere.has(String(x.input.uri))));
      if (t) Promise.resolve(vscode.commands.executeCommand('workbench.action.unlockEditorGroup', t.input.uri)).catch(() => { /* the lock stays */ });
    }
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
    const gw = this.gatewayInfo(); this.syncGatewayContext();
    if (this.sidebar.ready && this.sidebar.view) this.sidebar.view.webview.postMessage({ type: 'tabs', tabs: this.sessions.filter((s) => s.location === 'sidebar').map((s) => s.toTab()), active: this.activeId, gateway: gw });
    for (const [sid, e] of this.panels) {
      const s = this.get(sid); if (!s) continue;
      const title = this.panelTitle(s); if (e.panel.title !== title) e.panel.title = title;
      if (e.ready) e.panel.webview.postMessage({ type: 'tabs', tabs: [s.toTab()], active: sid, single: true, gateway: gw });
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
      case 'unqueue': if (s) s.unqueue(String(msg.qid || '')); return;
      case 'setMode': if (s) { s.setMode(msg.value); this.sendTabs(); } return;
      case 'setEffort': if (s) { s.setEffort(msg.value); this.sendTabs(); } return;
      case 'setModel': if (s) { s.setModel(msg.value); this.sendTabs(); } return;
      case 'attach': this.attach(msg.sid); return;
      case 'setIde': if (s) { s.setIde(msg.value); this.sendTabs(); } return;
      case 'switchVendor':           // the footer's vendor menu (note 202)
        if (s) this.trace(`the page asks: tab ${s.id.slice(0, 8)} "${s.title}" ${s.kind} → ${msg.kind}, model ${JSON.stringify(msg.model)}`);
        if (s && (msg.kind === 'claude' || msg.kind === 'codex')) this.continueIn(msg.kind, { sid: s.id, model: String(msg.model || '') });
        return;
      case 'setBackend': this.setBackend(s, msg.value); return;
      case 'meterRefresh': if (msg.vendor === 'codex') this.meter.refreshCodex(); else this.meter.poll(); return;
      case 'meterToggle': if (msg.vendor === 'codex') this.meter.toggleCodexBackend(); else this.meter.toggleBackend(); return;
      case 'codexBackend': this.meter.chooseCodexBackend(String(msg.value || '')); return;   // the footer's menu under a Codex tab: ChatGPT, an API key, or Bedrock
      case 'meterLogin': this.meter.login(); return;
      case 'voiceStart': if (s) this.voice.start(s.id); return;
      case 'voiceStop': if (s) this.voice.stop(s.id); return;
      case 'voiceCancel': this.voice.cancel(); return;
      case 'activate': this.activate(msg.sid); return;
      case 'new': this.addSession(msg.kind, msg.gateway === undefined ? {} : { gateway: !!msg.gateway }); return;   // no flag: the default for new tabs decides
      case 'close': this.closeSession(msg.sid); return;
      case 'rename': if (s) this.renameTab(s.id); return;
      case 'open': this.openTarget(msg.target); return;
      case 'copy': vscode.env.clipboard.writeText(String(msg.text || '')); return;
      case 'noteAction':             // a button under a note: the gateway file, or this tab off the gateway. Old notes keep their buttons, so each is safe to press again
        if (msg.action === 'gatewayFile') this.openGatewayFile();
        else if (msg.action === 'gatewayLeave') { if (s && s.gateway) s.setGateway(false); }
        // the ways into Claude and Codex. A button may be an old note's: each acts only on what still applies
        else if (msg.action === 'claudeSettings') this.openSettingsFile();
        else if (msg.action === 'handoffPreview') this.previewHandoff(s);   // what the next message carries after a switch (note 202)
        else if (msg.action === 'claudeSubscription') { if (this.meter.backend() === 'api') this.meter.toggleBackend(); }
        else if (msg.action === 'claudeApi') { if (this.meter.backend() !== 'api') this.meter.toggleBackend(); }
        else if (msg.action === 'claudeLogin') this.claudeLogin('Log In');
        else if (msg.action === 'codexChatgpt') { if (this.meter.codexBackend() !== 'chatgpt') this.meter.chooseCodexBackend('chatgpt'); }
        else if (msg.action === 'codexLogin' || msg.action === 'codexDevice') {
          if (codexAuth.loggedIn() && !this.codexLoginRefused()) { this.codexLoginDone(); vscode.window.showInformationMessage('Perch: Codex is logged in. Send your message again.'); }
          else this.codexLoginRun(msg.action === 'codexDevice' ? 'Device Code' : 'Log In');
        }
        return;
      case 'openExternal': { const u = String(msg.url || ''); if (/^https:\/\/(chatgpt\.com|platform\.openai\.com|claude\.ai|console\.anthropic\.com)\//.test(u)) vscode.env.openExternal(vscode.Uri.parse(u)); return; }   // the vendors' own pages, nothing else
      case 'history': this.pickSession(); return;
      case 'subagentUsage': this.subagentUsage(s); return;
      case 'indexStatus': this.indexStatus(s); return;
      default: return;
    }
  }

  /**
   * A tab's session, thread by thread, for the table the footer's "sub-agents" opens: the main thread and every
   * sub-agent it started, each with its model, turns and tokens from its own file (sessionStore.sessionUsage for Codex,
   * claudeSessionUsage for Claude), and what those would cost at list prices, from the table the gateway's turns are
   * priced with. Nothing is billed per token on a plan; the figures still say where the work went.
   */
  async subagentUsage(s) {
    if (!s) return;
    const say = (o) => { const f = this.surface(s); if (f && f.ready) f.webview.postMessage(Object.assign({ type: 'subagentUsage', sid: s.id, at: Date.now(), kind: s.kind }, o)); };
    const vendor = s.kind === 'claude' ? 'Claude' : 'Codex';
    if (!s.agentSessionId) { say({ error: `This tab has no ${vendor} session yet. Its table can be read once its first turn has started.` }); return; }
    const home = codexAuth.codexHome();
    // the list prices: a table read before serves at once (an old one is fetched again behind it); with none yet, the fetch
    // is waited for a few seconds at most, and the table is unpriced until it lands
    const loading = this.prices.load();
    if (!this.prices.loaded) await Promise.race([loading, new Promise((r) => { const t = setTimeout(r, 5000); if (t.unref) t.unref(); })]);
    let u;
    try { u = s.kind === 'claude' ? await claudeSessionUsage(s.agentSessionId) : await sessionUsage(s.agentSessionId, { home }); }
    catch (err) { say({ error: 'Could not read this session\'s files: ' + String((err && err.message) || err) }); return; }
    if (!u) { say({ error: 'This session\'s file was not found under ' + (s.kind === 'claude' ? require('path').join(process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude'), 'projects') : require('path').join(home, 'sessions')) + '.' }); return; }
    // each model's share of a thread at that model's rates; a thread with a model the table does not price is not priced
    const priced = (row) => {
      let cost = 0; const unpriced = [];
      for (const x of row.spent || []) {
        if (!(x.input || x.output)) continue;
        const rate = x.model ? this.prices.rateFor(x.model) : null;
        if (!rate) { const m = x.model || 'no model named'; if (!unpriced.includes(m)) unpriced.push(m); continue; }
        cost += Prices.costOf(rate, { input: Math.max(0, x.input - x.cached - x.write), cache_write: x.write, cache_read: x.cached, output: x.output });
      }
      const out = Object.assign({}, row, unpriced.length ? { cost: null, unpriced } : { cost });
      delete out.spent;
      return out;
    };
    say({ main: priced(u.main), subagents: u.subagents.map(priced), prices: this.prices.loaded, backend: s.kind === 'claude' ? (s.backend || this.meter.backend()) : this.meter.codexBackend() });
  }

  /**
   * The codebase search index of this workspace, folder by folder, for the panel the footer's "index" opens: read from
   * the indexes' files by the server's --status (src/codeIndex.js), so a build in progress shows its counts growing.
   * Nothing is built here.
   */
  async indexStatus(s) {
    if (!s) return;
    const say = (o) => { const f = this.surface(s); if (f && f.ready) f.webview.postMessage(Object.assign({ type: 'indexStatus', sid: s.id, at: Date.now() }, o)); };
    const roots = this.searchRoots();
    if (!roots.length) { say({ on: false, why: 'Codebase search is off for this workspace. Perch: Toggle Codebase Search turns it on, for every workspace or for this one.' }); return; }
    if (!this.searchUsable) { await this.probeSearch(); }
    if (!this.searchUsable) { say({ on: false, why: 'Codebase search is on, but no Python here can run it (3.8 or newer, with SQLite FTS5): set perch.codebaseIndex.python.' }); return; }
    try { say(Object.assign({ on: true }, await this.codeIndex.status(roots))); }
    catch (err) { say({ on: true, error: 'The indexes could not be read: ' + String((err && err.message) || err) }); }
  }

  // ---- session management
  /** @param {object} [o]  `resume` opens the tab on a session the agent has already recorded, under the name it has there;
   *  `gateway` puts a Claude tab on the gateway */
  addSession(kind, { fill, location, resume, title, gateway } = {}) {
    if (kind !== 'claude' && kind !== 'codex') return null;
    if (gateway === undefined && kind === 'claude' && !resume) gateway = this.context.globalState.get(GATEWAY_DEFAULT_KEY) === true;   // where the last Claude tab was put
    const vendor = kind === 'claude' ? 'Claude' : 'Codex';
    // a machine where Codex's sandbox cannot start (codexNoSandbox): new Codex tabs run without one, and say so
    const mode = kind === 'codex' && this.codexUnsandboxedHere() ? 'danger-full-access' : undefined;
    const s = new Session(this, resume
      ? { kind, title: cleanTitle(title) || `${vendor} ${String(resume).slice(0, 8)}`, titled: true, resume, mode, location: location || this.where(), gateway }
      : { kind, title: `${vendor} ${++this.counters[kind]}`, mode, location: location || this.where(), gateway });
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

  /** The kinds of tab on offer: one of each agent. A Claude tab moves onto the gateway from its backend menu. */
  freshKinds() {
    const list = [{ kind: 'claude', label: 'Claude', tab: 'Claude tab', description: 'New Claude Code tab' }];
    list.push({ kind: 'codex', label: 'Codex', tab: 'Codex tab', description: 'New Codex tab' });
    return list;
  }

  async pickNew() {
    const pick = await vscode.window.showQuickPick(this.freshKinds().map((k) => ({ label: k.label, description: k.description, kind: k.kind, gateway: k.gateway })), { placeHolder: 'New Perch tab' });
    return pick ? this.addSession(pick.kind, { gateway: pick.gateway }) : null;
  }

  closeSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.sessions[i];
    this.voice.closed(id);
    s.dispose();
    try { Handoff.removeHandoffs(id); } catch (_) { /* nothing written */ }
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
    s.title = name; s.titled = true; s.unsaved = true; s.named = true;
    this.persist();
    this.sendTabs();
    await this.saveName(s);
    return true;
  }

  /**
   * A tab the user has not named shows the title its agent's record has: Claude Code titles a session itself as the
   * conversation goes on, and the sessions list reads those titles, so a tab still showing the start of its first message
   * could not be found in the list by name. Looked up when a turn ends; the list does the same for every open tab.
   */
  async syncTitle(s) {
    if (!s || s.kind !== 'claude' || s.named || s.unsaved || !s.agentSessionId) return;
    let t = null;
    try { t = await titleOf(s.kind, s.agentSessionId, { dir: cwd() }); } catch (_) { return; }
    this.adoptTitle(s, t);
  }
  /** Give an open tab the title of its record, unless the name is the user's. @returns {boolean} whether it changed */
  adoptTitle(s, t) {
    if (!s || s.disposed || s.named || s.unsaved || !t || !t.title) return false;
    if (t.named) s.named = true;     // the record's name is one a user gave it
    if (t.title === s.title) return false;
    s.title = t.title; s.titled = true;
    this.sendTabs(); this.persist();
    return true;
  }

  /** Write a tab's name to its agent's record. A tab that has not had a turn has no record yet: this runs again when its first turn ends. */
  async saveName(s) {
    if (!s.unsaved || !s.agentSessionId) return;
    s.unsaved = false;                 // tried once: a record that cannot be written is not retried after every turn
    this.persist();
    // a tab that has been on both vendors has a record with each, and its name is written to every one (note 202)
    const records = []; for (const p of s.periods) if (p.resume && !records.some((r) => r.kind === p.kind && r.id === p.resume)) records.push({ kind: p.kind, id: p.resume });
    if (!records.some((r) => r.kind === s.kind && r.id === s.agentSessionId)) records.push({ kind: s.kind, id: s.agentSessionId });
    for (const r of records) {
      try { await renameSession(r.kind, r.id, s.title, { dir: cwd() }); }
      catch (e) { vscode.window.showWarningMessage(`Perch: this tab keeps its name, but ${r.kind === 'claude' ? 'Claude Code' : 'Codex'}'s record of the session could not be given it. ${e.message}`); }
    }
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

  /**
   * Delete a past session, from the list: asked first, in a dialog that waits, since the agent's record of the conversation
   * is removed from this machine and cannot be brought back. A tab open on it is closed first: its agent would write the
   * record again.
   */
  async deletePast(past) {
    if (!past || !past.id) return;
    const vendor = past.kind === 'claude' ? 'Claude Code' : 'Codex';
    const open = this.sessions.find((s) => s.kind === past.kind && s.agentSessionId === past.id);
    const pick = await vscode.window.showWarningMessage(`Delete "${past.title}"?`, { modal: true, detail: `${vendor}'s record of this session is removed from this machine and cannot be brought back.${open ? ' Its tab is open and will be closed.' : ''}` }, 'Delete');
    if (pick !== 'Delete') return;
    let codex;
    if (past.kind === 'codex') { const prog = program('codex'); if (prog.from === 'none') { vscode.window.showErrorMessage('Perch: ' + MISSING.codex); return; } codex = prog.path || 'codex'; }
    if (open) this.closeSession(open.id);
    try { await deleteSession(past.kind, past.id, { dir: cwd(), codex }); }
    catch (e) { vscode.window.showErrorMessage(`Perch: the session could not be deleted. ${e.message}`); }
  }

  /** Open a tab on a past session, or go to the tab that is already open on it: two agents must not write one record. */
  /** The open tab a vendor's record belongs to: the one running it, else one that ran it before a switch (note 202). */
  owner(kind, id) { return this.sessions.find((s) => s.kind === kind && s.agentSessionId === id) || this.sessions.find((s) => s.periods.some((p) => p.kind === kind && p.resume === id)) || null; }

  resumeSession(past) {
    const open = this.owner(past.kind, past.id);   // a record a tab switched away from opens that tab, not a second one
    if (!open) return this.addSession(past.kind, { resume: past.id, title: past.title });
    this.activate(open.id);
    if (open.location === 'sidebar' && this.sidebar.view && this.sidebar.view.show) this.sidebar.view.show(true);
    return open;
  }

  /** The list of past sessions of this folder, from both agents: type to search, choose one to open it, or rename it. */
  async pickSession() {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Perch sessions'; qp.placeholder = 'Search sessions…'; qp.matchOnDescription = true; qp.busy = true;
    qp.onDidAccept(() => { const it = qp.selectedItems[0]; qp.hide(); if (it && it.fresh) this.addSession(it.fresh, { gateway: it.gateway }); else if (it) this.resumeSession(it.past); });
    // the box that asks for the name takes the list's place, so the list is opened again afterwards, with the new name in it
    qp.onDidTriggerItemButton(async (e) => { qp.hide(); if (e.button && e.button.tooltip === 'Delete session') await this.deletePast(e.item.past); else await this.renamePast(e.item.past); await this.pickSession(); });
    qp.onDidHide(() => qp.dispose());
    qp.show();
    const { sessions, failed } = await listSessions({ dir: cwd(), limit: 200 });
    const rename = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename session' }, del = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete session' };
    // a new tab is also a way in, so the list begins with one of each kind, whatever is typed
    const fresh = this.freshKinds().map((k) => ({ label: `$(add) New ${k.tab}`, fresh: k.kind, gateway: k.gateway, alwaysShow: true }));
    qp.items = fresh.concat(sessions.map((p) => {
      const open = this.owner(p.kind, p.id), running = !!open && open.kind === p.kind && open.agentSessionId === p.id;
      if (running) this.adoptTitle(open, p);   // an open tab and its row say the same name: the record's, unless the user named the tab
      const past = open && open.unsaved ? Object.assign({}, p, { title: open.title }) : p;
      return { label: past.title, description: [open && open.path() ? open.path().map((k) => VENDOR[k]).join(' → ') : p.kind === 'claude' ? 'Claude' : 'Codex', ago(p.updatedAt), open ? 'open' : ''].filter(Boolean).join(' · '), iconPath: tabIcon(p.kind), buttons: [rename, del], past };
    }));
    const missing = failed.map((k) => (k === 'claude' ? 'Claude Code' : 'Codex')).join(' and ');
    if (!sessions.length) qp.placeholder = missing ? `The sessions of ${missing} could not be read` : 'No past sessions in this folder';
    else if (missing) qp.title = `Perch sessions · those of ${missing} could not be read`;
    qp.busy = false;
    return qp;
  }

  /** The way back in when no tab is on screen: the tab last used, or the sessions list, which starts a new tab too. */
  open() {
    const s = this.get(this.activeId) || this.sessions[this.sessions.length - 1];
    if (!s) return this.pickSession();
    this.activate(s.id);
    if (s.location === 'sidebar' && this.sidebar.view && this.sidebar.view.show) this.sidebar.view.show(true);
    return s;
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

  /** A tab went on with the other vendor: its editor tab's icon is that vendor's now, and the page's composer follows it. */
  vendorChanged(s) {
    const e = this.panels.get(s.id);
    if (e) { const icon = tabIcon(s.kind); if (icon) e.panel.iconPath = icon; }
    this.sendTabs();
  }

  /**
   * Go on in the active tab with the other vendor (note 202): pick its model, see what it will read, then switch. The
   * conversation so far goes to it with the next message, as text: nothing is sent until the user sends.
   * @param {'claude'|'codex'} kind
   */
  async continueIn(kind, { sid, model } = {}) {
    const s = sid ? this.get(sid) : this.active(), V = VENDOR[kind];
    if (!s) { vscode.window.showInformationMessage('Perch: no tab is active.'); return; }
    if (s.kind === kind) { vscode.window.showInformationMessage(`Perch: "${s.title}" is on ${V} already. Its model is chosen from the pill under the message box.`); return; }
    if (s.busy || s.pending.size) { vscode.window.showInformationMessage(`Perch: "${s.title}" is working. Switch once its turn has ended.`); return; }
    const cat = this.catalog[kind];
    const items = [{ label: 'default' + (cat && cat.defaultModel && cat.defaultModel.label ? ' · ' + cat.defaultModel.label : ''), value: '' }, ...((cat && cat.models) || []).map((m) => ({ label: m.label, description: m.value, value: m.value }))];
    // from the footer's menu the model is chosen there; from the command, here
    const pick = typeof model === 'string' ? items.find((i) => i.value === model) || { label: model, value: model } : await vscode.window.showQuickPick(items, { placeHolder: `Continue "${s.title}" on ${V} with…` });
    if (!pick) return;
    let h;
    try { h = await s.prepareHandoff(); } catch (err) { vscode.window.showErrorMessage('Perch: could not read this tab\'s conversation: ' + String((err && err.message) || err)); return; }
    // no confirmation: nothing is sent until the user sends, and a switch straight back costs nothing (a stretch in which
    // nothing was said is dropped). What goes is said on the divider, whose Preview shows it
    if (s.busy || s.pending.size || s.kind === kind) return;   // it started working, or switched, while the conversation was read
    s.switchVendor(kind, { model: pick.value, handoff: h });
    this.activate(s.id);
  }

  /** The conversation a switched tab sends with its next message, as text, in an editor; after it has gone, a word that it has. */
  async previewHandoff(s) {
    if (!s) return;
    if (!s.handoff) { vscode.window.showInformationMessage('Perch: the conversation went with the first message after the switch; the agent has it now.'); return; }
    const doc = await vscode.workspace.openTextDocument({ content: s.handoff.text, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async handoff() {
    const from = this.active();
    const text = from ? from.lastAnswer() : '';
    if (!text) { vscode.window.showInformationMessage('The active Perch tab has no answer to hand off yet.'); return; }
    const items = [
      ...this.sessions.filter((s) => s.id !== from.id).map((s) => ({ label: s.title, description: s.kind, sid: s.id })),
      ...this.freshKinds().map((k) => ({ label: `New ${k.tab}`, description: k.kind, kind: k.kind, gateway: k.gateway })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Send the last answer from "${from.title}" to…` });
    if (!pick) return;
    if (!pick.sid) { this.addSession(pick.kind, { fill: text, location: from.location, gateway: pick.gateway }); return; }
    const to = this.get(pick.sid);
    this.activate(pick.sid);
    const f = this.surface(to);
    if (f && f.ready) this.sendEvent(pick.sid, { kind: 'fill', text }); else to.prefill = text;
    if (to.location === 'sidebar' && this.sidebar.view) this.sidebar.view.show(true);
  }

  /** A line in the Perch output channel: what the page asked and what the host did, for the few things worth tracing. */
  trace(line) { if (this.out) { try { this.out.appendLine(new Date().toISOString() + ' ' + line); } catch (_) { /* the channel is gone */ } } }

  dispose() {
    this.closing = true;             // the editor tabs are going away with the window, not being closed by the user
    clearTimeout(this.graceTimer);
    clearTimeout(this.unlockTimer);
    for (const s of this.sessions) s.dispose();
    this.meter.dispose();
    this.voice.dispose();
    if (this.out) { try { this.out.dispose(); } catch (_) { /* already gone */ } }
  }
}

function activate(context) {
  watchEditors(context);
  const perch = new PerchView(context);
  perch.meter.start();
  const tg = vscode.window.tabGroups;
  if (tg && tg.onDidChangeTabs) context.subscriptions.push(tg.onDidChangeTabs((e) => perch.tabsChanged(e)));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.main', perch, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, perch),
    vscode.commands.registerCommand('perch.new', () => perch.pickNew()),
    vscode.commands.registerCommand('perch.open', () => perch.open()),
    vscode.commands.registerCommand('perch.newClaude', () => perch.addSession('claude')),
    vscode.commands.registerCommand('perch.newClaudeGateway', () => perch.addSession('claude', { gateway: true })),
    vscode.commands.registerCommand('perch.newCodex', () => perch.addSession('codex')),
    vscode.commands.registerCommand('perch.stop', () => { const s = perch.active(); if (s) s.interrupt(); }),
    vscode.commands.registerCommand('perch.closeTab', () => { const s = perch.active(); if (s) perch.closeSession(s.id); }),
    vscode.commands.registerCommand('perch.handoff', () => perch.handoff()),
    vscode.commands.registerCommand('perch.continueInCodex', () => perch.continueIn('codex')),
    vscode.commands.registerCommand('perch.continueInClaude', () => perch.continueIn('claude')),
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
    vscode.commands.registerCommand('perch.codex.toggleBackend', () => perch.meter.toggleCodexBackend()),
    vscode.commands.registerCommand('perch.codex.setApiKey', async () => { if (await perch.meter.setCodexApiKey()) { await perch.meter.setCodexBackend('api'); vscode.window.showInformationMessage('Perch: Codex will use your API key from the next message.'); } }),
    vscode.commands.registerCommand('perch.codex.clearApiKey', async () => { await perch.meter.clearCodexApiKey(); vscode.window.showInformationMessage('Perch: the Codex API key is gone; Codex uses your ChatGPT login.'); }),
    vscode.commands.registerCommand('perch.voice.setup', async () => { const r = await perch.voice.prepare(true); if (r === 'already') vscode.window.showInformationMessage('Perch: voice input is already set up here.'); else if (r) vscode.window.showInformationMessage('Perch: voice input is ready.'); }),
    vscode.commands.registerCommand('perch.voice.toggle', () => { const s = perch.active(); if (s) perch.voice.start(s.id); }),
    vscode.commands.registerCommand('perch.voice.cancel', () => perch.voice.cancel()),
    vscode.commands.registerCommand('perch.voice.unload', () => perch.voice.unload()),
    vscode.commands.registerCommand('perch.codebaseIndex.toggle', () => perch.toggleSearch()),
    vscode.commands.registerCommand('perch.codebaseIndex.install', () => perch.installSearch()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('perch.codebaseIndex')) perch.searchChanged(); }),
    ...(vscode.workspace.onDidChangeWorkspaceFolders ? [vscode.workspace.onDidChangeWorkspaceFolders(() => perch.searchChanged())] : []),   // a folder added or removed: the search covers it, or not, from each tab's next process
    { dispose: () => perch.dispose() },
  );
  perch.start();
  return perch;   // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
