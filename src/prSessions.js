'use strict';
// Which Claude Code session made a GitHub pull request, read from Claude Code's own records (~/.claude/projects/*/*.jsonl),
// for perch.notePrMerged: kestrel says a PR was merged, and the session that made it is told.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)$/;
const MAX_AGE_DAYS = 30;
const CREATE = 'gh pr create';

/**
 * A pull request's URL, taken apart; only `https://github.com/{owner}/{repo}/pull/{n}`, nothing before or after it.
 * @returns {{ url: string, owner: string, repo: string, n: number, ref: string } | null}
 */
function parsePrUrl(url) {
  const m = typeof url === 'string' ? PR_URL.exec(url) : null;
  return m ? { url, owner: m[1], repo: m[2], n: Number(m[3]), ref: `${m[1]}/${m[2]}#${m[3]}` } : null;
}

/** Whether `text` holds `url` itself, not a longer PR number that starts with it (…/pull/12 in …/pull/123). */
function mentions(text, url) {
  for (let i = text.indexOf(url); i >= 0; i = text.indexOf(url, i + 1)) if (!/[0-9]/.test(text.charAt(i + url.length))) return true;
  return false;
}

/** A tool result's words: Claude Code keeps them as a string, or as blocks of text. */
function resultText(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : ''; }

/**
 * One session's record, read a line at a time (a record can run to hundreds of MB): where the URL is first mentioned, and
 * where it first comes back from a Bash call that ran `gh pr create`.
 * @returns {Promise<{ first: number|null, created: number|null, cwd: string }>}  times in ms since the epoch; null when not seen
 */
async function scanFile(file, url) {
  const bash = new Set();            // the ids of Bash calls whose command makes a PR
  let first = null, created = null, cwd = '', anyCwd = '';
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const hit = mentions(line, url), call = line.includes(CREATE);
      if (!hit && !call && anyCwd) continue;   // most lines: neither, and a cwd is in hand already
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || typeof e !== 'object') continue;
      if (!anyCwd && typeof e.cwd === 'string') anyCwd = e.cwd;
      const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
      if (call) for (const b of content) if (b && b.type === 'tool_use' && b.name === 'Bash' && b.input && typeof b.input.command === 'string' && b.input.command.includes(CREATE)) bash.add(b.id);
      if (!hit) continue;
      const at = Date.parse(e.timestamp);
      if (!Number.isFinite(at)) continue;
      if (first === null || at < first) { first = at; if (typeof e.cwd === 'string') cwd = e.cwd; }
      if (created === null) {
        const results = content.filter((b) => b && b.type === 'tool_result');
        const made = results.some((b) => bash.has(b.tool_use_id) && (mentions(resultText(b.content), url)
          || (results.length === 1 && e.toolUseResult && mentions(JSON.stringify(e.toolUseResult), url))));
        if (made) { created = at; if (typeof e.cwd === 'string') cwd = e.cwd; }
      }
    }
  } finally { rl.close(); }
  return { first, created, cwd: cwd || anyCwd };
}

/**
 * The Claude Code session that made the PR at `url`: the one in which the URL came back from a Bash call running
 * `gh pr create`, else the one that mentioned it first. Records last written more than 30 days ago are passed over.
 * Among equals, the record written most recently.
 * @param {string} url  a PR URL, as parsePrUrl takes it
 * @param {{ root: string, now?: number, maxAgeDays?: number }} o  `root`: Claude Code's projects folder
 * @returns {Promise<{ id: string, cwd: string, file: string, created: boolean } | null>}
 */
async function findPrSession(url, { root, now = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  if (!parsePrUrl(url) || !root) return null;
  const files = [];
  let projects = []; try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return null; }
  for (const d of projects) {
    let names = []; try { names = fs.readdirSync(path.join(root, d.name)); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, n);
      let st; try { st = fs.statSync(file); } catch (_) { continue; }
      if (st.isFile() && now - st.mtimeMs <= maxAgeDays * 86400000) files.push({ file, mtime: st.mtimeMs });
    }
  }
  let best = null;
  for (const f of files) {
    let r; try { r = await scanFile(f.file, url); } catch (_) { continue; }   // unreadable: as if it said nothing
    if (r.first === null) continue;
    const c = { id: path.basename(f.file, '.jsonl'), cwd: r.cwd, file: f.file, created: r.created !== null, at: r.created !== null ? r.created : r.first, mtime: f.mtime };
    if (!best || (c.created && !best.created) || (c.created === best.created && (c.at < best.at || (c.at === best.at && c.mtime > best.mtime)))) best = c;
  }
  return best ? { id: best.id, cwd: best.cwd, file: best.file, created: best.created } : null;
}

module.exports = { parsePrUrl, findPrSession, scanFile, mentions, MAX_AGE_DAYS };
