'use strict';
// Past sessions and their names, read from each agent's own records. No VS Code dependency.
//
// Perch keeps no list of its own. Claude Code records each session as a JSONL file under ~/.claude/projects/, and a
// name given to one is a line appended to that file; the Agent SDK reads and writes both. Codex records each thread as
// a rollout file under ~/.codex/sessions/YYYY/MM/DD/, and keeps names apart, in ~/.codex/session_index.jsonl: one line
// per naming, never rewritten, so the last line for a thread is its name. A name written here is therefore the name
// the vendor's own clients read, and a name given there is the one shown here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { newestRollouts } = require('./codexMeter');

const MAX_TITLE = 80;
const HEAD_BYTES = 256 * 1024;   // a rollout opens with its instructions; the first message follows within this
const MAX_ROLLOUTS = 300;
const MAX_PAST = 1000;           // entries of an earlier transcript that are shown: the most recent ones
const MAX_RESULT = 4000, MAX_INPUT = 2000;   // what a tool returned and what it was given, as the live transcript cuts them

/** A name as it is stored: one line, no runs of spaces, no longer than a tab can show. '' if nothing is left. */
function cleanTitle(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim(); }

/** How long ago, the way a session list says it: now, 5m, 3h, 12d, 2mo, 1y. */
function ago(then, now = Date.now()) {
  const min = Math.floor(Math.max(0, now - then) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return min + 'm';
  if (min < 24 * 60) return Math.floor(min / 60) + 'h';
  const days = Math.floor(min / (24 * 60));
  if (days < 30) return days + 'd';
  if (days < 365) return Math.floor(days / 30) + 'mo';
  return Math.floor(days / 365) + 'y';
}

// ---- Claude
let sdkLoad = null;
function claudeSdk() { return sdkLoad || (sdkLoad = import('@anthropic-ai/claude-agent-sdk')); }

/** @returns {Promise<object[]>} sessions of this directory, newest first */
async function listClaude({ dir, limit = 100, sdk } = {}) {
  const api = sdk || await claudeSdk();
  const got = await api.listSessions({ dir, limit });
  const out = [];
  for (const s of got || []) {
    const title = cleanTitle(s.customTitle || s.summary || s.firstPrompt);
    if (!s.sessionId || !title) continue;
    out.push({ kind: 'claude', id: s.sessionId, title, named: !!s.customTitle, updatedAt: Number(s.lastModified) || 0 });
  }
  return out;
}

async function renameClaude(id, title, { dir, sdk } = {}) {
  const api = sdk || await claudeSdk();
  await api.renameSession(id, title, dir ? { dir } : undefined);
}

// ---- Codex
/** The first `bytes` of a file as whole lines. */
function head(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    const text = buf.toString('utf8');
    return n < size ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

/** Thread names by id. Later lines win. */
function codexNames(home) {
  const names = new Map();
  let text; try { text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'); } catch (_) { return names; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); const name = cleanTitle(o && o.thread_name); if (o && typeof o.id === 'string' && name) names.set(o.id, name); } catch (_) { /* a torn line */ }
  }
  return names;
}

/**
 * What the start of a rollout says about its thread: whose it is, where it ran, and the first thing the user wrote.
 * Codex opens a thread with messages of its own in the user's role (the environment, as a tagged block); those are
 * not the user's words.
 * @returns {{ id: string, cwd: string, first: string } | null}  null for a thread that is not the user's own
 */
function parseRolloutHead(text) {
  let meta = null, first = '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const p = o && o.payload;
    if (!p) continue;
    if (o.type === 'session_meta') {
      if (meta) continue;
      if (typeof p.source !== 'string') return null;                          // a sub-agent's thread
      if (p.thread_source && p.thread_source !== 'user') return null;
      meta = { id: String(p.id || p.session_id || ''), cwd: String(p.cwd || '') };
    } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      const said = p.content.filter((c) => c && c.type === 'input_text' && typeof c.text === 'string').map((c) => c.text).join(' ').trim();
      if (!said || said.startsWith('<')) continue;
      first = said.split('\n<ide_context>')[0].trim();                         // what Perch attaches is not part of the message
      break;
    }
  }
  return meta && meta.id ? Object.assign(meta, { first }) : null;
}

