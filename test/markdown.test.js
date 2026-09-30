'use strict';
// Markdown drawn as DOM nodes: what each construct becomes, and that nothing an agent writes becomes markup.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { renderMarkdown } = require('../src/markdown');

const w = new JSDOM('<body></body>').window, d = w.document;
const opened = [];
const draw = (t) => { const b = d.createElement('div'); b.append(renderMarkdown(t, d, (x) => opened.push(x))); return b; };
const html = (t) => draw(t).innerHTML;

// ---- inline
assert.strictEqual(html('plain words'), '<p>plain words</p>');
assert.strictEqual(html('a **bold** and *slanted* and __also__ _this_ and ~~gone~~'), '<p>a <strong>bold</strong> and <em>slanted</em> and <strong>also</strong> <em>this</em> and <del>gone</del></p>');
assert.strictEqual(html('**bold with `code` and *more***'), '<p><strong>bold with <code>code</code> and <em>more</em></strong></p>');
assert.strictEqual(html('snake_case_name, 2 * 3 * 4, a*b, __init__.py, _x_y'), '<p>snake_case_name, 2 * 3 * 4, a*b, __init__.py, _x_y</p>', 'marks inside words and sums are not emphasis');
assert.strictEqual(html('`**not bold**` and ``a ` b`` and ` x `'), '<p><code>**not bold**</code> and <code>a ` b</code> and <code>x</code></p>');
assert.strictEqual(html('\\*not slanted\\* and \\`not code\\` and a\\\\b'), '<p>*not slanted* and `not code` and a\\b</p>');
assert.strictEqual(html('one\ntwo'), '<p>one<br>two</p>', 'a line break is kept');

// ---- links: a web address is a link; anything else is handed to the host, as a file to open
assert.strictEqual(html('see [the docs](https://x.dev/a_(b)) and https://y.dev/p?q=1, ok.'), '<p>see <a title="https://x.dev/a_(b)" href="https://x.dev/a_(b)">the docs</a> and <a title="https://y.dev/p?q=1" href="https://y.dev/p?q=1">https://y.dev/p?q=1</a>, ok.</p>');
let n = draw('[extension.js:42](src/extension.js#L42) and [**x**](javascript:alert(1))');
const links = [...n.querySelectorAll('a')];
assert.deepStrictEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('data-open')]), [['extension.js:42', '#', 'src/extension.js#L42'], ['x', '#', 'javascript:alert(1)']], 'no address but a web address is ever an address');
for (const a of links) assert.strictEqual(a.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })), false);
assert.deepStrictEqual(opened.splice(0), ['src/extension.js#L42', 'javascript:alert(1)']);

// ---- blocks
assert.strictEqual(html('# One\n## Two ##\n###### Six\n####### seven\n#no'), '<h1>One</h1><h2>Two</h2><h6>Six</h6><p>####### seven<br>#no</p>');
assert.strictEqual(html('above\n\n---\n***\nbelow'), '<p>above</p><hr><hr><p>below</p>');
assert.strictEqual(html('```js\nconst a = "<b>";\n**x**\n```\nafter'), '<pre><code data-lang="js">const a = "&lt;b&gt;";\n**x**</code></pre><p>after</p>');
assert.strictEqual(html('~~~\n```\ninner\n```\n~~~'), '<pre><code>```\ninner\n```</code></pre>', 'a fence closes on its own kind');
assert.strictEqual(html('text\n```\nstill streaming'), '<p>text</p><pre><code>still streaming</code></pre>', 'a fence not yet closed, as while an answer arrives');
assert.strictEqual(html('> quoted *text*\n> - item\n\nout'), '<blockquote><p>quoted <em>text</em></p><ul><li>item</li></ul></blockquote><p>out</p>');

// ---- lists
assert.strictEqual(html('- a\n- b\n* c'), '<ul><li>a</li><li>b</li><li>c</li></ul>');
assert.strictEqual(html('3. three\n4. four\n\n- then'), '<ol start="3"><li>three</li><li>four</li></ol><ul><li>then</li></ul>');
assert.strictEqual(html('- **On resume**, first\n  carries on\n  - nested\n    1. deep\n- last'), '<ul><li><strong>On resume</strong>, first<br>carries on<ul><li>nested<ol><li>deep</li></ol></li></ul></li><li>last</li></ul>');
assert.strictEqual(html('1. one\n\n   more of one\n\n2. two\n\nafter'), '<ol><li>one<p>more of one</p></li><li>two</li></ol><p>after</p>');
assert.strictEqual(html('- [ ] to do\n- [x] done'), '<ul><li class="task">☐ to do</li><li class="task">☑ done</li></ul>');
assert.strictEqual(html('- a\n```\ncode\n```'), '<ul><li>a</li></ul><pre><code>code</code></pre>');
assert.strictEqual(html('para\n- item'), '<p>para</p><ul><li>item</li></ul>', 'a list needs no blank line before it');

// ---- tables
assert.strictEqual(html('| Agent | Where |\n|---|:-:|\n| Claude | `~/.claude` |\n| a \\| b | c | extra |\n\nafter'),
  '<div class="tbl"><table><thead><tr><th>Agent</th><th style="text-align: center;">Where</th></tr></thead><tbody><tr><td>Claude</td><td style="text-align: center;"><code>~/.claude</code></td></tr><tr><td>a | b</td><td style="text-align: center;">c</td></tr></tbody></table></div><p>after</p>');
assert.strictEqual(html('a | b\nnot a table'), '<p>a | b<br>not a table</p>');

// ---- nothing written becomes markup, and nothing runs away
const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
n = draw(`${evil}\n\n# ${evil}\n\n- ${evil}\n\n| ${evil} |\n|---|\n| ${evil} |\n\n\`${evil}\`\n\n\`\`\`${evil}\n${evil}\n\`\`\`\n\n[${evil}](${evil})\n\n> ${evil}`);
assert.deepStrictEqual([n.querySelectorAll('img, script').length, w.pwned], [0, undefined]);
assert(n.textContent.includes(evil), 'it is shown as the text it is');
assert.deepStrictEqual([html(''), html(null), html(undefined), html('\n\n')], ['', '', '', '']);
assert.strictEqual(html('a\r\n\r\nb'), '<p>a</p><p>b</p>');
const t0 = Date.now();
draw('*'.repeat(20000) + '_'.repeat(20000) + '['.repeat(5000) + '`'.repeat(5001)); draw('> '.repeat(400) + 'deep'); draw(Array.from({ length: 300 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n')); draw('**a '.repeat(5000));
assert(Date.now() - t0 < 3000, 'text made to be slow to read is not: ' + (Date.now() - t0) + 'ms');

// the function is written into the page as source: it must stand alone, and must not end the script it is written into
const src = renderMarkdown.toString();
assert(!/<\/script|<!--/i.test(src) && !/\brequire\(/.test(src));
assert.strictEqual(new Function('return ' + src)()('**ok**', d).firstChild.innerHTML, '<strong>ok</strong>');

console.log('MARKDOWN OK');
