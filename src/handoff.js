// handoff.js: turns one agent's conversation into text the other vendor's agent can pick up from.
'use strict';
// The discussion of a tab, as text another vendor's agent can read: note 202. No VS Code dependency.
//
// A vendor's conversation cannot be resumed by the other vendor (its records, and its reasoning, are the vendor's own),
// so a switch hands the new agent what was said: every message of the user's and every reply of the agent's, in full;
// each tool call as one line, without its output; no thinking. It is built from the events a past transcript is read
// into (sessionStore.loadTranscript), with no model call. Above a budget the most recent turns go inline and the whole
// discussion goes to a file, which the text names.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUDGET = 40000;             // tokens inline
const CHARS_PER_TOKEN = 4;        // an estimate, as the meters make it for text with no tokenizer to hand
const MAX_LINE = 140;             // a tool call's line
const DIR = path.join(os.homedir(), '.cache', 'perch', 'handoff');

const SUMMARY = /^This session is being continued from a previous conversation/;   // Claude Code's compaction, in the user's name
const PREFIX = 'Earlier in this tab the user worked with ';
const END = '--- end of the earlier conversation';

/** A user message that is a handoff: the text Perch put ahead of the user's own words, at a switch. */
const isHandoff = (text) => String(text || '').startsWith(PREFIX) && String(text).includes(END);
/** The user's own words in a message that may begin with a handoff. */
function ownWords(text) {
  const t = String(text || '');
  if (!isHandoff(t)) return t;
  return t.slice(t.lastIndexOf(END) + END.length).trim();
}

/**
 * A vendor's record of a tab, cut where the tab came back to it: each switch's first message begins with a handoff, so a
 * record that has been switched to twice holds two stretches of the tab. The handoff is taken out of the message, which
 * keeps the user's own words, or goes if there are none.
 * @returns {object[][]}  the stretches, oldest first; one for a record never switched to
 */
function stretches(events) {
  const out = [[]];
  for (const e of events || []) {
    if (e && e.kind === 'user' && isHandoff(e.text)) {
      if (out[out.length - 1].length) out.push([]);
      const words = ownWords(e.text);
      if (words || e.images) out[out.length - 1].push(Object.assign({}, e, { text: words }));
      continue;
    }
    out[out.length - 1].push(e);
  }
  return out;
}

