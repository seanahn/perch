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

/**
 * One Claude session's title as Claude Code's record has it now: the user's name for it, else the title Claude Code gives a
 * session itself as the conversation goes on, else the first prompt. Null when there is no record yet.
 * @returns {Promise<{title: string, named: boolean}|null>}
 */
async function titleOfClaude(id, { dir, sdk } = {}) {
  const api = sdk || await claudeSdk();
  if (typeof api.getSessionInfo !== 'function') return null;
  const s = await api.getSessionInfo(id, dir ? { dir } : undefined);
  const title = s ? cleanTitle(s.customTitle || s.summary || s.firstPrompt) : '';
  return title ? { title, named: !!s.customTitle } : null;
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

// ---- what a Codex thread does beyond its own turn: sub-agents, and questions it asks without waiting
// The Codex SDK streams a turn's messages, commands, and edits, but not the sub-agents a turn starts (`spawn_agent` and the
// rest of the `collaboration` tools) nor `request_user_input_async`, a question the agent asks and does not wait for. Both
// are in the thread's rollout file: a sub-agent's life as `SubAgentActivity` items (started, interacted, completed,
// interrupted), its reports as `agent_message` items addressed to `/root` (MESSAGE as it goes, FINAL_ANSWER at the end of
// a task; their text is encrypted, so only the fact of a report can be shown), and the root's calls to it.
const COLLAB_TOOLS = new Set(['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'request_user_input_async']);

/** A sub-agent's name as the transcript shows it: its path under the root (`/root/desk_audio` is `desk_audio`). The root itself is ''. */
function agentName(v) {
  const s = String(v || '').trim();
  if (!s || s === '/root' || s === 'root') return '';
  return s.replace(/^\/?root\//, '');
}

/** Codex's questions ({title, options: [string]}) in the form the question card takes ({question, options: [{label}]}). */
function codexQuestions(list) {
  return (Array.isArray(list) ? list : []).map((q) => {
    const question = q && typeof q === 'object' ? String(q.title || q.question || '').trim() : '';
    if (!question) return null;
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => (typeof o === 'string' ? { label: o } : o && typeof o.label === 'string' ? Object.assign({ label: o.label }, typeof o.description === 'string' && o.description ? { description: o.description } : {}) : null)).filter((o) => o && o.label.trim());
    return { question, options, multiSelect: false };
  }).filter(Boolean);
}

/**
 * One rollout record as an event of the sub-agents or of a question, or null for anything else.
 * {kind: 'subagent', name, state}: state is started, active (the root spoke to it), tasked (a follow-up task), reported (a
 * progress message), answered (its final answer), finished, interrupted, or waiting (the root waits on its sub-agents; name '').
 * {kind: 'question', id, async: true, questions}: asked without waiting; the answer can only be the user's next message.
 */
function collabEvent(o) {
  const p = o && o.payload;
  if (!p || typeof p !== 'object') return null;
  if (o.type === 'event_msg' && p.type === 'item_completed' && p.item && p.item.type === 'SubAgentActivity') {
    const name = agentName(p.item.agent_path), state = { started: 'started', interacted: 'active', completed: 'finished', interrupted: 'interrupted' }[p.item.kind];
    if (!name || !state) return null;
    // each names its own thread, whose file says which model answers it and what it costs (UsageTally). Every kind carries
    // it: a sub-agent started in an earlier turn is first heard of in this one by a follow-up's `interacted`
    const thread = typeof p.item.agent_thread_id === 'string' ? p.item.agent_thread_id.trim() : '';
    return thread ? { kind: 'subagent', name, state, thread } : { kind: 'subagent', name, state };
  }
  if (o.type === 'response_item' && p.type === 'agent_message' && agentName(p.recipient) === '') {
    const name = agentName(p.author);
    if (!name) return null;
    const head = (Array.isArray(p.content) ? p.content : []).map((c) => (c && c.type === 'input_text' && typeof c.text === 'string' ? c.text : '')).join('');
    return { kind: 'subagent', name, state: /Message Type: FINAL_ANSWER/.test(head) ? 'answered' : 'reported' };
  }
  if (o.type === 'response_item' && p.type === 'function_call' && COLLAB_TOOLS.has(p.name)) {
    let a = {}; try { a = JSON.parse(p.arguments || '{}') || {}; } catch (_) { /* not JSON: nothing to read */ }
    if (p.name === 'request_user_input_async') { const questions = codexQuestions(a.questions); return questions.length ? { kind: 'question', id: String(p.call_id || p.id || ''), async: true, questions } : null; }
    if (p.name === 'followup_task') { const name = agentName(a.target); return name ? { kind: 'subagent', name, state: 'tasked' } : null; }
    if (p.name === 'wait_agent') return { kind: 'subagent', name: '', state: 'waiting' };
    return null;                     // spawn_agent is said by its SubAgentActivity; send_message and interrupt_agent by theirs; list_agents says nothing
  }
  return null;
}

// ---- what a sub-agent's own thread file says of it: which model answered its turns, at what effort, and what they cost
/**
 * A tally of one thread's turns and tokens, fed its rollout lines one at a time (src/codexWatch.js feeds a file as it
 * grows; `rolloutUsage` a whole one). Three records are read: `turn_context` (the model and effort of each turn, so a
 * thread moved to another model mid-way shows both), `token_usage_record` (what each turn cost) and `session_meta` (the
 * nickname Codex gives the agent). A line is parsed only if it names one of them; most lines name none.
 *
 * A turn is counted once, by its id: a turn records its context again after a compaction (21 of 205 turns did in one
 * thread). A sub-agent forked from its parent's conversation has the parent's history copied into the top of its file,
 * contexts included (390 copied, 161 of their own, in that thread's 74 sub-agents): its own `session_meta`, the first,
 * names the ordinal its own records begin at (`subagent_history_start_ordinal`), and the copied records before it are
 * the parent's, not counted. Token records are never copied.
 */
class UsageTally {
  /**
   * @param {{since?: number, until?: number}} [window]  epoch ms. Turns and tokens count only for records stamped inside
   *   it (an unstamped record counts). A turn before it still says which model the thread was on, so a sub-agent resumed
   *   from an earlier turn shows its model before it works in this one; a record after it says nothing, so a thread read
   *   back later shows itself as it was then.
   */
  constructor({ since = -Infinity, until = Infinity } = {}) {
    this.since = since; this.until = until;
    this.nickname = ''; this.model = ''; this.effort = ''; this.turns = 0; this.byModel = new Map(); this.input = 0; this.cached = 0; this.output = 0;
    this.counted = new Set();          // the turns counted, by id, and by id under each model
    this.metas = 0; this.ownFrom = null;   // a forked sub-agent's own records begin at this ordinal; before it, its parent's, copied
    this.spentBy = new Map();          // by model: what its turns' requests took, so each model can be priced at its own rates
  }
  /** Whether a record is the parent's history, copied into a forked sub-agent's file. */
  copied(o) { return this.ownFrom !== null && typeof o.ordinal === 'number' && o.ordinal < this.ownFrom; }
  /** @returns {boolean} whether the line changed the tally */
  feed(line) {
    if (!isUsageLine(line)) return false;
    let o; try { o = JSON.parse(line); } catch (_) { return false; }
    return this.feedRecord(o);
  }
  /** One parsed rollout record. @returns {boolean} whether it changed the tally */
  feedRecord(o) {
    const p = o && o.payload;
    if (!p || typeof p !== 'object') return false;
    if (o.type === 'session_meta' && this.metas++ === 0 && typeof p.subagent_history_start_ordinal === 'number') this.ownFrom = p.subagent_history_start_ordinal;
    else if (this.copied(o)) return false;
    const at = Date.parse(o.timestamp);              // NaN when unstamped, which neither comparison holds for
    if (at > this.until) return false;
    const inside = !(at < this.since);
    if (o.type === 'session_meta') {
      const nickname = typeof p.agent_nickname === 'string' ? p.agent_nickname.trim() : '';
      if (!nickname || nickname === this.nickname) return false;
      this.nickname = nickname; return true;
    }
    if (o.type === 'turn_context') {
      const model = typeof p.model === 'string' ? p.model.trim() : '';
      if (!model) return false;
      const effort = typeof p.effort === 'string' ? p.effort.trim() : '';
      const changed = inside || model !== this.model || effort !== this.effort;
      this.model = model; this.effort = effort;
      if (inside) {
        const id = typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : null, under = id && model + '\u0001' + id;   // no id: each counts
        if (!id || !this.counted.has(id)) { this.turns++; if (id) this.counted.add(id); }
        if (!under || !this.counted.has(under)) { this.byModel.set(model, (this.byModel.get(model) || 0) + 1); if (under) this.counted.add(under); }
      }
      return changed;
    }
    if (o.type === 'token_usage_record') {
      const u = p.usage;
      if (!inside || !u || typeof u !== 'object') return false;
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      const input = n(u.input_tokens), cached = n(u.cached_input_tokens), write = n(u.cache_write_input_tokens), output = n(u.output_tokens);
      this.input += input; this.cached += cached; this.output += output;
      // a request belongs to the turn whose context came before it, so to that turn's model
      const s = this.spentBy.get(this.model) || { input: 0, cached: 0, write: 0, output: 0 };
      s.input += input; s.cached += cached; s.write += write; s.output += output;
      this.spentBy.set(this.model, s);
      return true;
    }
    return false;
  }
  /**
   * What the requests took, by model, in the order the models were first used: `input` counts every input token, the
   * cached ones (`cached`, read from the prompt cache) and the ones written to it (`write`) among them, as OpenAI counts.
   * The model is '' for requests before any turn named one.
   * @returns {{model: string, input: number, cached: number, write: number, output: number}[]}
   */
  spent() { return [...this.spentBy.entries()].map(([model, s]) => Object.assign({ model }, s)); }
  /**
   * What the tally says: the model of the latest turn and its effort, the turns, the tokens; `nickname` when the file
   * gave one; `models`, each with its turns in the order first used, only when there was more than one.
   */
  summary() {
    const out = { model: this.model, effort: this.effort, turns: this.turns, tokens: { input: this.input, cached: this.cached, output: this.output } };
    if (this.nickname) out.nickname = this.nickname;
    if (this.byModel.size > 1) out.models = [...this.byModel.entries()].map(([model, turns]) => ({ model, turns }));
    return out;
  }
}

const isUsageLine = (line) => !!line && (line.indexOf('turn_context') >= 0 || line.indexOf('token_usage_record') >= 0 || line.indexOf('session_meta') >= 0);

/** The records of a rollout a tally reads, parsed once. @param {string} text */
function usageRecords(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) { if (!isUsageLine(line)) continue; try { out.push(JSON.parse(line)); } catch (_) { /* half a line */ } }
  return out;
}

/** The tally of a whole rollout file, or of a window of it. @param {string} text */
function rolloutUsage(text, window) { const t = new UsageTally(window); for (const o of usageRecords(text)) t.feedRecord(o); return t.summary(); }

/**
 * Where each sub-agent's end in a root thread's file falls, in the order `codexEvents` gives the end lines: its name, its
 * thread, and the turn it ended in, from that turn's start (`task_started`) to the end itself.
 * @param {string} text  the root's whole rollout file
 */
function subagentEnds(text) {
  const out = [];
  let turnAt = -Infinity;
  for (const line of String(text || '').split('\n')) {
    if (!line || (line.indexOf('task_started') < 0 && line.indexOf('SubAgentActivity') < 0)) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && o.type === 'event_msg' && o.payload && o.payload.type === 'task_started') { const t = Date.parse(o.timestamp); if (!Number.isNaN(t)) turnAt = t; continue; }
    const c = collabEvent(o);
    if (!c || c.kind !== 'subagent' || (c.state !== 'finished' && c.state !== 'interrupted')) continue;
    const at = Date.parse(o.timestamp);
    out.push({ name: c.name, thread: c.thread || '', since: turnAt, until: Number.isNaN(at) ? Infinity : at });
  }
  return out;
}

/**
 * Give each sub-agent's end line in a transcript read back from a file what its own thread's file says of it (`info`: a
 * tally summary), so a past turn's lines show which model answered each sub-agent and what it cost, as a live turn's do.
 * With the root's file (`text`), each end counts the turn it ended in, up to the end, as the live line did; without it,
 * the thread's whole file. The thread is the one the end names, or else the one of the start before it.
 * @param {object[]} events  from `codexEvents`, changed in place
 * @param {string} home  Codex's home, whose sessions hold the sub-agents' files
 */
function addSubagentUsage(events, home, { text = null, read = (f) => fs.readFileSync(f, 'utf8'), find = null } = {}) {
  let index = null;                  // the sessions tree, walked once for all of them
  const locate = find || ((thread) => {
    if (!index) { try { index = newestRollouts(path.join(home, 'sessions'), Infinity); } catch (_) { index = []; } }
    const end = '-' + thread + '.jsonl', hit = index.find((f) => f.file.endsWith(end));
    return hit ? hit.file : null;
  });
  const ends = text === null ? null : subagentEnds(text);
  const threads = new Map(), records = new Map();   // a thread's file, read and parsed once for all its ends
  const recordsOf = (thread) => {
    if (!records.has(thread)) { let rs = null; try { const f = locate(thread); if (f) rs = usageRecords(read(f)); } catch (_) { rs = null; } records.set(thread, rs); }
    return records.get(thread);
  };
  let k = 0;
  for (const e of events) {
    if (!e || e.kind !== 'subagent' || !e.name) continue;
    if (e.state === 'started') { if (e.thread) threads.set(e.name, e.thread); continue; }
    if (e.state !== 'finished' && e.state !== 'interrupted') continue;
    let thread = e.thread || threads.get(e.name), window;
    if (ends) {
      const w = ends[k++];
      if (!w || w.name !== e.name) continue;           // not the same end: nothing, rather than another's figures
      thread = w.thread || thread; window = { since: w.since, until: w.until };
    }
    const rs = thread ? recordsOf(thread) : null;
    if (!rs) continue;
    const t = new UsageTally(window);
    for (const o of rs) t.feedRecord(o);
    const u = t.summary();
    if (u.model) e.info = u;
  }
  return events;
}

/**
 * A Codex session's usage, thread by thread, for the table of it the footer opens: the main thread's, and each sub-agent's
 * it started (and any those started), each from the whole of its own rollout file. Each is a `UsageTally` summary with
 * `spent` (its tokens by model, to be priced at each model's rates); a sub-agent has its name, its thread, when it was
 * first and last heard of and how it last was (started, active, finished, interrupted), and `missing` when its file is
 * not found. Sub-agents come in the order they were first heard of.
 * @param {string} id  the session's thread
 * @returns {Promise<{ main: object, subagents: object[] }|null>}  null when the session's own file is not found
 */
async function sessionUsage(id, { home = path.join(os.homedir(), '.codex'), read = (f) => fs.promises.readFile(f, 'utf8'), find = null } = {}) {
  let index = null;                  // the sessions tree, walked once for all the threads
  const locate = find || ((thread) => {
    if (!index) { try { index = newestRollouts(path.join(home, 'sessions'), Infinity); } catch (_) { index = []; } }
    const end = '-' + thread + '.jsonl', hit = index.find((f) => f.file.endsWith(end));
    return hit ? hit.file : null;
  });
  const subs = new Map();            // by thread
  // one thread's file: its tally, and the sub-agents it speaks of (a fork's copy of its parent's history aside)
  const readThread = async (thread) => {
    const file = locate(thread);
    if (!file) return null;
    let text; try { text = await read(file); } catch (_) { return null; }
    const t = new UsageTally();
    for (const line of String(text).split('\n')) {
      const usage = isUsageLine(line), collab = !usage && line.indexOf('SubAgentActivity') >= 0;
      if (!usage && !collab) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (usage) { t.feedRecord(o); continue; }
      if (t.copied(o)) continue;
      const c = collabEvent(o);
      if (!c || c.kind !== 'subagent' || !c.thread || c.thread === id) continue;
      const at = Date.parse(o.timestamp), s = subs.get(c.thread) || { name: c.name, thread: c.thread, first: at, last: at, state: c.state, read: false };
      if (at >= s.last || Number.isNaN(s.last)) { s.last = at; s.state = c.state; }
      subs.set(c.thread, s);
    }
    return Object.assign(t.summary(), { spent: t.spent() });
  };
  const main = await readThread(id);
  if (!main) return null;
  const out = [];
  for (let more = true; more;) {      // a sub-agent's own file may name sub-agents of its own: read until none is new
    more = false;
    for (const s of [...subs.values()]) {
      if (s.read) continue;
      s.read = true; more = true;
      const u = await readThread(s.thread);
      const when = (v) => (Number.isNaN(v) ? null : v);
      out.push(Object.assign({ name: s.name, thread: s.thread, first: when(s.first), last: when(s.last), state: s.state }, u || { model: '', effort: '', turns: 0, tokens: { input: 0, cached: 0, output: 0 }, spent: [], missing: true }));
    }
  }
  return { main: Object.assign({ thread: id }, main), subagents: out };
}

/** @param {string} text  a whole rollout file */
function codexEvents(text) {
  const out = [];
  const flat = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : v && typeof v === 'object' ? String(v.content || v.output || JSON.stringify(v)) : '');
  const collabCalls = new Set();     // the ids of the collaboration calls: their outputs are not shown either
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    // sub-agents and questions, in the place in the conversation where they happened. A question of the past is shown as
    // asked, not as a card to answer: it was answered, or not, by what the user wrote next.
    const c = collabEvent(o);
    if (c && c.kind === 'question') { out.push({ kind: 'answered', questions: c.questions, answers: null }); }
    else if (c && c.kind === 'subagent' && !['active', 'waiting', 'answered', 'usage'].includes(c.state)) out.push(c);
    const p = o && o.type === 'response_item' && o.payload;
    if (!p) continue;
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && COLLAB_TOOLS.has(p.name)) { collabCalls.add(p.call_id || p.id); continue; }
    if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && collabCalls.has(p.call_id || p.id)) continue;
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
  else if (kind === 'codex') { const file = codexRollout(id, home); if (file) { const text = fs.readFileSync(file, 'utf8'); events = addSubagentUsage(codexEvents(text), home, { text }); } }
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

