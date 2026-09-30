'use strict';
// Markdown, drawn as DOM nodes. It runs in the page: the function below is written into the page's script as source, so
// it must stand alone (no require, nothing from outside itself) and must not contain the text that closes a script.
//
// Nothing here parses markup. Every piece of the text ends up as a text node or an attribute set through the DOM, so
// what an agent writes can be shown as written and can never become an element of its own choosing.

/**
 * @param {string} text
 * @param {Document} doc
 * @param {(target: string) => void} [onOpen]  called for a link that is not a web address: a file, perhaps with a line
 * @returns {DocumentFragment}
 */
function renderMarkdown(text, doc, onOpen) {
  const el = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*)|\s*)$/;
  const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  const INLINE = /\\([\\`*_{}[\]()#+\-.!|~>])|(`+)(.+?)\2(?!`)|\*\*(?=\S)(.+?\S|\S)\*\*(?!\*)|(?<![A-Za-z0-9_])__(?=\S)(.+?\S|\S)__(?![A-Za-z0-9_]|[.\-\/][A-Za-z0-9])|\*(?=\S)(.+?\S|\S)\*(?!\*)|(?<![A-Za-z0-9_])_(?=\S)(.+?\S|\S)_(?![A-Za-z0-9_]|[.\-\/][A-Za-z0-9])|~~(?=\S)(.+?)~~|\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  const width = (s) => s.replace(/\t/g, '    ').length;
  const cells = (row) => { const out = []; let cur = ''; const s = row.trim().replace(/^\|/, ''); for (let i = 0; i < s.length; i++) { if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += s[i]; } if (cur.trim() || !out.length) out.push(cur.trim()); return out; };
  const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && DIVIDER.test(lines[i + 1]) && cells(lines[i + 1]).length === cells(lines[i]).length;
  const starts = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i);

  function link(parent, label, target, depth) {
    const a = el('a'); a.title = target;
    if (/^(https?:|mailto:)/i.test(target)) a.href = target;
    else { a.href = '#'; a.setAttribute('data-open', target); a.addEventListener('click', (e) => { e.preventDefault(); if (onOpen) onOpen(target); }); }
    if (label === null) a.textContent = target; else inline(a, label, depth + 1);
    parent.append(a);
  }

  function inline(parent, s, depth) {
    depth = depth || 0;
    if (depth > 8) { parent.append(doc.createTextNode(s)); return; }
    const say = (t) => { const parts = t.split('\n'); parts.forEach((p, i) => { if (i) parent.append(el('br')); if (p) parent.append(doc.createTextNode(p)); }); };
    const wrap = (tag, inner) => { const n = el(tag); inline(n, inner, depth + 1); parent.append(n); };
    let at = 0, m;
    const re = new RegExp(INLINE.source, 'g');
    while ((m = re.exec(s))) {
      if (m.index > at) say(s.slice(at, m.index));
      at = m.index + m[0].length;
      if (m[1] !== undefined) say(m[1]);
      else if (m[2] !== undefined) { const c = el('code'); c.textContent = m[3].replace(/^ (.*\S.*) $/, '$1'); parent.append(c); }
      else if (m[4] !== undefined) wrap('strong', m[4]);
      else if (m[5] !== undefined) wrap('strong', m[5]);
      else if (m[6] !== undefined) wrap('em', m[6]);
      else if (m[7] !== undefined) wrap('em', m[7]);
      else if (m[8] !== undefined) wrap('del', m[8]);
      else if (m[9] !== undefined) link(parent, m[9], m[10], depth);
      else if (m[11] !== undefined) link(parent, null, m[11], depth);
    }
    if (at < s.length) say(s.slice(at));
  }

  /** @param {boolean} tight  inside a list item: a lone first paragraph is the item's own text, not a block in it */
  function blocks(lines, parent, tight, depth) {
    depth = depth || 0;
    let i = 0, first = true;
    const take = (node) => { parent.append(node); first = false; };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (depth > 12) { const p = el('p'); p.textContent = lines.slice(i).join('\n'); take(p); break; }
      let m;
      if ((m = FENCE.exec(line))) {
        const mark = m[1][0], len = m[1].length, body = [];
        for (i++; i < lines.length; i++) { const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]); if (c && c[1][0] === mark && c[1].length >= len) { i++; break; } body.push(lines[i]); }
        const pre = el('pre'), code = el('code'); if (m[2]) code.setAttribute('data-lang', m[2]);
        code.textContent = body.join('\n'); pre.append(code); take(pre);
      } else if ((m = HEADING.exec(line))) {
        const h = el('h' + m[1].length); inline(h, m[2]); take(h); i++;
      } else if (RULE.test(line)) { take(el('hr')); i++; }
      else if (QUOTE.test(line)) {
        const inner = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        const q = el('blockquote'); blocks(inner, q, false, depth + 1); take(q);
      } else if (isTable(lines, i)) {
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
        const table = el('table'), head = el('thead'), body = el('tbody');
        const row = (tag, vals) => { const tr = el('tr'); align.forEach((a, k) => { const c = el(tag); if (a) c.style.textAlign = a; inline(c, vals[k] || ''); tr.append(c); }); return tr; };
        head.append(row('th', cells(line)));
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) body.append(row('td', cells(lines[i])));
        table.append(head); if (body.childNodes.length) table.append(body);
        const box = el('div', 'tbl'); box.append(table); take(box);
      } else if ((m = ITEM.exec(line))) {
        const base = width(m[1]), ordered = /\d/.test(m[2]);
        const list = el(ordered ? 'ol' : 'ul'); if (ordered && parseInt(m[2], 10) !== 1) list.setAttribute('start', String(parseInt(m[2], 10)));
        let item = null;
        const close = () => { if (!item) return; const li = el('li'); const t = /^\[([ xX])\]\s+/.exec(item[0]); if (t) { li.className = 'task'; li.append(doc.createTextNode(t[1] === ' ' ? '☐ ' : '☑ ')); item[0] = item[0].slice(t[0].length); } blocks(item, li, true, depth + 1); list.append(li); item = null; };
        for (; i < lines.length; i++) {
          const l = lines[i], it = ITEM.exec(l), ind = width(/^\s*/.exec(l)[0]);
          if (!l.trim()) {
            let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
            if (j >= lines.length) break;
            const nx = ITEM.exec(lines[j]), nind = width(/^\s*/.exec(lines[j])[0]);
            if (!(nind >= base + 2 || (nx && nind >= base && /\d/.test(nx[2]) === ordered))) break;
            if (item) item.push('');
            continue;
          }
          if (it && ind <= base + 1) {
            if (ind < base || /\d/.test(it[2]) !== ordered || RULE.test(l)) break;
            close(); item = [it[3] || ''];
          } else if (ind >= base + 2 && item) item.push(l.replace(/\t/g, '    ').slice(Math.min(ind, base + (ordered ? 3 : 2))));
          else if (item && !starts(lines, i)) item.push(l.trim());              // a line that carries on the paragraph above it
          else break;
        }
        close(); take(list);
      } else {
        const para = [line.trim()];
        for (i++; i < lines.length && lines[i].trim() && !starts(lines, i); i++) para.push(lines[i].trim());
        if (tight && first) { inline(parent, para.join('\n')); first = false; }
        else { const p = el('p'); inline(p, para.join('\n')); take(p); }
      }
    }
  }

  const out = doc.createDocumentFragment();
  blocks(String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n'), out, false, 0);
  return out;
}

module.exports = { renderMarkdown };