/** @returns {object[]} threads of this directory, newest first */
function listCodex({ dir, home = path.join(os.homedir(), '.codex'), limit = 100 } = {}) {
  const names = codexNames(home), out = [];
  let files; try { files = newestRollouts(path.join(home, 'sessions'), MAX_ROLLOUTS); } catch (_) { return out; }
  for (const f of files) {
    if (out.length >= limit) break;
    let got; try { got = parseRolloutHead(head(f.file, HEAD_BYTES)); } catch (_) { continue; }
    if (!got || (dir && got.cwd !== dir)) continue;
    const name = names.get(got.id), title = name || cleanTitle(got.first);
    if (!title) continue;                                                      // nothing was ever said in it
    out.push({ kind: 'codex', id: got.id, title, named: !!name, updatedAt: Math.round(f.mtime) });
  }
  return out;
}

function renameCodex(id, title, { home = path.join(os.homedir(), '.codex'), now = Date.now() } = {}) {
  const file = path.join(home, 'session_index.jsonl');
  let lead = '';
  try { const size = fs.statSync(file).size; if (size) { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) lead = '\n'; } finally { fs.closeSync(fd); } } }
  catch (e) { if (e.code !== 'ENOENT') throw e; fs.mkdirSync(home, { recursive: true }); }
  fs.appendFileSync(file, lead + JSON.stringify({ id, thread_name: title, updated_at: new Date(now).toISOString() }) + '\n');
}

// ---- the transcript of a past session, as the events a live one would have produced
const cut = (s, n) => (s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false });
function trimInput(v) {
  let s; try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch (_) { return String(v); }
  return s === undefined ? '' : s.length > MAX_INPUT ? s.slice(0, MAX_INPUT) + '…' : v;
}
const isImage = (b) => !!b && (b.type === 'image' || b.type === 'input_image' || b.type === 'local_image');

/** What the user wrote, out of a block of text that Claude Code may have written in the user's name. '' if none of it is the user's. */
function claudeSaid(text) {
  const t = String(text || '').trim();
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) { const args = /<command-args>([^<]*)<\/command-args>/.exec(t); return (cmd[1].trim() + ' ' + (args ? args[1].trim() : '')).trim(); }
  if (/^<(system-reminder|local-command-[a-z]+|command-message|command-stdout|task-notification)>/.test(t) || t.startsWith('Caveat: The messages below were generated by the user while running local commands')) return '';
  return t;
}

/**
 * The IDE context perch attaches to a message is not part of what the user wrote: a past message is shown without it,
 * tagged as a live one is, with the file's name and the lines if any.
 * @returns {{text: string, tag?: string}}
 */
function splitIde(said) {
  const at = String(said || '').indexOf('\n<ide_context>');
  if (at < 0) return { text: String(said || '').trim() };
  const block = said.slice(at);
  const file = /Active file: (.+?)(?: \([^)\n]*\))?\n/.exec(block), sel = /Selection: lines (\d+)-(\d+)/.exec(block);
  const name = file ? path.basename(file[1]) : '';
  const tag = name ? name + (sel ? `:${sel[1]}` + (sel[2] !== sel[1] ? `-${sel[2]}` : '') : '') : 'IDE context';
  return { text: said.slice(0, at).trim(), tag };
}

/** @param {object[]} messages  as the Agent SDK returns them */
function claudeEvents(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.parent_tool_use_id || !m.message) continue;                    // a sub-agent's own exchange is not part of this one
    const c = m.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (m.type === 'user') {
      const raw = blocks.filter((b) => b && b.type === 'text').map((b) => claudeSaid(b.text)).filter(Boolean).join('\n'), images = blocks.filter(isImage).length;
      const { text: said, tag } = splitIde(raw);
      if (said || images) out.push(Object.assign({ kind: 'user', text: said, queued: false }, images ? { images } : {}, tag ? { tag } : {}));
      for (const b of blocks) if (b && b.type === 'tool_result') {
        const text = Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : String(b.content || '');
        out.push(Object.assign({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error }, cut(text, MAX_RESULT)));
      }
    } else if (m.type === 'assistant') {
      const texts = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && b.text) texts.push(b.text);
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id, name: b.name, input: trimInput(b.input) });
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
      }
      if (texts.length) out.push({ kind: 'text', text: texts.join('\n') });
    }
  }
  return out;
}