const tokens = (s) => Math.ceil(String(s || '').length / CHARS_PER_TOKEN);
const oneLine = (s, n = MAX_LINE) => { const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** A path as the agent would type it: relative to the workspace when inside it. */
function rel(p, cwd) {
  const s = String(p || '');
  if (!cwd || !path.isAbsolute(s)) return s;
  const r = path.relative(cwd, s);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : s;
}

/** The files a patch touches, in Codex's `apply_patch` form (`*** Update File: path`). */
function patchFiles(text) {
  const out = []; const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm; let m;
  while ((m = re.exec(String(text || '')))) out.push(m[2].trim());
  return out;
}

/** One tool call as one line: its name and the argument that says what it did. */
function toolLine(name, input, cwd) {
  let o = input;
  if (typeof o === 'string') {
    try { const j = JSON.parse(o); if (j && typeof j === 'object') o = j; } catch (_) {
      // a long input comes cut short, as JSON that no longer parses: its leading fields are still there
      if (/^\s*\{/.test(o)) { const f = {}; const re = /"(file_path|notebook_path|path|command|cmd|pattern|description|url|query|skill)":\s*"((?:[^"\\]|\\.)*)"/g; let m; while ((m = re.exec(o))) if (!(m[1] in f)) { try { f[m[1]] = JSON.parse('"' + m[2] + '"'); } catch (_) { f[m[1]] = m[2]; } } if (Object.keys(f).length) o = f; }
    }
  }
  let n = String(name || 'tool');
  // Codex's code mode: a script that calls its tools, `text(await tools.exec_command({cmd:"…", …}))`; the call it makes is the line
  if (typeof o === 'string') {
    const call = /\btools\.([A-Za-z_]\w*)\(\s*\{([\s\S]*)/.exec(o);
    if (call) {
      const f = {}; const re = /"?(cmd|command|path|file_path|query|pattern)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g; let m;
      while ((m = re.exec(call[2]))) if (!(m[1] in f)) { try { f[m[1]] = JSON.parse('"' + m[2] + '"'); } catch (_) { f[m[1]] = m[2]; } }
      const more = (o.match(/\btools\.[A-Za-z_]\w*\(/g) || []).length - 1;
      return toolLine(call[1], Object.keys(f).length ? f : {}, cwd) + (more > 0 ? ` (and ${more} more call${more > 1 ? 's' : ''})` : '');
    }
  }
  if (typeof o === 'string') return n === 'apply_patch' || /^\*\*\* Begin Patch/.test(o) ? 'apply_patch ' + patchFiles(o).map((f) => rel(f, cwd)).join(', ') : oneLine(n + ' ' + o);
  if (!o || typeof o !== 'object') return n;
  const file = o.file_path || o.notebook_path || o.path;
  const cmd = Array.isArray(o.command) ? (o.command[0] === 'bash' && o.command[1] === '-lc' ? o.command.slice(2).join(' ') : o.command.join(' ')) : (o.command || o.cmd);
  switch (n) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return n + ' ' + rel(file, cwd);
    case 'Bash': return oneLine('Bash: ' + cmd);
    case 'Grep': return oneLine('Grep ' + JSON.stringify(o.pattern || '') + (o.path ? ' in ' + rel(o.path, cwd) : ''));
    case 'Glob': return oneLine('Glob ' + (o.pattern || ''));
    case 'Agent': case 'Task': return oneLine(n + ': ' + (o.description || o.prompt || ''));
    case 'WebFetch': return oneLine('WebFetch ' + (o.url || ''));
    case 'WebSearch': return oneLine('WebSearch ' + JSON.stringify(o.query || ''));
    case 'Skill': return oneLine('Skill ' + (o.skill || ''));
    case 'TodoWrite': case 'update_plan': return n;
    default: break;
  }
  if (cmd) return oneLine((n === 'shell' || n === 'exec_command' || n === 'local_shell' ? 'shell' : n) + ': ' + cmd);
  if (o.patch || o.input) { const files = patchFiles(o.patch || o.input); if (files.length) return 'apply_patch ' + files.map((f) => rel(f, cwd)).join(', '); }
  const label = n.startsWith('mcp__') ? n.slice(5).replace('__', '.') : n;
  if (file) return oneLine(label + ' ' + rel(file, cwd));
  const first = Object.values(o).find((v) => typeof v === 'string' && v.trim());
  return oneLine(first ? label + ' ' + first : label);
}

/**
 * The turns of a transcript: each a user message and what the agent said and did after it. Thinking, tool output, notes
 * and sub-agents' activity are left out; a failed tool call is marked.
 * @param {object[]} events  as sessionStore.loadTranscript returns them
 * @returns {{ user: string|null, images: number, items: ({text: string}|{tool: string})[] }[]}
 */
function turnsOf(events, { cwd } = {}) {
  const turns = []; let cur = null; const calls = new Map();
  const open = (user, images, summary) => { cur = { user, images: images || 0, items: [], summary: !!summary }; turns.push(cur); };
  for (const e of events || []) {
    if (!e) continue;
    if (e.kind === 'user') {
      const t = ownWords(e.text);                               // a handoff the record holds is not said again
      if (!t && !e.images && isHandoff(e.text)) { open(null, 0); continue; }
      open(t, e.images, SUMMARY.test(t)); continue;
    }
    if (!cur) open(null, 0);                                    // the agent spoke first: a resumed or forked record
    if (e.kind === 'text' && String(e.text || '').trim()) cur.items.push({ text: String(e.text).trim() });
    else if (e.kind === 'tool_use') { const it = { tool: toolLine(e.name, e.input, cwd) }; cur.items.push(it); if (e.id) calls.set(e.id, it); }
    else if (e.kind === 'tool_result' && e.isError && calls.has(e.id)) calls.get(e.id).failed = true;
    else if (e.kind === 'answered' && Array.isArray(e.questions)) for (const q of e.questions) if (q && q.question) cur.items.push({ tool: oneLine('asked: ' + q.question) });
  }
  return turns;
}

/** A turn as text; consecutive identical tool lines are folded into one with a count. */
function renderTurn(t, agent) {
  const out = [];
  if (t.summary) out.push(`--- ${agent}'s own summary of the conversation before this point, written when it compacted it`, t.user);
  else if (t.user !== null) out.push('--- user' + (t.images ? ` (${t.images} image${t.images > 1 ? 's' : ''}, not included)` : ''), t.user || '');
  let header = false;
  for (let i = 0; i < t.items.length; i++) {
    const it = t.items[i];
    if (!header) { out.push('--- ' + agent); header = true; }
    if (it.text) { out.push(it.text); continue; }
    let k = 1; while (i + k < t.items.length && t.items[i + k].tool === it.tool && !t.items[i + k].failed === !it.failed) k++;
    out.push('    · ' + it.tool + (it.failed ? ' → failed' : '') + (k > 1 ? ` (×${k})` : ''));
    i += k - 1;
  }
  return out.join('\n');
}

const preamble = ({ agent, model, cwd }) => `${PREFIX}${agent}${model ? ` (${model})` : ''}${cwd ? ` in ${cwd}` : ''}. Its conversation follows: the user's messages and ${agent}'s replies in full; its tool calls as one line each, without their output. Read the files themselves for their current state. Continue from the end; the user's new message follows it.`;

/**
 * The handoff text of a transcript.
 * @param {object[]} events  as sessionStore.loadTranscript returns them, all of them (`limit: Infinity`)
 * @param {object} [o]
 * @param {string} [o.agent]  the vendor's agent as the text names it: 'Claude' or 'Codex'
 * @param {string} [o.model]  the model it ran on, as the user knows it
 * @param {string} [o.cwd]  the workspace: paths inside it are shown relative to it
 * @param {number} [o.budget]  tokens inline
 * @param {string} [o.file]  where the whole discussion is written when it does not fit; named in the text
 * @returns {{ text: string, full: string, turns: number, inlineTurns: number, messages: number, inlineMessages: number, tokens: number, fullTokens: number, fits: boolean }}
 */
function handoffText(events, { agent = 'Claude', model = '', cwd = '', budget = BUDGET, file = '' } = {}) {
  const turns = turnsOf(events, { cwd }).filter((t) => t.user !== null || t.items.length);
  const parts = turns.map((t) => renderTurn(t, agent));
  const msgs = (t) => (t.user !== null && !t.summary ? 1 : 0) + t.items.filter((i) => i.text).length;
  const head = preamble({ agent, model, cwd });
  const full = [head, '', ...parts.flatMap((p) => [p, '']), END].join('\n');
  const all = turns.reduce((n, t) => n + msgs(t), 0);
  if (tokens(full) <= budget) return { text: full, full, turns: turns.length, inlineTurns: turns.length, messages: all, inlineMessages: all, tokens: tokens(full), fullTokens: tokens(full), fits: true };
  // the most recent turns that fit, the last one always; and the latest summary of what came before them, if the agent
  // compacted the conversation, so the left-out part is not left out entirely
  const last = turns.map((t) => t.summary).lastIndexOf(true);
  let used = tokens(head) + tokens(END) + 200, from = parts.length;
  const fit = (extra) => { while (from > 0 && (from === parts.length || used + extra + tokens(parts[from - 1]) + 1 <= budget)) { used += tokens(parts[from - 1]) + 1; from--; } };
  fit(0);
  let summary = -1;
  if (last >= 0 && last < from) {                                  // the summary did not make it: make room for it
    const need = tokens(parts[last]) + 1;
    used = tokens(head) + tokens(END) + 200; from = parts.length; fit(need);
    if (used + need <= budget) summary = last;
  }
  const earlierMsgs = turns.slice(0, from).reduce((n, t) => n + msgs(t), 0);
  const where = file ? ` The whole conversation, all ${all} messages, is in ${file}; read it if you need the earlier part.` : '';
  const note = `[${earlierMsgs} earlier message${earlierMsgs === 1 ? '' : 's'} (${from} turn${from === 1 ? '' : 's'}) are left out here${summary >= 0 ? `; ${agent}'s latest summary of them follows` : ''}.${where}]`;
  const text = [head, '', note, '', ...(summary >= 0 ? [parts[summary], ''] : []), ...parts.slice(from).flatMap((p) => [p, '']), END].join('\n');
  return { text, full, turns: turns.length, inlineTurns: turns.length - from, messages: all, inlineMessages: all - earlierMsgs, tokens: tokens(text), fullTokens: tokens(full), fits: false };
}

/**
 * A Claude session's main thread across all its compactions, as the Agent SDK's messages. The SDK's reader starts at the
 * latest compaction (seen 2026-10-27: 102 of a session's 448 messages); the file keeps everything, and the thread is
 * followed back from its last message, `parentUuid` by `parentUuid`, through each compaction's `logicalParentUuid`, so
 * branches left by a rewind are not part of it. Null when there is no file.
 */
async function claudeThread(id, { claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) return null;
  const root = path.join(claudeDir, 'projects');
  let projects; try { projects = await fs.promises.readdir(root); } catch (_) { return null; }
  let text = null;
  for (const p of projects) { try { text = await fs.promises.readFile(path.join(root, p, id + '.jsonl'), 'utf8'); break; } catch (_) { /* not this project */ } }
  if (text === null) return null;
  const by = new Map(); let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o.uuid !== 'string') continue;
    by.set(o.uuid, o);
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) last = o.uuid;
  }
  const chain = []; const seen = new Set();
  for (let u = last; u && !seen.has(u);) {
    seen.add(u); const o = by.get(u); if (!o) break;
    chain.push(o);
    u = o.parentUuid || o.logicalParentUuid || null;
  }
  chain.reverse();
  return chain.filter((o) => (o.type === 'user' || o.type === 'assistant') && !o.isSidechain && !o.isMeta && o.message)
    .map((o) => ({ type: o.type, uuid: o.uuid, parent_tool_use_id: null, message: o.message }));
}

