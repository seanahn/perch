'use strict';
// What a running Codex turn does that its SDK does not stream: the sub-agents it starts and hears from, and the questions it
// asks without waiting (src/sessionStore.js, collabEvent). Codex writes them to the thread's rollout file as it goes; this
// reads the lines the file gains while a turn runs, from where the file ended when the watch began. Each sub-agent has a
// thread file of its own, named by any of its activity records (its start, or a follow-up's `interacted` for one started in
// an earlier turn): that one is read the same way, for which model answers it, at what effort, and what its turns cost in
// this turn (sessionStore.UsageTally, from the watch's start), said as the sub-agent's `usage`. No VS Code dependency.

const fs = require('fs');
const { codexRollout, collabEvent, UsageTally } = require('./sessionStore');

const POLL_MS = 1000;
const FIND_MS = 3000;                // a new thread's file appears once its first turn has begun: looked for again at this pace

/** One file read as it grows: the lines it gains since the last read, a line still being written held for the next. */
class Tail {
  constructor(fsImpl, file, offset) { this.fs = fsImpl; this.file = file; this.offset = offset; this.carry = ''; }
  /** @returns {string[]} whole lines gained; [] when nothing was, or the file cannot be read */
  read() {
    let size;
    try { size = this.fs.statSync(this.file).size; } catch (_) { return []; }
    if (size < this.offset) { this.offset = 0; this.carry = ''; }   // rewritten from the start: read it again
    if (size === this.offset) return [];
    let text = '';
    let fd = null;
    try {
      fd = this.fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      const got = this.fs.readSync(fd, buf, 0, buf.length, this.offset);
      text = buf.toString('utf8', 0, got);
      this.offset += got;
    } catch (_) { return []; } finally { if (fd !== null) { try { this.fs.closeSync(fd); } catch (_) { /* closed */ } } }
    const lines = (this.carry + text).split('\n');
    this.carry = lines.pop();        // the last piece may be a line still being written
    return lines.filter(Boolean);
  }
}

class RolloutWatch {
  /**
   * @param {object} o
   * @param {string} o.id        the thread
   * @param {string} o.home      Codex's home (~/.codex, or CODEX_HOME)
   * @param {(ev: object) => void} o.emit
   * @param {(id: string, home: string) => string|null} [o.find]  where a thread's file is (sessionStore.codexRollout); a sub-agent's too
   */
  constructor({ id, home, emit, find = codexRollout, pollMs = POLL_MS, fsImpl = fs }) {
    this.id = id; this.home = home; this.emit = emit; this.find = find; this.pollMs = pollMs; this.fs = fsImpl;
    this.file = null; this.offset = null; this.carry = ''; this.timer = null; this.lastFind = 0;
    this.tail = null;
    this.children = new Map();       // by thread id: { name, tail: Tail|null, lastFind, tally: UsageTally }
    this.since = Date.now();         // a sub-agent's turns before this are earlier turns': their model is said, not their cost
  }

  /** Begin. A file that exists now is read from its end: what it holds already is earlier turns'. One found later is read whole. */
  start() {
    this.since = Date.now();
    this.locate(true);
    if (this.file) { try { this.offset = this.fs.statSync(this.file).size; } catch (_) { this.file = null; } }
    if (this.file) this.tail = new Tail(this.fs, this.file, this.offset);
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  locate(now) {
    if (this.file || (!now && Date.now() - this.lastFind < FIND_MS)) return;
    this.lastFind = Date.now();
    try { this.file = this.find(this.id, this.home) || null; } catch (_) { this.file = null; }
    if (this.file && this.offset === null && !now) { this.offset = 0; this.tail = new Tail(this.fs, this.file, 0); }
  }

  /** A sub-agent's file, looked for at the same pace as the root's; its whole life is this turn's, so it is read from its start. */
  locateChild(c) {
    if (c.tail || Date.now() - c.lastFind < FIND_MS) return;
    c.lastFind = Date.now();
    let file = null;
    try { file = this.find(c.thread, this.home) || null; } catch (_) { file = null; }
    if (file) c.tail = new Tail(this.fs, file, 0);
  }

  /** Read what the files have gained, and say each sub-agent event and question in the root's, and each sub-agent's usage in its own. */
  poll() {
    this.locate(false);
    // the sub-agents first: a sub-agent's last turn is recorded in its file before the root records its end, so the end
    // line finds its usage already known
    for (const c of this.children.values()) this.pollChild(c);
    if (!this.file || this.offset === null || !this.tail) return;
    for (const line of this.tail.read()) {
      this.offset = this.tail.offset;
      if (line.indexOf('SubAgentActivity') < 0 && line.indexOf('agent_message') < 0 && line.indexOf('"function_call"') < 0) continue;   // most lines are none of these: not parsed
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const ev = collabEvent(o);
      if (!ev) continue;
      if (ev.kind === 'subagent' && ev.thread && !this.children.has(ev.thread)) {
        const c = { thread: ev.thread, name: ev.name, tail: null, lastFind: 0, tally: new UsageTally({ since: this.since }) };
        this.children.set(ev.thread, c);
        this.say(ev);
        this.pollChild(c);           // its file is usually there already: say what it holds, after the start
        continue;
      }
      this.say(ev);
    }
    this.offset = this.tail.offset;
  }

  pollChild(c) {
    this.locateChild(c);
    if (!c.tail) return;
    let changed = false;
    for (const line of c.tail.read()) if (c.tally.feed(line)) changed = true;
    if (changed) this.say(Object.assign({ kind: 'subagent', name: c.name, state: 'usage' }, c.tally.summary()));
  }

  say(ev) { try { this.emit(ev); } catch (_) { /* a listener must not stop the watch */ } }

  /** Stop, after a last read: the turn's final lines are written before its process ends. */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.poll();
  }
}

module.exports = { RolloutWatch, Tail, POLL_MS };