/** @param {string} text  a whole rollout file */
function codexEvents(text) {
  const out = [];
  const flat = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : v && typeof v === 'object' ? String(v.content || v.output || JSON.stringify(v)) : '');
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const p = o && o.type === 'response_item' && o.payload;
    if (!p) continue;
    if (p.type === 'message' && Array.isArray(p.content)) {
      if (p.role === 'user') {
        const said = p.content.filter((c) => c && c.type === 'input_text' && typeof c.text === 'string' && !c.text.trim().startsWith('<')).map((c) => c.text).join('\n');
        const { text: words, tag } = splitIde(said), images = p.content.filter(isImage).length;
        if (words || images) out.push(Object.assign({ kind: 'user', text: words, queued: false }, images ? { images } : {}, tag ? { tag } : {}));
      } else if (p.role === 'assistant') {
        const said = p.content.filter((c) => c && c.type === 'output_text' && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (said) out.push({ kind: 'text', text: said });
      }
    } else if (p.type === 'reasoning') {
      const said = (Array.isArray(p.summary) ? p.summary : []).map((x) => (x && x.text) || '').filter(Boolean).join('\n');
      if (said) out.push({ kind: 'thinking', text: said });                    // the reasoning itself is kept sealed; only a summary can be read
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input = p.type === 'function_call' ? p.arguments : p.type === 'custom_tool_call' ? p.input : p.action;
      if (typeof input === 'string') { try { const j = JSON.parse(input); if (j && typeof j === 'object') input = j; } catch (_) { /* it is text */ } }
      out.push({ kind: 'tool_use', id: p.call_id || p.id, name: p.name || 'shell', input: trimInput(input === undefined ? '' : input) });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      out.push(Object.assign({ kind: 'tool_result', id: p.call_id || p.id, isError: false }, cut(flat(p.output), MAX_RESULT)));
    }
  }
  return out;
}

/** The rollout file of a thread: Codex ends the file's name with the thread's id. */
function codexRollout(id, home) {
  const end = '-' + id + '.jsonl';
  let files; try { files = newestRollouts(path.join(home, 'sessions'), Infinity); } catch (_) { return null; }
  const hit = files.find((f) => f.file.endsWith(end));
  return hit ? hit.file : null;
}

/**
 * What was said in a past session, newest `limit` entries of it.
 * @returns {Promise<{ events: object[], earlier: number }>}  `earlier` counts the entries before those returned
 */
async function loadTranscript(kind, id, { dir, home = path.join(os.homedir(), '.codex'), sdk, limit = MAX_PAST } = {}) {
  let events = [];
  if (!id) return { events, earlier: 0 };
  if (kind === 'claude') events = claudeEvents(await (sdk || await claudeSdk()).getSessionMessages(id, dir ? { dir } : undefined));
  else if (kind === 'codex') { const file = codexRollout(id, home); if (file) events = codexEvents(fs.readFileSync(file, 'utf8')); }
  const earlier = Math.max(0, events.length - limit);
  return { events: earlier ? events.slice(earlier) : events, earlier };
}

// ---- both
/**
 * Every past session of a directory, from both agents, newest first. An agent whose records cannot be read is left
 * out, and named in `failed`, so one broken store does not hide the other.
 * @returns {Promise<{ sessions: object[], failed: string[] }>}
 */
async function listSessions(opts = {}) {
  const failed = [];
  const [claude, codex] = await Promise.all([
    listClaude(opts).catch(() => { failed.push('claude'); return []; }),
    Promise.resolve().then(() => listCodex(opts)).catch(() => { failed.push('codex'); return []; }),
  ]);
  return { sessions: [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt), failed };
}

/** Name a session in its agent's own records. Throws if the name is empty or the record cannot be written. */
async function renameSession(kind, id, title, opts = {}) {
  const name = cleanTitle(title);
  if (!name) throw new Error('A session name cannot be empty.');
  if (!id) throw new Error('This session has not started yet.');
  if (kind === 'claude') await renameClaude(id, name, opts);
  else if (kind === 'codex') renameCodex(id, name, opts);
  else throw new Error('Unknown agent: ' + kind);
  return name;
}

module.exports = { splitIde, listSessions, renameSession, loadTranscript, claudeEvents, codexEvents, listClaude, listCodex, renameCodex, codexNames, parseRolloutHead, cleanTitle, ago, MAX_TITLE };