/**
 * Delete a session from its agent's own records, by the agent's own means: the Agent SDK's deleteSession for Claude, and
 * `codex delete --force <id>` for Codex, which removes the rollout and its name. `codex` is the Codex program to run.
 * Throws if the record cannot be removed.
 */
async function deleteSession(kind, id, { dir, sdk, codex, run } = {}) {
  if (!id) throw new Error('This session has not started yet.');
  if (kind === 'claude') {
    const api = sdk || await claudeSdk();
    if (typeof api.deleteSession !== 'function') throw new Error('This version of the Claude Agent SDK cannot delete a session.');
    await api.deleteSession(id, dir ? { dir } : undefined);
  } else if (kind === 'codex') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Not a Codex session id: ' + id);   // --force takes a UUID only, and nothing else is passed to the program
    const exec = run || ((cmd, args) => new Promise((resolve, reject) => require('child_process').execFile(cmd, args, { timeout: 30000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split('\n').pop())) : resolve(out)))));
    await exec(codex || 'codex', ['delete', '--force', id]);
  } else throw new Error('Unknown agent: ' + kind);
}

/** A session's title in its agent's record. Codex gives a session no title of its own, so only Claude's is looked up. */
async function titleOf(kind, id, o) { return kind === 'claude' ? titleOfClaude(id, o) : null; }

module.exports = { collabEvent, codexQuestions, agentName, codexRollout, UsageTally, rolloutUsage, subagentEnds, addSubagentUsage, sessionUsage, deleteSession, titleOf, titleOfClaude, splitIde, listSessions, renameSession, loadTranscript, claudeEvents, codexEvents, listClaude, listCodex, renameCodex, codexNames, parseRolloutHead, cleanTitle, ago, MAX_TITLE };