/**
 * All of a session's discussion, as events: a Claude session across its compactions, a Codex thread from its rollout.
 * @param {'claude'|'codex'} kind
 */
async function loadDiscussion(kind, id, { claudeDir, home, dir, sdk } = {}) {
  const S = require('./sessionStore');
  if (kind === 'claude') {
    const thread = await claudeThread(id, claudeDir ? { claudeDir } : undefined);
    if (thread && thread.length) return S.claudeEvents(thread);
  }
  return (await S.loadTranscript(kind, id, Object.assign({ limit: Infinity }, home ? { home } : {}, dir ? { dir } : {}, sdk ? { sdk } : {}))).events;
}

/** Where a tab's n-th handoff is written: the user's alone. */
function handoffFile(sessionId, n, dir = DIR) { return path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}-${n}.md`); }

/** Write the whole discussion, in a directory only the user can read. */
function writeHandoff(file, full) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch (_) { /* not ours to change */ }
  fs.writeFileSync(file, full, { mode: 0o600 });
  return file;
}

/** Remove a tab's handoff files, when the tab goes. */
function removeHandoffs(sessionId, dir = DIR) {
  const pre = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '-';
  let names; try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  let n = 0; for (const f of names) if (f.startsWith(pre) && f.endsWith('.md')) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* gone */ } }
  return n;
}

module.exports = { handoffText, loadDiscussion, claudeThread, stretches, isHandoff, ownWords, turnsOf, toolLine, patchFiles, handoffFile, writeHandoff, removeHandoffs, tokens, BUDGET, DIR };
