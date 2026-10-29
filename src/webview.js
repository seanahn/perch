'use strict';
// The Perch page: a tab bar, one pane per session, a composer modelled on Claude Code's, and the Claude usage footer.
// The host owns all state; this page renders what it is sent and can be rebuilt from a replay at any time.

const { renderMarkdown } = require('./markdown');

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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; }
  button { font-family: inherit; cursor: pointer; }
  svg { display: block; }

  /* tabs */
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
  @keyframes pulse { 50% { opacity: .3; } }

  body.single #tabs { display: none; }
  body.single { background: var(--vscode-editor-background); }

  /* panes */
  #panes { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .log { flex: 1; overflow-y: auto; padding: 8px 10px 8px; }
  /* what the agent is doing, said where the eye is: under the last thing in the transcript, above the message */
  .work { flex: none; display: flex; align-items: center; gap: 7px; padding: 2px 12px 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .work .sp { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--vscode-charts-orange); border-right-color: transparent; animation: spin .8s linear infinite; }
  .work .what { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .work .for { flex: none; font-variant-numeric: tabular-nums; }
  .work.ask .sp { border-color: var(--vscode-charts-red); animation: none; }
  /* A turn's sub-agents: a count at the foot that opens to a table of them, each with its model and what its turns cost. */
  .sa { cursor: pointer; text-decoration: underline dotted; }
  .subs { font-size: 11px; color: var(--vscode-descriptionForeground); overflow-x: auto; }
  .work + .subs { flex: none; padding: 0 12px 6px; }
  .subs table { border-collapse: collapse; }
  .subs th, .subs td { padding: 1px 10px 1px 0; text-align: left; white-space: nowrap; vertical-align: baseline; }
  .subs th { font-weight: 600; }
  .subs td.n { font-variant-numeric: tabular-nums; }
  .subs .who { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .result .subs { text-align: left; margin-top: 2px; }
  .mx { flex: none; max-height: 45%; overflow: auto; padding: 4px 12px 8px; border-top: 1px solid var(--vscode-panel-border); }
  .mx .mxh { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .mx .mxh .what { flex: 1; min-width: 0; }
  .mx .mxh button { flex: none; padding: 0 6px; font-size: 11px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); background: none; color: inherit; cursor: pointer; }
  .mx .mxh button:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .mx th { cursor: pointer; user-select: none; }
  .mx th:hover { color: var(--vscode-foreground); }
  .ix th { cursor: default; }
  .ix th:hover { color: inherit; }
  .ix .hint { margin-top: 4px; }
  .ix button.sw { padding: 0 6px; font-size: 11px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); background: none; color: inherit; cursor: pointer; }
  .ix button.sw[aria-pressed="true"] { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .ix button.sw:hover { color: var(--vscode-foreground); }
  .ix button.sw:disabled { opacity: .5; cursor: default; }
  .ix tr.off td { color: var(--vscode-disabledForeground, inherit); }
  /* the vendor's usage, opened from the footer: the backend and plan, each window of the plan or the cost, and when it was read */
  .pu th { cursor: default; }
  .pu th:hover { color: inherit; }
  .pu table + table { margin-top: 4px; }
  .pu tr.warn td { color: var(--vscode-charts-yellow); }
  .pu tr.error td { color: var(--vscode-charts-red); font-weight: 600; }
  .pu .line { margin-top: 3px; }
  .pu .line.stale { font-style: italic; }
  .pu .line.error { color: var(--vscode-charts-red); }
  .pu .foot { display: flex; gap: 12px; margin-top: 4px; }
  .pu button.lnk { background: none; border: none; padding: 0; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .pu button.lnk:hover { text-decoration: underline; }
  .subs.mx th.n, .subs.mx td.n { text-align: right; }
  .mx tr.main td, .mx tr.total td { font-weight: 600; }
  .mx tr.total td { border-top: 1px solid var(--vscode-panel-border); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .msg { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  /* a message of the user's stands apart from the answers: to the right, a filled tint of the foreground so it shows in any theme, and space above it that marks where a turn begins */
  .user { margin: 18px 0 10px auto; width: fit-content; max-width: 88%; padding: 8px 12px; background: color-mix(in srgb, var(--vscode-foreground) 9%, var(--vscode-editor-background)); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); border-radius: 12px 12px 4px 12px; }
  .user:first-child { margin-top: 4px; }
  .user.queued { opacity: .75; border-style: dashed; }
  .user .tag { float: right; font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .user .unq { float: right; margin: -3px -6px 0 6px; padding: 0 4px; border: none; background: none; color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1; cursor: pointer; border-radius: 3px; }
  .user .unq:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
  .user .unq:disabled { opacity: .4; cursor: default; }
  .user .pics { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
  /* pasted images in a sent message: small, as the vendors' own panels show them; a click shows one at the size it was kept, another puts it back */
  .user .pics img { max-height: 48px; max-width: 96px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); display: block; cursor: zoom-in; }
  .user .pics img.big { max-height: none; max-width: 100%; cursor: zoom-out; }
  .assistant { padding-left: 2px; padding-right: 2px; }
  .live { opacity: .85; }

  /* an answer is Markdown, drawn */
  .md { white-space: normal; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md p, .md ul, .md ol, .md pre, .md blockquote, .md .tbl, .md hr { margin: 0 0 8px; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; line-height: 1.3; font-weight: 600; }
  .md h1 { font-size: 1.35em; } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.08em; } .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { padding-left: 22px; } .md li { margin: 2px 0; } .md li > ul, .md li > ol { margin: 2px 0; } .md li > p { margin: 4px 0; }
  .md li.task { list-style: none; margin-left: -18px; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .md pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; overflow-x: auto; white-space: pre; }
  /* a copy button on each code block and each tool call's command; shown when the pointer is over it */
  .code { position: relative; }
  .cp { position: absolute; top: 4px; right: 4px; font: inherit; font-size: 10px; line-height: 1; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); cursor: pointer; opacity: 0; transition: opacity .1s; }
  .code:hover .cp, .tool:hover .cp, .cp:focus, .cp.done { opacity: 1; }
  .cp:hover { color: var(--vscode-foreground); }
  .tool { position: relative; }
  .md pre code { background: none; padding: 0; font-size: 12px; }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; } .md a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .md blockquote { padding: 0 0 0 10px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); }
  .md hr { border: none; border-top: 1px solid var(--vscode-panel-border); }
  .md .tbl { overflow-x: auto; }
  .md table { border-collapse: collapse; }
  .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; vertical-align: top; }
  .md th { font-weight: 600; background: var(--vscode-textCodeBlock-background); }
  .thinking { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-blue); }
  .tool .name { font-weight: 600; }
  .tool .in { color: var(--vscode-descriptionForeground); white-space: pre-wrap; max-height: 6em; overflow: hidden; }
  .tool .in.mono { font-family: var(--vscode-editor-font-family); font-size: 11.5px; }
  .tool .in:empty { display: none; }
  /* A long result is clipped, and does not take the wheel: scrolling the transcript passes over it. A click opens it to scroll on its own; another closes it. */
  .toolres { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-panel-border); max-height: 8em; overflow: hidden; position: relative; }
  .toolres.more { cursor: pointer; }
  .toolres.more::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2.5em; background: linear-gradient(to bottom, transparent, var(--vscode-sideBar-background, var(--vscode-editor-background))); pointer-events: none; }
  .toolres.open { overflow: auto; cursor: auto; }
  .toolres.open::after { content: none; }
  .toolres.err { border-left-color: var(--vscode-charts-red); color: var(--vscode-errorForeground); }
  .status { color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center; }
  .status .done { margin-top: 4px; color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .status.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
  .status.switch { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
  .status.switch .sw { flex: 0 1 auto; min-width: 0; }
  .status.switch .btns { flex: none; margin: 0; }
  .status.switch .btns button { white-space: nowrap; }
  .status.switch::before, .status.switch::after { content: ''; flex: 1; min-width: 16px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884)); }
  .status.sub { text-align: left; padding-left: 4px; }
  .status.sub::before { content: '\\2937\\00a0'; }
  .status.sub .who { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
  .ask .aside { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  .error { color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-charts-red); }
  .result { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; }
  .perm { border: 1px solid var(--vscode-inputValidation-warningBorder); background: var(--vscode-inputValidation-warningBackground); }
  .perm .btns { display: flex; gap: 6px; margin-top: 6px; }
  .perm .path { font-family: var(--vscode-editor-font-family); font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 2px 0 4px; word-break: break-all; }
  .perm .what { color: var(--vscode-descriptionForeground); margin: 2px 0 4px; }
  .perm pre { margin: 0 0 4px; padding: 6px 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 11.5px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 24em; overflow: auto; }
  .perm .diff .del { display: block; background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.18)); }
  .perm .diff .add { display: block; background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,.14)); }
  .perm .diff .cut { display: block; color: var(--vscode-descriptionForeground); font-style: italic; }
  .perm button, .empty button { font-size: 11px; padding: 2px 10px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .perm button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  /* a question from the agent: its choices as buttons, a line for an answer of your own, and the answers once given */
  .ask { border: 1px solid var(--accent, var(--vscode-focusBorder)); border-radius: 8px; padding: 8px 10px 10px; white-space: normal; }
  .ask .q { margin: 2px 0 8px; }
  .ask .chip { display: inline-block; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .ask .t { display: block; font-weight: 600; margin-bottom: 4px; }
  .ask .opt { display: block; width: 100%; box-sizing: border-box; text-align: left; margin: 3px 0; padding: 5px 9px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-foreground); font-size: 12px; line-height: 1.4; }
  .ask .opt:hover { border-color: var(--vscode-focusBorder); }
  .ask .opt.on { border-color: var(--accent, var(--vscode-focusBorder)); background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .ask .opt .d { display: block; font-size: 11px; opacity: .8; }
  .ask .other { width: 100%; box-sizing: border-box; margin: 3px 0; padding: 5px 9px; font: inherit; font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; outline: none; }
  .ask .other:focus { border-color: var(--vscode-focusBorder); }
  .ask .btns { display: flex; gap: 6px; margin-top: 4px; }
  .status .btns { display: flex; gap: 6px; margin-top: 6px; justify-content: center; }
  .ask .btns button, .status .btns button { font-size: 11px; padding: 3px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .ask .btns button.primary, .status .btns button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .ask .btns button:disabled { opacity: .45; cursor: default; }
  .ask.done { border-color: var(--vscode-panel-border); padding: 6px 10px; }
  .ask.done .q { margin: 2px 0; } .ask.done .t { display: inline; font-weight: 500; margin: 0 6px 0 0; }
  .ask.done .a { color: var(--accent, var(--vscode-textLink-foreground)); font-weight: 600; }
  .ask.done .a.none { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .empty { padding: 32px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .btns { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
  .empty button { font-size: 12px; padding: 4px 12px; display: inline-flex; gap: 6px; align-items: center; }

  /* composer: the message on top, the tools in a row beneath. Each kind of tab takes its own vendor's look. */
  #composer { --accent: #D97757; margin: 0 8px 4px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 10px; background: var(--vscode-input-background); flex: none; display: flex; flex-direction: column; }
  #composer:focus-within { border-color: var(--accent); }
  #composer.off { opacity: .6; }
  #input { resize: none; min-height: 22px; max-height: 180px; font-family: inherit; font-size: inherit; line-height: 1.45; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; padding: 9px 12px 7px; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  /* pasted images wait above the message */
  #shots { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; }
  .shot { position: relative; flex: none; width: 56px; height: 56px; border-radius: 6px; overflow: hidden; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
  .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .shot .x { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%; background: rgba(0,0,0,.65); color: #fff; font-size: 11px; line-height: 16px; text-align: center; }
  .shot .x:hover { background: #000; }
  #tools { display: flex; align-items: center; gap: 2px; padding: 3px 5px 5px 6px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 12px; min-width: 0; }
  #tools .sp { flex: 1; min-width: 4px; }
  #tools .sep { flex: none; width: 1px; height: 16px; margin: 0 5px; background: var(--vscode-panel-border); }
  .tb { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 5px; border: none; border-radius: 6px; background: none; color: inherit; font-size: 12px; white-space: nowrap; }
  button.tb:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .tb:disabled { opacity: .45; cursor: default; }
  .tb svg { flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  #t-ctx { cursor: default; }
  #t-ctx svg { width: 16px; height: 16px; transform: rotate(-90deg); }
  #t-ctx .track { stroke: currentColor; opacity: .25; stroke-width: 2.4; }
  #t-ctx .fill { stroke: var(--accent); stroke-width: 2.4; }
  #t-ctx.warn .fill { stroke: var(--vscode-charts-yellow); } #t-ctx.error .fill { stroke: var(--vscode-charts-red); }
  #t-cache { cursor: default; } #t-cache.cold { opacity: .55; }
  #t-model { min-width: 0; flex: 0 1 auto; overflow: hidden; }
  #t-model .m { overflow: hidden; text-overflow: ellipsis; }
  #t-model .e { flex: none; }
  #t-model .chev { display: none; }
  #t-model.off .m { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
  #t-mode.risk { color: var(--vscode-charts-yellow); }
  #send { flex: none; width: 28px; height: 28px; margin-left: 4px; border: none; border-radius: 7px; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; }
  #send:hover:not(:disabled) { filter: brightness(1.1); }
  #send:disabled { opacity: .4; cursor: default; }
  #send svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  #send.stop svg { fill: currentColor; stroke: none; width: 12px; height: 12px; }

  /* dictation: the microphone carries a ring that swells with your voice, and a running time */
  #t-mic { position: relative; }
  #t-mic .ring { position: absolute; left: 5px; top: 4px; width: 16px; height: 16px; border-radius: 50%; background: var(--vscode-charts-red); opacity: 0; transform: scale(1); transition: transform 90ms linear; pointer-events: none; }
  #t-mic .ic, #t-mic .tm { position: relative; }
  #t-mic .tm { font-variant-numeric: tabular-nums; }
  #t-mic.rec { color: var(--vscode-charts-red); } #t-mic.rec .ring { opacity: .28; }
  #t-mic.silent { color: var(--vscode-charts-yellow); }
  #t-mic.busy .ic { animation: pulse 1s infinite; }
  #composer.listening { border-color: var(--vscode-charts-red); }

  /* Claude Code: a squared box, a rule above the tools, the model in a pill, a salmon square to send */
  #composer.claude #t-model { background: var(--vscode-badge-background, rgba(128,128,128,.2)); color: var(--vscode-foreground); border-radius: 12px; padding: 0 10px; }
  #composer.claude #t-model .e { color: var(--vscode-descriptionForeground); }

  /* Codex: a large soft box with no rule, the sandbox beside the +, the effort in violet, a round neutral button to send */
  #composer.codex { --accent: var(--vscode-focusBorder); border-radius: 20px; }
  #composer.codex #input { padding: 12px 16px 6px; min-height: 40px; }
  #composer.codex #tools { border-top: none; padding: 2px 8px 8px 10px; gap: 4px; }
  #composer.codex #t-add { order: 1; } #composer.codex #t-mode { order: 2; } #composer.codex #t-model { order: 3; }
  #composer.codex .sep { order: 4; } #composer.codex #t-ide { order: 5; } #composer.codex .sp { order: 6; } #composer.codex #t-mic { order: 7; } #composer.codex #send { order: 8; }
  #composer.codex #t-model { color: var(--vscode-foreground); }
  #composer.codex #t-model .e { color: #b48ead; }
  #composer.codex #t-model .chev { display: block; width: 12px; height: 12px; opacity: .7; }
  /* the IDE-context toggle says its state by colour alone: green when on, grey when off */
  #t-ide { color: var(--vscode-descriptionForeground); opacity: .75; }
  #t-ide.on { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); opacity: 1; }
  /* a neutral disc mixed from the text colour, so it shows on any theme; a theme's secondary button colour can match the box */
  #composer.codex #send { width: 30px; height: 30px; border-radius: 50%; background: rgba(128,128,128,.4); background: color-mix(in srgb, var(--vscode-foreground) 26%, transparent); color: var(--vscode-foreground); }
  #composer.codex #send.stop { background: var(--vscode-foreground); color: var(--vscode-editor-background); }

  /* menus open upward from the tool that owns them */
  .pop { position: fixed; z-index: 10; min-width: 190px; max-width: min(340px, calc(100vw - 16px)); overflow-y: auto; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 12px; }
  #submenu { z-index: 11; }
  .pop .h { padding: 5px 8px 3px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .kw { position: relative; display: inline-flex; flex: none; }
  .kw .vdot { position: absolute; right: -3px; bottom: -2px; width: 6px; height: 6px; border-radius: 50%; box-shadow: 0 0 0 1px var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .vdot.claude { background: #D97757; } .vdot.codex { background: #10a37f; }
  .pop .h .k { width: 11px; height: 11px; vertical-align: -2px; margin-right: 2px; }
  .pop .note { padding: 5px 8px; color: var(--vscode-descriptionForeground); white-space: normal; }
  .pop .it { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto; column-gap: 6px; align-items: baseline; padding: 4px 8px; border-radius: 5px; cursor: pointer; outline: none; }
  .pop .it:hover, .pop .it.cur, .pop .it:focus { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
  .pop.vendor .it { padding: 6px 8px; }
  .pop .it.dis { opacity: .45; cursor: default; pointer-events: none; }
  .pop .it .ck { color: var(--accent, currentColor); }
  .pop .it .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .pop .it .chev { font-size: 15px; line-height: 10px; }
  .pop .it .d { grid-column: 2 / -1; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: normal; }
  .pop .filter { width: 100%; box-sizing: border-box; margin-bottom: 4px; padding: 4px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; outline: none; }
  .pop .row { display: flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 5px; cursor: pointer; }
  .pop .row:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }

  /* Claude usage and backend */
  #meter { display: flex; align-items: center; gap: 6px; padding: 2px 10px 6px; font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
  #meter .k { width: 12px; height: 12px; }
  #m-claude, #m-codex { cursor: pointer; display: inline-flex; }
  #m-claude:hover, #m-codex:hover { opacity: .8; }
  #m-claude, #m-codex { flex: none; display: inline-flex; }
  #meter .mb { flex: none; padding: 0 6px; font-size: 11px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); background: none; color: inherit; }
  #meter .mb:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  #meter .mb[aria-pressed="true"] { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  #meter .mb.warn { background: var(--vscode-inputValidation-warningBackground); border-color: var(--vscode-inputValidation-warningBorder); color: var(--vscode-foreground); }
  #meter .mu { flex: 1; min-width: 0; display: flex; gap: 8px; justify-content: flex-end; overflow: hidden; white-space: nowrap; cursor: pointer; }
  #meter .mu:hover { color: var(--vscode-foreground); }
  #meter .mu.stale { font-style: italic; }
  #meter .seg.warn { color: var(--vscode-charts-yellow); }
  #meter .seg.error { color: var(--vscode-charts-red); font-weight: 600; }

  /* last on purpose: an author display rule (.pane is flex) would otherwise override the hidden attribute */
  [hidden] { display: none !important; }
</style></head>
<body>
  <div id="tabs"><div id="add" title="New tab">+</div></div>
  <div id="panes"><div class="empty" id="empty"><div>No sessions yet.</div><div class="btns"><button id="e-claude">${badge('claude')}New Claude tab</button><button id="e-codex">${badge('codex')}New Codex tab</button></div></div></div>
  <div id="composer" class="off">
    <div id="shots" hidden></div>
    <textarea id="input" rows="1" disabled placeholder="Open a tab with +"></textarea>
    <div id="tools">
      <button class="tb" id="t-add" title="Mention files" disabled></button>
      <button class="tb" id="t-slash" title="Slash commands" hidden></button>
      <span class="tb" id="t-ctx" hidden></span>
      <span class="tb" id="t-cache" hidden></span>
      <button class="tb" id="t-model" disabled><span class="m"></span><span class="e"></span><span class="chev"></span></button>
      <span class="sep" hidden></span>
      <button class="tb" id="t-ide" hidden aria-pressed="false"></button>
      <span class="sp"></span>
      <button class="tb" id="t-mode" disabled></button>
      <button class="tb" id="t-mic" title="Dictate" disabled aria-pressed="false"><span class="ring"></span><span class="ic"></span><span class="tm"></span></button>
      <button id="send" disabled title="Send"></button>
    </div>
  </div>
  <div id="meter" hidden><span id="m-claude" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" aria-label="Continue on Claude">${badge('claude')}</span><span id="m-codex" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" aria-label="Continue on Codex" hidden>${badge('codex')}</span><button id="m-backend" class="mb"></button><button id="m-use" class="mb" aria-pressed="false">usage</button><button id="m-index" class="mb" hidden>index</button><button id="m-subs" class="mb" hidden aria-pressed="false">sub-agents</button><span id="m-usage" class="mu" role="button" tabindex="0"></span></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const $tabs = $('tabs'), $add = $('add'), $panes = $('panes'), $empty = $('empty');
  const $composer = $('composer'), $input = $('input'), $send = $('send');
  const $tAdd = $('t-add'), $tSlash = $('t-slash'), $tCtx = $('t-ctx'), $tCache = $('t-cache'), $tModel = $('t-model'), $tMode = $('t-mode'), $tIde = $('t-ide'), $tMic = $('t-mic'), $sep = document.querySelector('#tools .sep');
  const panes = new Map();   // sid -> pane state
  const commands = { claude: [], codex: [] };
  let tabs = [], active = null, menu = null, menuOwner = null, menuAnchor = null, submenu = null, submenuParent = null;
  const ICONS = ${iconsJson}, LETTER = { claude: 'C', codex: 'X' };

  // static artwork: never built from data
  const SVG = {
    plus: '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11"/></svg>',
    slash: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M9.5 4.5l-3 7"/></svg>',
    clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.4"/></svg>',
    bolt: '<svg viewBox="0 0 16 16"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
    up: '<svg viewBox="0 0 16 16"><path d="M8 13V3.5M3.5 8L8 3.5 12.5 8"/></svg>',
    stop: '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/></svg>',
    mic: '<svg viewBox="0 0 16 16"><rect x="5.8" y="1.8" width="4.4" height="7.6" rx="2.2"/><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2.1"/></svg>',
    shield: '<svg viewBox="0 0 16 16"><path d="M8 1.8l5 1.8v4.1c0 3-2 5.2-5 6.5-3-1.3-5-3.5-5-6.5V3.600z"/><path d="M8 5.200v3.300M8 10.800v.100"/></svg>',
    chev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.500l3 3 3-3"/></svg>',
    cursor: '<svg viewBox="0 0 16 16"><path d="M6.5 6.500l2.7 7 1.1-3.1 3.1-1.100z"/><path d="M4.2 1.800l.600 1.700M1.8 4.200l1.7.600M1.7 8.300l1.6-.700M8.3 1.700l-.700 1.6"/></svg>',
    ring: '<svg viewBox="0 0 16 16"><circle class="track" cx="8" cy="8" r="6" fill="none"/><circle class="fill" cx="8" cy="8" r="6" fill="none" stroke-linecap="round"/></svg>',
  };
  const MODES = {
    default: ['Ask', 'Ask before edits and commands'], acceptEdits: ['Edits', 'Edit files without asking; ask before commands'], plan: ['Plan', 'Explore and plan; change nothing'],
    auto: ['Auto', 'Decide per action, and ask when unsure'], bypassPermissions: ['Bypass', 'Never ask. Only for a sandbox'],
    'read-only': ['Read only', 'Read files; change nothing'], 'workspace-write': ['Workspace', 'Edit files in the workspace'], 'danger-full-access': ['Full access', 'No sandbox'],
  };
  $tAdd.innerHTML = SVG.plus; $tSlash.innerHTML = SVG.slash; $tCtx.innerHTML = SVG.ring; $tModel.querySelector('.chev').innerHTML = SVG.chev;
  $tMic.querySelector('.ic').innerHTML = SVG.mic;
  $tIde.innerHTML = SVG.cursor; $tIde.append(el0('span', 'IDE context'));
  function el0(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }
  const RING = 2 * Math.PI * 6;

  ${renderMarkdown.toString()}
  const openTarget = (target) => vscode.postMessage({ type: 'open', target });
  const drawn = (text) => renderMarkdown(text, document, openTarget);
  /** A copy button for a piece of text: the host puts it on the clipboard, the button says so for a moment. */
  function copyButton(getText) {
    const b = el('button', 'cp', 'copy'); b.type = 'button'; b.title = 'Copy';
    b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'copy', text: getText() }); b.textContent = 'copied'; b.classList.add('done'); setTimeout(() => { b.textContent = 'copy'; b.classList.remove('done'); }, 1200); });
    return b;
  }
  /** Each code block in a rendered answer gets a copy button, in a wrapper so the button stays put while the block scrolls. */
  function copyable(root) {
    for (const pre of [...root.querySelectorAll('pre')]) {
      if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains('code')) continue;
      const box = el('div', 'code'); pre.replaceWith(box); box.append(pre, copyButton(() => pre.textContent));
    }
    return root;
  }
  /**
   * A tool call as a person reads it: a title, and the one thing that matters about it, rather than the input as JSON.
   * Bash and Codex's shell: the description as the title when there is one, the command as the body. Files: the path.
   * Searches: the pattern, and where. Anything else: the input as before.
   */
  function toolView(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '');
    // Codex's web search (src/codexAgent.js, webInput): what it searched for, or the page it opened or looked in; nothing yet
    // while it starts, as Codex says what it was only when it completes
    if (name === 'web_search') {
      const what = i.action === 'search' ? (Array.isArray(i.queries) && i.queries.length ? i.queries.join('\\n') : str(i.query))
        : i.action === 'find' ? '"' + str(i.pattern) + '"' + (str(i.url) ? ' in ' + str(i.url) : '')
        : i.action === 'open' ? str(i.url) || str(i.title) : str(i.query);
      return { title: { open: 'web search · open page', find: 'web search · find in page' }[i.action] || 'web search', body: what || '…', mono: false, copy: what };
    }
    if (str(i.command)) return { title: str(i.description) ? name + ' · ' + str(i.description) : name, body: str(i.command), mono: true };
    if (str(i.file_path) || str(i.path) || str(i.notebook_path)) {
      const where = str(i.file_path) || str(i.path) || str(i.notebook_path);
      const at = i.offset ? ':' + i.offset + (i.limit ? '-' + (i.offset + i.limit) : '') : '';
      return { title: name + (str(i.pattern) ? ' · ' + str(i.pattern) : ''), body: where + at, mono: true };
    }
    if (str(i.pattern)) return { title: name, body: str(i.pattern) + (str(i.glob) ? '  (' + str(i.glob) + ')' : ''), mono: true };
    if (str(i.url)) return { title: name, body: str(i.url), mono: true };
    if (str(i.description) || str(i.prompt)) return { title: name + (str(i.description) ? ' · ' + str(i.description) : ''), body: str(i.prompt).slice(0, 300), mono: false };
    return { title: name, body: fmtIn(input), mono: true };
  }
  /**
   * A permission request as a person reads it: for an edit, the file and the change as a diff; for a new file, the file and
   * what goes in it; for a command, the command and what it is for; for anything else, the tool call's own view.
   * @returns {{title: string, body: Node[]}}
   */
  function permView(tool, input) {
    const i = input && typeof input === 'object' ? input : {};
    const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '');
    const base = (f) => str(f).split('/').pop();
    const MAX = 40;
    const lines = (text, cls) => { const all = String(text || '').replace(/\\n$/, '').split('\\n'); const shown = all.slice(0, MAX); const out = shown.map((l) => el('span', cls, (cls === 'del' ? '- ' : '+ ') + l)); if (all.length > MAX) out.push(el('span', 'cut', '… ' + (all.length - MAX) + ' more lines')); return out; };
    const diff = (oldText, newText) => { const d = el('pre', 'diff'); d.append(...lines(oldText, 'del'), ...lines(newText, 'add')); return d; };
    const block = (text) => { const b = el('pre', ''); const all = String(text || '').split('\\n'); b.textContent = all.slice(0, MAX).join('\\n') + (all.length > MAX ? '\\n… ' + (all.length - MAX) + ' more lines' : ''); return b; };
    if (tool === 'Edit' && (str(i.file_path) || i.old_string !== undefined)) return { title: tool + ' · ' + base(i.file_path), body: [el('div', 'path', str(i.file_path)), diff(i.old_string, i.new_string)] };
    if (tool === 'MultiEdit' && Array.isArray(i.edits)) return { title: tool + ' · ' + base(i.file_path), body: [el('div', 'path', str(i.file_path)), ...i.edits.map((e) => diff(e && e.old_string, e && e.new_string))] };
    if ((tool === 'Write' || tool === 'NotebookEdit') && (str(i.file_path) || str(i.notebook_path))) return { title: tool + ' · ' + base(i.file_path || i.notebook_path), body: [el('div', 'path', str(i.file_path || i.notebook_path)), block(i.content !== undefined ? i.content : i.new_source)] };
    if (str(i.command)) return { title: tool, body: [...(str(i.description) ? [el('div', 'what', str(i.description))] : []), block(str(i.command))] };
    const tv = toolView(tool, input);
    return { title: tv.title, body: [el('div', 'in' + (tv.mono ? ' mono' : ''), tv.body)] };
  }
  /** What a tool call's copy button copies: the command itself when there is one, otherwise the input as shown. */
  function commandOf(input) { if (input && typeof input.command === 'string') return input.command; if (input && Array.isArray(input.command)) return input.command.join(' '); return fmtIn(input); }

  function el(tag, cls, text) { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }
  function fmtIn(v) { try { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch (_) { return String(v); } }
  const usd = (n) => (Number(n) >= 1 ? Number(n).toFixed(2) : Number(n).toFixed(3));   // a turn is often cents
  const gwUsd = (n) => (Number(n) >= 1 ? Number(n).toFixed(2) : Number(n) >= 0.01 ? Number(n).toFixed(3) : Number(n).toFixed(4));   // a gateway's figure for a cheap model is a fraction of a cent
  function fmtTok(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
  const cur = () => tabs.find((t) => t.id === active) || null;

  // vendor icon when its extension is installed; a letter otherwise, or if the image fails to load
  const VNAME = { claude: 'Claude', codex: 'Codex' };
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

  // ---- panes
  function makePane(tab) {
    const root = el('div', 'pane'); root.hidden = true;
    const log = el('div', 'log');
    const work = el('div', 'work'), what = el('span', 'what'), took = el('span', 'for'); work.hidden = true; work.setAttribute('role', 'status');
    work.append(el('span', 'sp'), what, took);
    const subs = el('div', 'subs'); subs.hidden = true;   // the running turn's sub-agents as a table, opened from the count at the foot
    const mx = el('div', 'subs mx'); mx.hidden = true;    // the whole session's usage, thread by thread, opened from the footer
    const ix = el('div', 'subs mx ix'); ix.hidden = true;  // the codebase search index, folder by folder, opened from the footer
    const pu = el('div', 'subs mx pu'); pu.hidden = true;  // the vendor's usage: the plan's windows or the cost, opened from the footer
    root.append(log, work, subs, mx, ix, pu); $panes.append(root);
    const sent = [];                                // what the user has sent in this tab, oldest first, for the arrow keys
    const p = { sid: tab.id, sent, hist: null, root, log, work, what, took, subs, subsOpen: false, mx, mxOpen: false, mxData: null, mxSort: { key: 'cost', dir: -1 }, ix, ixOpen: false, ixData: null, ixTimer: null, pu, puOpen: false, doing: '', asking: 0, live: null, liveText: '', tools: {}, queued: {}, draft: '', shots: [], kind: tab.kind, stick: true };
    // The transcript keeps to its end until the user scrolls away from it, and returns to keeping to it when they scroll
    // back. It is held there when the pane changes size too: a page is given its transcript before it has its final shape.
    log.addEventListener('scroll', () => { if (log.clientHeight) p.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => pin(p)).observe(log);
    panes.set(tab.id, p); return p;
  }
  // While a session works, its pane says so at the foot of the transcript: what it is doing, and for how long.
  const span = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
  function syncWork(sid) {
    const p = panes.get(sid), t = tabs.find((x) => x.id === sid); if (!p) return;
    const busy = !!(t && t.busy), was = p.work.hidden;
    p.work.hidden = !busy;
    if (busy) {
      p.work.className = 'work' + (p.asking ? ' ask' : '');
      p.what.textContent = p.asking ? 'Waiting for your answer' : (p.doing || 'Working') + '…';
      p.took.textContent = t.busySince ? span(Date.now() - t.busySince) : '';
      if (t.queued) p.took.textContent += (p.took.textContent ? ' · ' : '') + t.queued + ' queued';
      // Codex: the sub-agents the turn has started, which its SDK does not report; each by name in the tooltip, and the
      // count opens a table of them, each with its model and what its turns cost, read from its own thread file
      const sa = t.subagents;
      if (sa && Array.isArray(sa.list) && sa.list.length) {
        const parts = [sa.working ? sa.working + ' working' : '', sa.finished ? sa.finished + ' done' : '', sa.interrupted ? sa.interrupted + ' stopped' : ''].filter(Boolean);
        const count = el('span', 'sa', (sa.list.length > 1 ? 'sub-agents: ' : 'sub-agent: ') + parts.join(', '));
        count.title = 'Click for each one: its model and what its turns have cost';
        count.addEventListener('click', () => { p.subsOpen = !p.subsOpen; syncWork(sid); });
        p.took.append((p.took.textContent ? ' · ' : ''), count);
        p.took.title = sa.list.map(subWords).join('\\n');
        p.subs.hidden = !p.subsOpen;
        if (p.subsOpen) subsTable(p.subs, sa.list);
      } else { p.took.title = ''; p.subs.hidden = true; }
    } else { p.doing = ''; p.asking = 0; p.subs.hidden = true; }
    if (was !== p.work.hidden) pin(p);
  }
  // A sub-agent in words: its name, its state, its reports, and what its own thread file has said: the model of its latest
  // turn and its effort (every model it used, when it changed), its turns, and its tokens.
  const subState = (st) => ({ working: 'working', finished: 'done', interrupted: 'stopped' }[st] || st);
  function subModel(x) { return x.models && x.models.length > 1 ? x.models.map((m) => m.model + ' ×' + m.turns).join(' → ') : x.model ? x.model + (x.effort ? ' · ' + x.effort : '') : ''; }
  function subTokens(x) { const k = x.tokens || {}; return 'in ' + fmtTok(k.input) + (k.cached ? ' (cached ' + fmtTok(k.cached) + ')' : '') + ' · out ' + fmtTok(k.output); }
  function subWords(x) { return x.name + ': ' + subState(x.state) + (x.reports ? ', ' + x.reports + (x.reports > 1 ? ' reports' : ' report') : '') + (x.model ? ' · ' + subModel(x) + ' · ' + subTokens(x) : ''); }
  /** The table of a turn's sub-agents, built again each time it is shown. */
  function subsTable(box, list) {
    box.textContent = '';
    const table = el('table'), head = el('tr');
    for (const h of ['agent', 'state', 'model', 'turns', 'tokens', 'reports']) head.append(el('th', null, h));
    table.append(head);
    for (const x of list) {
      const tr = el('tr'), who = el('td'), name = el('span', 'who', x.name);
      if (x.nickname) name.title = x.nickname;
      who.append(name);
      tr.append(who, el('td', null, subState(x.state)), el('td', null, x.model ? subModel(x) : '…'), el('td', 'n', x.model ? String(x.turns || 0) : ''), el('td', 'n', x.model ? subTokens(x) : ''), el('td', 'n', x.reports ? String(x.reports) : ''));
      table.append(tr);
    }
    box.append(table);
  }

  // ---- a Codex session's usage, thread by thread: the main thread and every sub-agent it started, each read from its own
  // file by the host (sessionStore.sessionUsage) and priced at list rates there. Opened from the footer; asked for again
  // at the end of each turn while it is open. Sub-agents sort by any column; the main thread stays first, the totals last.
  const USAGE_COLS = [['name', 'agent'], ['model', 'model'], ['turns', 'turns'], ['input', 'input'], ['cached', 'cached'], ['output', 'output'], ['cost', '≈ cost'], ['share', 'share']];
  function askUsage(sid) { vscode.postMessage({ type: 'subagentUsage', sid }); }
  function toggleUsage(sid, open) {
    const p = panes.get(sid); if (!p) return;
    p.mxOpen = open === undefined ? !p.mxOpen : open;
    if (p.mxOpen) closeOthers(p, 'mx');
    p.mx.hidden = !p.mxOpen;
    if (p.mxOpen) { askUsage(sid); if (!p.mxData) { p.mx.textContent = ''; p.mx.append(el('div', 'mxh', 'Reading this session\\'s files…')); } else drawUsage(p); }
    syncUsageButton(); pin(p);
  }
  function syncUsageButton() { const t = cur(), p = t ? panes.get(t.id) : null; $msubs.setAttribute('aria-pressed', p && p.mxOpen ? 'true' : 'false'); }

  // ---- the codebase search index, folder by folder, opened from the footer's "index": read again every few seconds
  // while open, so a build in progress shows its counts growing, and at the end of each turn
  const INDEX_POLL_MS = 5000;
  function askIndex(sid) { vscode.postMessage({ type: 'indexStatus', sid }); }
  function toggleIndex(sid, open) {
    const p = panes.get(sid); if (!p) return;
    p.ixOpen = open === undefined ? !p.ixOpen : open;
    if (p.ixOpen) closeOthers(p, 'ix');
    p.ix.hidden = !p.ixOpen;
    if (p.ixTimer) { clearInterval(p.ixTimer); p.ixTimer = null; }
    if (p.ixOpen) { askIndex(sid); drawIndex(p); p.ixTimer = setInterval(() => askIndex(sid), INDEX_POLL_MS); }
    syncIndexButton(); pin(p);
  }
  function syncIndexButton() { const t = cur(), p = t ? panes.get(t.id) : null; $mindex.setAttribute('aria-pressed', p && p.ixOpen ? 'true' : 'false'); }
  // ---- the vendor's usage, opened from the footer's "usage" or its compact reading: what the meter the page holds says
  // of the active tab's vendor and backend (the plan's windows, or the cost), as it is and as old as it is; refresh and
  // login live here. Presentation state only: the host acts on nothing until a button here asks it to. One of the three
  // panels is open at a time, so the transcript keeps its room.
  const USAGE_URL = { claude: 'https://claude.ai/settings/usage', codex: 'https://chatgpt.com/codex/settings/usage' };
  function closeOthers(p, keep) {
    if (keep !== 'mx' && p.mxOpen) toggleUsage(p.sid, false);
    if (keep !== 'ix' && p.ixOpen) toggleIndex(p.sid, false);
    if (keep !== 'pu' && p.puOpen) togglePlan(p.sid, false);
  }
  function togglePlan(sid, open) {
    const p = panes.get(sid); if (!p) return;
    p.puOpen = open === undefined ? !p.puOpen : open;
    if (p.puOpen) closeOthers(p, 'pu');
    p.pu.hidden = !p.puOpen;
    if (p.puOpen) drawPlan(p);
    syncPlanButton(); pin(p);
  }
  function syncPlanButton() { const t = cur(), p = t ? panes.get(t.id) : null; $muse.setAttribute('aria-pressed', p && p.puOpen ? 'true' : 'false'); }
  const planCap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  function drawPlan(p) {
    const box = p.pu, t = tabs.find((x) => x.id === p.sid), kind = t ? t.kind : null, m = kind ? meters[kind] : null; box.textContent = '';
    const codex = kind === 'codex', vendor = codex ? 'Codex' : 'Claude', gw = !codex && !!(t && t.gateway), login = !!(m && m.action === 'login');
    const head = el('div', 'mxh'), what = el('span', 'what', vendor + ' usage'), act = el('button', 'again', login ? 'log in' : 'refresh'), close = el('button', 'x', '×');
    act.title = login ? 'Log in to ' + vendor + ', so a reading can be made' : codex ? 'Read the last Codex turn\\'s figures again' : 'Read the usage again';
    act.hidden = gw || !m || m.action === null;
    act.addEventListener('click', () => vscode.postMessage(login ? { type: 'meterLogin' } : { type: 'meterRefresh', vendor: kind }));
    close.title = 'Close'; close.addEventListener('click', () => togglePlan(p.sid, false));
    head.append(what, act, close); box.append(head);
    const table = el('table'), row = (k, v) => { const tr = el('tr'); tr.append(el('th', null, k), el('td', null, v)); table.append(tr); };
    // the backend and the plan as the vendor reports them: Anthropic's usage endpoint names no plan, so none is invented here
    const ownOff = !codex && !!(t && t.own && m && t.own !== m.backend);   // a backend of the tab's own, not the window's: the reading here is the window's
    row('Backend', gw ? 'LLM gateway, this tab\\'s own' : ownOff ? (t.own === 'api' ? 'API / Bedrock' : 'subscription (login)') + ', this tab\\'s own choice' : !m ? '—' : codex ? (m.backend === 'api' ? 'OpenAI API key' : m.backend === 'bedrock' ? 'Amazon Bedrock' : 'ChatGPT (login)') : m.backendName || m.backendLabel || '—');
    row('Plan', gw ? 'not reported through the gateway' : !m ? '—' : codex ? (m.backend === 'api' ? 'none: billed per token' : m.backend === 'bedrock' ? 'none: billed to the AWS account' : m.plan ? planCap(m.plan) : 'not reported') : m.mode === 'cost' ? 'none: billed per token' : 'not reported');
    if (codex && m && m.credits) row('Credits', m.credits.unlimited ? 'unlimited' : m.credits.has ? m.credits.balance || 'some' : 'none');
    box.append(table);
    if (ownOff) box.append(el('div', 'line', 'The window is on ' + (m.backendName || m.backendLabel) + '; the reading below is the window\\'s, not this tab\\'s. The line under each answer shows this tab\\'s tokens.'));
    const note = (text, cls) => box.append(el('div', 'line' + (cls ? ' ' + cls : ''), text));
    if (gw) note('Usage through the gateway is not reported here. The line under each answer shows its tokens and which models answered.');
    else if (!m) note('No reading yet for ' + vendor + '.');
    else if (m.limits && m.limits.length) {
      const lt = el('table', 'lim'), hr = el('tr'); for (const h of ['window', 'remaining', 'resets']) hr.append(el('th', null, h)); lt.append(hr);
      for (const l of m.limits) {   // a level in words beside its colour
        const tr = el('tr', l.level === 'ok' ? '' : l.level);
        tr.append(el('td', null, l.name), el('td', 'n', l.remaining + '%' + (l.level === 'error' ? ' · nearly out' : l.level === 'warn' ? ' · low' : '')), el('td', null, l.resetsAt ? (l.reset || '') + (l.eta ? ' (' + l.eta + ')' : '') : 'window has started over'));
        lt.append(tr);
      }
      box.append(lt);
      if (m.reached) note('The ' + m.reached + ' limit has been reached.', 'error');
    } else if (m.cost) {
      const c = m.cost, ct = el('table', 'lim'), hr = el('tr'), r = (k, v) => { const tr = el('tr'); tr.append(el('td', null, k), el('td', 'n', v)); ct.append(tr); };
      hr.append(el('th', null, 'period'), el('th', null, 'tokens, estimated cost')); ct.append(hr);
      r('Session (5h)', fmtTok(c.session.tokens) + ' tokens · ≈$' + usd(c.session.cost)); r('Today', fmtTok(c.today.tokens) + ' tokens · ≈$' + usd(c.today.cost));
      for (const x of c.models || []) r(x.model, fmtTok(x.tokens) + ' tokens · ≈$' + usd(x.cost));
      box.append(ct); note('Estimated from the local transcripts at Anthropic\\'s list prices; the provider\\'s bill can differ.');
    } else for (const l of m.lines || []) note(l);
    if (m && m.stale) note(m.lines[m.lines.length - 1] || 'Showing the last reading.', 'stale');
    // when the reading was made; the session's own breakdown; where the account is managed
    const foot = el('div', 'foot'), time = m && m.fetchedAt ? new Date(m.fetchedAt).toLocaleTimeString() : '';
    foot.append(el('span', null, !m || gw ? '' : time ? (m.asOf ? 'As of the last Codex turn on this machine, ' : 'Updated ') + time : 'No reading yet'));
    if (t && t.thread) { const b = el('button', 'lnk', 'session breakdown'); b.title = 'This session\\'s tokens, thread by thread'; b.addEventListener('click', () => toggleUsage(p.sid, true)); foot.append(b); }
    if (!gw && m && (codex ? m.backend !== 'api' && m.backend !== 'bedrock' : m.mode !== 'cost')) { const a = el('button', 'lnk', 'Manage ' + (codex ? 'ChatGPT' : 'Claude') + ' usage ↗'); a.title = USAGE_URL[kind]; a.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: USAGE_URL[kind] })); foot.append(a); }
    box.append(foot);
  }
  const INDEX_COLS = [['name', 'folder'], ['on', 'setting'], ['files', 'files'], ['sections', 'sections'], ['vectors', 'with vectors'], ['search', 'search'], ['state', 'state']];
  const num = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');
  function indexSearch(u, f) { return !f.on || f.off || f.built === undefined ? '—' : u.meaning && f.sections && f.vectors >= 0.9 * f.sections ? 'meaning' : 'keywords'; }
  function indexState(u, f) {
    if (!f.on) return 'off';
    if (f.built === undefined) return '';
    if (f.off) return 'off: .codebaseignore is *';
    if (!f.built) return 'not built yet';
    if (f.updating) return 'indexing files';
    if (f.embedding) return 'making vectors';
    // no lock held and short of the server's own rule for search by meaning (90% of the sections; a section with nothing to embed never gets a vector): waiting for a tab's server to take it up
    if (u.meaning && f.sections && f.vectors < 0.9 * f.sections) return 'vectors ' + num(f.vectors) + ' of ' + num(f.sections);
    return 'up to date';
  }
  // a switch: the setting as it is, and a click that asks the host to flip it; the answer redraws the panel
  function indexSwitch(on, title, msg) {
    const b = el('button', 'sw', on ? 'on' : 'off'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.title = title;
    b.addEventListener('click', () => { b.disabled = true; vscode.postMessage(msg); });
    return b;
  }
  function drawIndex(p) {
    const box = p.ix, u = p.ixData; box.textContent = '';
    const head = el('div', 'mxh'), what = el('span', 'what'), again = el('button', 'again', 'refresh'), close = el('button', 'x', '×');
    again.title = 'Read the indexes again'; close.title = 'Close';
    again.addEventListener('click', () => askIndex(p.sid)); close.addEventListener('click', () => toggleIndex(p.sid, false));
    head.append(what, again, close); box.append(head);
    if (!u) { what.textContent = 'Reading the indexes…'; return; }
    const fs = u.folders || [];
    if (!fs.length) { what.textContent = u.why || u.error || 'No folder is open in this window.'; return; }
    // the workspace's switch: the setting where it is set (the workspace's settings if they have it, else the user's); a folder with a setting of its own keeps it
    head.insertBefore(indexSwitch(u.on, 'Codebase search is ' + (u.on ? 'on' : 'off') + ' for this workspace: click to turn it ' + (u.on ? 'off' : 'on') + ', in the workspace\\'s settings if they have it, else yours. A folder with a setting of its own keeps it. Each tab takes a change up from its next message.', { type: 'searchToggle', sid: p.sid }), again);
    const on = fs.filter((f) => f.on), sum = (k) => on.reduce((n, f) => n + (f[k] || 0), 0), files = sum('files'), sections = sum('sections'), vectors = sum('vectors');
    const live = on.filter((f) => !f.off && f.sections);   // by meaning as a whole once every folder that is searched is (the server's own rule, 90% of a folder's sections)
    const mode = !u.meaning ? 'by keywords' : live.length && live.every((f) => f.vectors >= 0.9 * f.sections) ? 'by meaning' : 'by keywords, vectors being made';
    what.textContent = 'Codebase search is ' + (u.on ? 'on' : 'off') + ' for this workspace · ' + (on.length === fs.length ? fs.length + (fs.length === 1 ? ' folder' : ' folders') : on.length + ' of ' + fs.length + ' folders on')
      + (u.why || u.error ? ' · ' + (u.why || u.error) : on.length ? ' · ' + mode + ' · ' + num(files) + ' files' + (u.meaning && sections ? ' · ' + Math.round((100 * vectors) / sections) + '% with vectors' : '') : '')
      + (u.at ? ' · as of ' + new Date(u.at).toLocaleTimeString() : '');
    what.title = 'Each folder of the workspace, with its own setting and its own index under ~/.cache/codebase-index/. Keywords are indexed within seconds; '
      + 'vectors, which search by meaning needs, take minutes the first time on a CPU and are made in the background, folder by folder. '
      + (u.meaning ? 'Search by meaning is installed.' : u.meaning === false ? 'Search by meaning is not installed: Perch: Install Codebase Search by Meaning adds it, about 300 MB, once.' : '');
    const table = el('table'), hr = el('tr');
    for (const [k, label] of INDEX_COLS) hr.append(el('th', k === 'files' || k === 'sections' || k === 'vectors' ? 'n' : '', label));
    table.append(hr);
    for (const f of fs) {
      const tr = el('tr', f.on ? '' : 'off'), name = el('td', null, f.name); name.title = f.root + (f.ignore && f.ignore.length ? ' · left out by .codebaseignore: ' + f.ignore.join(', ') : '');
      const sw = el('td'); sw.append(indexSwitch(f.on, 'Codebase search is ' + (f.on ? 'on' : 'off') + ' for ' + f.name + ': click to turn it ' + (f.on ? 'off' : 'on') + ', in the folder\\'s own settings (.vscode/settings.json)', { type: 'searchFolder', sid: p.sid, root: f.root, on: !f.on }));
      tr.append(name, sw, el('td', 'n', num(f.files)), el('td', 'n', num(f.sections)), el('td', 'n', u.meaning ? num(f.vectors) : '—'), el('td', null, indexSearch(u, f)), el('td', null, indexState(u, f)));
      table.append(tr);
    }
    box.append(table);
    if (u.meaning === false && on.length) box.append(el('div', 'hint', 'Search by meaning is not installed: keywords only. Perch: Install Codebase Search by Meaning adds it, about 300 MB, once.'));
  }
  const usageWhen = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  function usageWho(r) {
    if (r.total) return r.name;
    const said = { started: 'started', active: 'working on a follow-up', tasked: 'given a follow-up task', finished: 'finished', interrupted: 'interrupted' }[r.state] || '';
    return [r.name + (r.nickname ? ' (' + r.nickname + ')' : ''), r.main ? 'the session\\'s own thread' : said, r.first ? 'first heard of ' + usageWhen(r.first) + (r.last && r.last !== r.first ? ', last ' + usageWhen(r.last) : '') : '', r.missing ? 'its file was not found' : '', r.thread ? 'thread ' + r.thread : ''].filter(Boolean).join('\\n');
  }
  function drawUsage(p) {
    const box = p.mx, u = p.mxData; box.textContent = '';
    const head = el('div', 'mxh'), what = el('span', 'what'), again = el('button', 'again', 'refresh'), close = el('button', 'x', '×');
    again.title = 'Read the files again'; close.title = 'Close';
    again.addEventListener('click', () => askUsage(p.sid)); close.addEventListener('click', () => toggleUsage(p.sid, false));
    head.append(what, again, close); box.append(head);
    if (!u || u.error) { what.textContent = u ? u.error : 'Reading this session\\'s files…'; return; }
    const subs = u.subagents || [], all = [Object.assign({ main: true }, u.main, { name: 'main thread' }), ...subs];
    const priced = all.every((r) => typeof r.cost === 'number');
    const tok = (r, k) => (r.tokens && r.tokens[k]) || 0;
    const weight = (r) => (priced ? r.cost : tok(r, 'input') + tok(r, 'output'));
    const sum = (list) => ({ total: true, turns: list.reduce((n, r) => n + (r.turns || 0), 0), tokens: { input: list.reduce((n, r) => n + tok(r, 'input'), 0), cached: list.reduce((n, r) => n + tok(r, 'cached'), 0), output: list.reduce((n, r) => n + tok(r, 'output'), 0) }, cost: priced ? list.reduce((n, r) => n + r.cost, 0) : null });
    const whole = sum(all), mine = sum(subs), total = weight(whole);
    const share = (r) => (total > 0 ? Math.round((100 * weight(r)) / total) + '%' : '');
    what.textContent = (subs.length ? 'Main thread and ' + subs.length + (subs.length > 1 ? ' sub-agents' : ' sub-agent') : 'Main thread; no sub-agents') +
      (priced ? ' · ≈$' + usd(whole.cost) + ' at list prices' + (subs.length ? ', sub-agents ≈$' + usd(mine.cost) + ' (' + share(mine) + ')' : '') : ' · ' + fmtTok(whole.tokens.input) + ' in, ' + fmtTok(whole.tokens.output) + ' out') +
      (u.at ? ' · as of ' + new Date(u.at).toLocaleTimeString() : '');
    what.title = (!u.prices ? 'LiteLLM\\'s price table could not be read, so the figures are tokens only. '
      : !priced ? 'Some threads ran on a model LiteLLM\\'s table has no price for (the cost column says which), so shares are of tokens. '
      : 'Each thread\\'s tokens at its models\\' list prices, from LiteLLM\\'s public price table: uncached input, input written to the cache, cached input, and output, each at its rate. ') +
      (u.kind === 'claude'
        ? (u.backend === 'subscription' ? 'On a Claude subscription nothing is billed per token: turns count against the plan\\'s limits, shown in the footer. The figures say where the work went.'
          : u.backend === 'gateway' ? 'Through the gateway, the result lines carry its own figures; these are Anthropic\\'s list prices.' : 'The API is billed at Anthropic\\'s rates, which these follow; Bedrock at its own.')
        : u.backend === 'chatgpt' ? 'On a ChatGPT plan nothing is billed per token: turns count against the plan\\'s limits, shown in the footer. The figures say where the work went.'
        : u.backend === 'bedrock' ? 'Amazon Bedrock bills at its own rates.' : 'An API key is billed at OpenAI\\'s own rates, which these follow.') +
      ' Input counts every token sent, cached ones among them. Each thread is read whole from its own file' + (u.kind === 'claude' ? ', a sub-agent\\'s kept beside the session\\'s.' : ', a fork\\'s copy of its parent\\'s history left out.');
    const table = el('table'), hr = el('tr'), s = p.mxSort;
    for (const [k, label] of USAGE_COLS) {
      const th = el('th', k === 'name' || k === 'model' ? '' : 'n', label + (s.key === k ? (s.dir < 0 ? ' ▾' : ' ▴') : ''));
      th.title = 'Sort the sub-agents by ' + (k === 'name' ? 'name' : k === 'share' ? 'share' : label.replace('≈ ', '')) + '; again to reverse';
      th.addEventListener('click', () => { p.mxSort = { key: k, dir: s.key === k ? -s.dir : k === 'name' || k === 'model' ? 1 : -1 }; drawUsage(p); });
      hr.append(th);
    }
    table.append(hr);
    const val = (r, k) => (k === 'name' ? r.name : k === 'model' ? r.model || '' : k === 'turns' ? r.turns || 0 : k === 'cost' ? (typeof r.cost === 'number' ? r.cost : -1) : k === 'share' ? weight(r) || 0 : tok(r, k));
    const order = subs.slice().sort((a, b) => { const x = val(a, s.key), y = val(b, s.key); return (typeof x === 'string' ? String(x).localeCompare(String(y)) : x - y) * s.dir; });
    const row = (r, cls) => {
      const tr = el('tr', cls || ''), who = el('td'), name = el('span', r.total ? '' : 'who', r.name);
      name.title = usageWho(r); who.append(name);
      const cost = el('td', 'n', typeof r.cost === 'number' ? '$' + usd(r.cost) : '—');
      if (r.unpriced) cost.title = 'No list price for ' + r.unpriced.join(', ');
      tr.append(who, el('td', null, r.total ? '' : r.model ? subModel(r) : r.missing ? 'file not found' : '—'), el('td', 'n', String(r.turns || 0)),
        el('td', 'n', fmtTok(tok(r, 'input'))), el('td', 'n', fmtTok(tok(r, 'cached'))), el('td', 'n', fmtTok(tok(r, 'output'))), cost, el('td', 'n', share(r)));
      return tr;
    };
    table.append(row(all[0], 'main'));
    for (const r of order) table.append(row(r));
    if (subs.length > 1) table.append(row(Object.assign(mine, { name: 'sub-agents (' + subs.length + ')' }), 'total'));
    table.append(row(Object.assign(whole, { name: 'session' }), 'total'));
    box.append(table);
  }
  setInterval(() => { if (active) syncWork(active); }, 1000);

  function pin(p) { if (p.stick) p.log.scrollTop = p.log.scrollHeight; }
  function add(p, cls, text) { const d = el('div', 'msg ' + cls, text); p.log.append(d); pin(p); return d; }
  /** A line of plain text whose web addresses are links; the webview opens them in the browser. */
  function linkified(text) {
    const f = document.createDocumentFragment(); const re = /https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?'"]/g; let at = 0, m; const t = String(text || '');
    while ((m = re.exec(t))) { if (m.index > at) f.append(t.slice(at, m.index)); const a = el('a', '', m[0]); a.href = m[0]; a.title = m[0]; f.append(a); at = m.index + m[0].length; }
    if (at < t.length) f.append(t.slice(at));
    return f;
  }
  function addLinked(p, cls, text) { const d = add(p, cls, ''); d.append(linkified(text)); return d; }
  function endLive(p) { if (p.live) { p.live.remove(); p.live = null; } p.liveText = ''; }

  // ---- tabs
  function renderTabs() {
    $tabs.querySelectorAll('.tab').forEach((n) => n.remove());
    for (const t of tabs) {
      const d = el('div', 'tab' + (t.id === active ? ' active' : '') + (t.busy ? ' busy' : '') + (t.attention ? ' attn' : ''));
      // a tab that has been on both vendors says so: the way it went in the tooltip, the other's colour beside its mark (note 202)
      const went = Array.isArray(t.path) && t.path.length > 1 ? t.path.map((v) => VNAME[v] || v).join(' → ') : t.kind;
      d.title = t.title + ' · ' + went + (t.gateway ? ' · LLM gateway' : '') + ' · double-click to rename';
      const k = el('span', 'kw'); k.append(badge(t.kind));
      if (went !== t.kind) { const other = t.kind === 'claude' ? 'codex' : 'claude'; const dot = el('span', 'vdot ' + other); k.append(dot); }
      const tt = el('span', 't', t.title), b = el('span', 'b'), x = el('span', 'x', '×');
      x.title = 'Close tab';
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'close', sid: t.id }); });
      d.addEventListener('click', () => { if (t.id !== active) vscode.postMessage({ type: 'activate', sid: t.id }); });
      d.addEventListener('auxclick', (e) => { if (e.button === 1) vscode.postMessage({ type: 'close', sid: t.id }); });
      tt.addEventListener('dblclick', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'rename', sid: t.id }); });
      d.append(k, tt, b, x); $tabs.insertBefore(d, $add);
      if (t.id === active) d.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // An editor tab shows one session: VS Code's own tab is its tab, so the page has no tab bar. The page remembers which
  // session it shows, which is how VS Code hands the right one back after a reload.
  let single = false;
  function applyTabs(next, nextActive, one) {
    if (!!one !== single) { single = !!one; document.body.classList.toggle('single', single); }
    if (single && nextActive) { try { vscode.setState({ sid: nextActive }); } catch (_) { /* no state store */ } }
    const prev = active;
    if (prev && panes.has(prev)) panes.get(prev).draft = $input.value;
    tabs = next; active = nextActive;
    const ids = new Set(tabs.map((t) => t.id));
    for (const [id, p] of panes) if (!ids.has(id)) { p.root.remove(); panes.delete(id); voice.delete(id); if (p.ixTimer) clearInterval(p.ixTimer); }
    for (const t of tabs) { const p = panes.get(t.id) || makePane(t); p.root.hidden = t.id !== active; syncWork(t.id); if (!t.index && p.ixOpen) toggleIndex(t.id, false); }
    $empty.hidden = tabs.length > 0 || single;
    renderTabs();
    const p = panes.get(active);
    if (prev !== active) { closeMenu(); $input.value = p ? p.draft : ''; grow(); if (p) { p.stick = true; pin(p); } }
    renderShots();
    syncComposer();
    applyMeter();
  }

  // ---- composer
  // what a choice resolves to: "default · Opus 5.5" reads as "Opus 5.5", and a bare "default" as nothing
  function resolved(list, value) { const o = (list || []).map((x) => (typeof x === 'string' ? { value: x, label: x } : x)).find((x) => x.value === (value || '')); return o ? o.label.replace(/^default( · )?/, '') : String(value || ''); }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  function syncComposer() {
    const t = cur(), claude = !!t && t.kind === 'claude';
    $composer.className = (t ? t.kind : 'off');
    $input.disabled = !t; $tAdd.disabled = !t; $tModel.disabled = !t; $tMode.disabled = !t; $tMic.disabled = !t;
    $input.placeholder = !t ? 'Open a tab with +' : t.busy ? 'Queue another message…' : claude ? 'Message Claude…' : 'Do anything';
    $input.title = t ? 'Paste an image to attach it' : '';
    $tIde.hidden = !t; $sep.hidden = !t || claude;   // the rule before it is Codex's look
    $tIde.className = 'tb' + (t && t.ide ? ' on' : ''); $tIde.setAttribute('aria-pressed', String(!!(t && t.ide)));
    $tIde.title = t && t.ide ? 'IDE context is on: the active file and selection are attached to each message. Click to turn off.' : 'IDE context is off. Click to attach the active file and selection to each message.';
    $tModel.classList.toggle('off', !!(t && t.off));   // the session runs another model than the one chosen: the pill names it, marked
    $tSlash.hidden = !claude || !commands.claude.length;
    $tCtx.hidden = !claude; $tCache.hidden = !claude;
    if (!t) { syncVoice(); $tModel.querySelector('.m').textContent = ''; $tModel.querySelector('.e').textContent = ''; $tMode.textContent = ''; $send.disabled = true; $send.className = ''; $send.innerHTML = SVG.up; return; }

    const model = t.off ? t.off.label : resolved(t.models, t.model) || (t.gateway ? 'default' : claude ? 'Claude' : 'Codex');   // on a gateway whose file names no model, the default has no name to show
    const hasEffort = (t.efforts || []).length > 1, effort = hasEffort ? cap(resolved(t.efforts, t.effort)) : '';
    $tModel.querySelector('.m').textContent = model;
    $tModel.querySelector('.e').textContent = effort;
    $tModel.title = (t.off ? t.off.title + ' ' : t.actualModel ? 'Running ' + t.actualModel + '. ' : '') + (t.backend ? 'Backend: ' + (t.backend === 'api' ? 'API / Bedrock' : t.backend === 'gateway' ? 'LLM gateway' : 'subscription') + '. ' : '') + (t.via ? 'Last answered by ' + t.via + '. ' : '')
      + 'Model and effort. Changes apply from the next message.';

    const mode = MODES[t.mode] || [t.mode, ''];
    $tMode.innerHTML = claude ? SVG.bolt : SVG.shield; $tMode.append(el('span', null, mode[0]));
    $tMode.className = 'tb' + (t.mode === 'danger-full-access' || t.mode === 'bypassPermissions' ? ' risk' : '');
    $tMode.title = (claude ? 'Permission mode: ' : 'Sandbox: ') + mode[1] + (claude ? '' : '. Approvals: ' + (t.approvals || 'default'));

    const c = t.context;
    $tCtx.className = 'tb' + (c && c.percent >= 95 ? ' error' : c && c.percent >= 80 ? ' warn' : '');
    $tCtx.querySelector('.fill').setAttribute('stroke-dasharray', ((c ? Math.max(c.percent, c.percent > 0 ? 3 : 0) : 0) / 100 * RING).toFixed(2) + ' ' + RING.toFixed(2));
    $tCtx.title = c ? 'Context ' + c.percent + '% used · ' + fmtTok(c.used) + ' of ' + fmtTok(c.max) + ' tokens' : 'Context usage appears once the session starts';
    tickCache();

    syncVoice();
    $send.disabled = false;
    $send.className = t.busy ? 'stop' : '';
    $send.innerHTML = t.busy ? SVG.stop : SVG.up;
    $send.title = t.busy ? 'Stop' + (t.queued ? ' and drop ' + t.queued + ' queued' : '') : 'Send';
  }

  // the prompt cache stays warm for a fixed time after each answer; a message sent after that re-caches the conversation
  function tickCache() {
    const t = cur(), c = t && t.cache;
    if (!c || $tCache.hidden) return;
    const left = c.since ? c.minutes * 60000 - (Date.now() - c.since) : c.minutes * 60000;
    const cold = !!c.since && left <= 0;
    $tCache.className = 'tb' + (cold ? ' cold' : '');
    $tCache.innerHTML = SVG.clock; $tCache.append(el('span', null, cold ? 'cold' : Math.max(1, Math.ceil(left / 60000)) + 'm'));
    $tCache.title = cold ? 'The prompt cache has expired. The next message re-caches the conversation, which costs more than a cached turn.'
      : c.since ? 'The prompt cache stays warm for ' + Math.max(1, Math.ceil(left / 60000)) + ' more minutes. Messages sent before then are billed at the cached rate.'
      : 'The prompt cache stays warm for ' + c.minutes + ' minutes after each answer.';
  }
  setInterval(tickCache, 20000);

  // ---- dictation. The host records and transcribes; the page shows what is happening and takes the words.
  const voice = new Map();      // sid -> { phase, level, seconds, device, maxSeconds, silent }
  const clock = (sec) => { const n = Math.max(0, Math.floor(sec || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); };
  function syncVoice() {
    const t = cur(), v = (t && voice.get(t.id)) || { phase: 'idle' };
    const rec = v.phase === 'recording', work = v.phase === 'starting' || v.phase === 'transcribing';
    $tMic.className = 'tb' + (rec ? ' rec' : '') + (work ? ' busy' : '') + (rec && v.silent ? ' silent' : '');
    $tMic.setAttribute('aria-pressed', String(rec));
    $tMic.querySelector('.tm').textContent = rec ? clock(v.seconds) : v.phase === 'transcribing' ? '…' : '';
    $tMic.querySelector('.ring').style.transform = 'scale(' + (rec ? (1 + Math.min(1, v.level || 0) * 1.2).toFixed(2) : '1') + ')';
    $tMic.title = rec ? (v.silent ? 'Nothing is being heard from ' + (v.device || 'the microphone') + '. Click to finish, Escape to discard.' : 'Listening on ' + (v.device || 'the microphone') + '. Click to finish, Escape to discard.' + (v.maxSeconds ? ' Stops at ' + clock(v.maxSeconds) + '.' : ''))
      : v.phase === 'transcribing' ? 'Turning speech into text…' : v.phase === 'starting' ? 'Opening the microphone…' : 'Dictate';
    $composer.classList.toggle('listening', rec);
    if (t && rec) $input.placeholder = 'Listening… click the microphone to finish, Escape to discard';
    else if (t && v.phase === 'transcribing') $input.placeholder = 'Turning speech into text…';
  }
  $tMic.addEventListener('click', () => {
    const t = cur(); if (!t) return;
    const v = voice.get(t.id) || { phase: 'idle' };
    if (v.phase === 'recording') vscode.postMessage({ type: 'voiceStop', sid: t.id });
    else if (v.phase === 'idle') vscode.postMessage({ type: 'voiceStart', sid: t.id });
  });
  const dictating = () => { const t = cur(), v = t && voice.get(t.id); return !!v && (v.phase === 'recording' || v.phase === 'starting'); };

  function grow() { $input.style.height = 'auto'; $input.style.height = Math.min(180, Math.max(22, $input.scrollHeight)) + 'px'; }
  function insert(text) {
    const a = $input.selectionStart === undefined ? $input.value.length : $input.selectionStart, b = $input.selectionEnd === undefined ? a : $input.selectionEnd;
    const pre = $input.value.slice(0, a), gap = pre && !/\\s$/.test(pre) ? ' ' : '';
    $input.value = pre + gap + text + $input.value.slice(b);
    const at = (pre + gap + text).length; try { $input.setSelectionRange(at, at); } catch (_) { /* not focusable yet */ }
    grow(); $input.focus();
  }

  // Enter always sends: while the agent is working, the message is queued behind the current turn. The button stops.
  function send() {
    const t = cur(); if (!t) return;
    const p = panes.get(active), shots = p ? p.shots : [];
    const text = $input.value; if (!text.trim() && !shots.length) return;
    closeMenu();
    vscode.postMessage(Object.assign({ type: 'send', sid: active, text }, shots.length ? { images: shots.map((s) => Object.assign({ mime: s.mime, data: s.data }, s.thumb ? { thumb: s.thumb } : {})) } : {}));
    $input.value = ''; p.draft = ''; p.shots = []; grow(); renderShots();
  }

  // ---- pasted images. They wait above the message and go with it. A large one is scaled down first, to the size the
  // API keeps; a full-screen capture of a large display is several times that.
  const $shots = $('shots');
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], MAX_SHOTS = 8, MAX_SIDE = 1568, MAX_CHARS = 5000000, THUMB_SIDE = 320;   // 1568: the most the API keeps; larger is scaled down there anyway, so sending more is only upload
  const parts = (url) => { const at = url.indexOf(','), head = url.slice(5, at); return head.endsWith(';base64') ? { mime: head.slice(0, -7), data: url.slice(at + 1) } : null; };
  function renderShots() {
    const p = panes.get(active), list = p ? p.shots : [];
    $shots.textContent = ''; $shots.hidden = !list.length;
    for (const s of list) {
      const d = el('span', 'shot'); d.title = s.name + (s.width ? ' · ' + s.width + '×' + s.height : '');
      const i = document.createElement('img'); i.alt = s.name; i.src = 'data:' + s.mime + ';base64,' + s.data;
      const x = el('button', 'x', '×'); x.title = 'Remove'; x.type = 'button';
      x.addEventListener('click', (e) => { e.stopPropagation(); p.shots = p.shots.filter((q) => q !== s); renderShots(); $input.focus(); });
      d.append(i, x); $shots.append(d);
    }
  }
  function readImage(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onerror = () => resolve(null);
      r.onload = () => { const got = typeof r.result === 'string' ? parts(r.result) : null; resolve(got && got.data ? fit(file, Object.assign(got, { mime: file.type, name: file.name || 'image' })) : null); };
      r.readAsDataURL(file);
    });
  }
  async function fit(file, shot) {
    if (typeof createImageBitmap !== 'function') return shot;
    let bmp; try { bmp = await createImageBitmap(file); } catch (_) { return shot; }
    shot.width = bmp.width; shot.height = bmp.height;
    // a small rendering for the transcript, where the message shows it; the image itself is not kept there
    try { const t = document.createElement('canvas'), tk = Math.min(1, THUMB_SIDE / Math.max(bmp.width, bmp.height)); t.width = Math.max(1, Math.round(bmp.width * tk)); t.height = Math.max(1, Math.round(bmp.height * tk)); const tc = t.getContext('2d'); if (tc) { tc.drawImage(bmp, 0, 0, t.width, t.height); shot.thumb = t.toDataURL('image/jpeg', 0.7); } } catch (_) { /* no thumbnail: the message says how many images */ }
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (k === 1 && shot.data.length <= MAX_CHARS) return shot;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext('2d'); if (!ctx) return shot;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    let got = parts(c.toDataURL('image/png'));
    if (!got || got.data.length > MAX_CHARS) got = parts(c.toDataURL('image/jpeg', 0.85));
    return got && got.data ? Object.assign(shot, got, { width: c.width, height: c.height }) : shot;
  }
  async function addShots(sid, files) {
    const p = panes.get(sid); if (!p) return;
    let over = 0, bad = 0;
    for (const f of files) {
      if (p.shots.length >= MAX_SHOTS) { over++; continue; }
      const s = await readImage(f);
      if (!panes.has(sid)) return;                       // the tab was closed while the image was being read
      if (!s || s.data.length > MAX_CHARS) { bad++; continue; }
      if (p.shots.length >= MAX_SHOTS) { over++; continue; }
      p.shots.push(s);
      if (sid === active) renderShots();
    }
    if (bad) add(p, 'status', bad + (bad > 1 ? ' images' : ' image') + ' could not be attached: unreadable, or still over 5 MB after scaling');
    if (over) add(p, 'status', 'A message takes ' + MAX_SHOTS + ' images; ' + over + ' left out');
  }
  // a paste that carries an image attaches it; any other paste is text, as usual
  $input.addEventListener('paste', (e) => {
    const t = cur(), cd = e.clipboardData; if (!t || !cd) return;
    const files = Array.from(cd.items || []).filter((i) => i.kind === 'file' && IMAGE_TYPES.includes(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addShots(t.id, files);
  });
  $send.addEventListener('click', () => { const t = cur(); if (!t) return; if (t.busy) vscode.postMessage({ type: 'stop', sid: active }); else send(); });
  /** The arrow keys walk the tab's earlier messages, as a shell does: up from the first line goes back, down from the last line comes forward, and past the newest the draft returns. */
  function navHistory(dir) {
    const t = cur(), p = t && panes.get(t.id); if (!p || !p.sent.length) return false;
    const pos = $input.selectionStart, v = $input.value;
    if (dir < 0 && v.slice(0, pos).includes('\\n')) return false;
    if (dir > 0 && v.slice(pos).includes('\\n')) return false;
    if (!p.hist) { if (dir > 0) return false; p.hist = { i: p.sent.length, draft: v }; }
    const i = p.hist.i + dir;
    if (i < 0) return true;
    if (i >= p.sent.length) { $input.value = p.hist.draft; p.hist = null; } else { p.hist.i = i; $input.value = p.sent[i]; }
    grow(); $input.setSelectionRange($input.value.length, $input.value.length);
    return true;
  }
  $input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !menu && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && navHistory(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return; }
    if (menu && menuOwner === 'slash' && (e.key === 'Enter' || e.key === 'Tab')) { const first = menu.querySelector('.it:not(.dis)'); if (first) { e.preventDefault(); first.click(); return; } }
    if (e.key === 'Escape' && menu) { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Escape') { const t = cur(), p = t ? panes.get(t.id) : null; if (p && (p.puOpen || p.ixOpen || p.mxOpen)) { e.preventDefault(); closeOthers(p, null); return; } }
    if (e.key === 'Escape' && dictating()) { e.preventDefault(); vscode.postMessage({ type: 'voiceCancel' }); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $input.addEventListener('input', () => {
    grow();
    { const t = cur(), p = t && panes.get(t.id); if (p && p.hist) p.hist = null; }   // typing makes the text the draft again
    const t = cur(), m = /^\\/(\\S*)$/.exec($input.value);
    if (t && t.kind === 'claude' && m && commands.claude.length) openSlash(m[1], true);
    else if (menuOwner === 'slash' && menu && menu.dataset.typed) closeMenu();
  });
  $tAdd.addEventListener('click', () => { if (cur()) vscode.postMessage({ type: 'attach', sid: active }); });
  $tIde.addEventListener('click', () => { const t = cur(); if (t) vscode.postMessage({ type: 'setIde', sid: t.id, value: !t.ide }); });

  // ---- menus
  function closeSubmenu(focus) {
    if (submenu) submenu.remove();
    submenu = null;
    if (submenuParent) { submenuParent.setAttribute('aria-expanded', 'false'); if (focus) submenuParent.focus(); }
    submenuParent = null;
  }
  function closeMenu(focus) {
    const anchor = menuAnchor;
    closeSubmenu();
    if (menu) menu.remove();
    if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
    menu = null; menuOwner = null; menuAnchor = null;
    if (focus && anchor) anchor.focus();
  }
  function openMenu(owner, anchor, fill) {
    if (menu && menuOwner === owner && !menu.dataset.typed) { closeMenu(); return null; }
    closeMenu();
    menu = el('div', 'pop'); menu.id = 'menu'; menu.setAttribute('role', 'menu'); menuOwner = owner; menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    const t = cur(); if (t) menu.style.setProperty('--accent', t.kind === 'claude' ? '#D97757' : '#10a37f');
    fill(menu);
    document.body.append(menu);
    menu.addEventListener('scroll', () => closeSubmenu());
    const r = anchor.getBoundingClientRect(), up = r.top > window.innerHeight / 2;
    menu.style.maxHeight = Math.max(120, (up ? r.top : window.innerHeight - r.bottom) - 12) + 'px';
    if (up) menu.style.bottom = (window.innerHeight - r.top + 4) + 'px'; else menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    return menu;
  }
  function openSubmenu(anchor, fill, takeFocus) {
    closeSubmenu();
    submenuParent = anchor; anchor.setAttribute('aria-expanded', 'true');
    submenu = el('div', 'pop sub'); submenu.id = 'submenu'; submenu.setAttribute('role', 'menu');
    if (menu) submenu.style.setProperty('--accent', menu.style.getPropertyValue('--accent'));
    fill(submenu); document.body.append(submenu);
    const r = anchor.getBoundingClientRect(), w = submenu.offsetWidth, h = submenu.offsetHeight;
    const right = r.right + 4, left = r.left - w - 4;
    submenu.style.left = (right + w <= window.innerWidth - 8 ? right : Math.max(8, left)) + 'px';
    submenu.style.top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) + 'px';
    const first = submenu.querySelector('.it:not(.dis)');
    if (takeFocus && first) first.focus();
    return submenu;
  }
  function moveMenuItem(n, by) {
    const box = n.closest('.pop'), rows = box ? [...box.querySelectorAll(':scope > .it:not(.dis)')] : [];
    const at = rows.indexOf(n); if (at < 0 || !rows.length) return;
    rows[(at + by + rows.length) % rows.length].focus();
  }
  function item(label, o) {
    const n = el('div', 'it' + (o.checked ? ' on' : '') + (o.disabled ? ' dis' : '')); n.setAttribute('role', o.radio ? 'menuitemradio' : 'menuitem');
    n.tabIndex = o.disabled ? -1 : 0;
    if (o.disabled) n.setAttribute('aria-disabled', 'true');
    if (o.radio) n.setAttribute('aria-checked', String(!!o.checked));
    n.append(el('span', 'ck', o.checked ? '✓' : ''), el('span', 'l', label), el('span', 'hint', o.hint || ''));
    if (o.submenu) {
      n.classList.add('has-sub'); n.setAttribute('aria-haspopup', 'menu'); n.setAttribute('aria-expanded', 'false');
      const more = el('span', 'chev', '›'); n.append(more);
      const show = (focus) => { if (!o.disabled) openSubmenu(n, o.submenu, focus); };
      n.addEventListener('mouseenter', () => show(false));
      more.addEventListener('click', (e) => { e.stopPropagation(); show(true); });
      n.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(true); } });
    } else n.addEventListener('mouseenter', () => { if (n.closest('#menu')) closeSubmenu(); });
    if (o.desc) n.append(el('span', 'd', o.desc));
    if (!o.disabled) n.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); o.pick(); });
    n.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveMenuItem(n, e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'ArrowLeft' && n.closest('#submenu')) { e.preventDefault(); e.stopPropagation(); closeSubmenu(true); }
      else if (e.key === 'Escape' && n.closest('#submenu')) { e.preventDefault(); e.stopPropagation(); closeSubmenu(true); }
      else if ((e.key === 'Enter' || e.key === ' ') && !o.disabled) { e.preventDefault(); e.stopPropagation(); n.click(); }
    });
    return n;
  }
  const norm = (list) => (list || []).map((x) => (typeof x === 'string' ? { value: x, label: x } : x));

  $tModel.addEventListener('click', (e) => {
    e.stopPropagation(); const t = cur(); if (!t) return;
    openMenu('model', $tModel, (m) => {
      const lock = false;
      m.append(el('div', 'h', 'Model'));
      for (const o of norm(t.models)) m.append(item(o.label, { radio: true, checked: o.value === (t.model || ''), disabled: lock, desc: o.title && o.value ? o.title : '', pick: () => vscode.postMessage({ type: 'setModel', sid: t.id, value: o.value }) }));
      const effs = norm(t.efforts);
      if (effs.length > 1) {
        m.append(el('div', 'h', 'Effort'));
        for (const o of effs) m.append(item(o.value ? cap(o.label) : o.label, { radio: true, checked: o.value === (t.effort || ''), disabled: lock, pick: () => vscode.postMessage({ type: 'setEffort', sid: t.id, value: o.value }) }));
      } else m.append(el('div', 'note', 'This model has no effort control.'));
    });
  });
  $tMode.addEventListener('click', (e) => {
    e.stopPropagation(); const t = cur(); if (!t) return;
    openMenu('mode', $tMode, (m) => {
      const lock = false;
      m.append(el('div', 'h', t.kind === 'claude' ? 'Permission mode' : 'Sandbox'));
      for (const v of (t.modes || [])) { const d = MODES[v] || [v, '']; m.append(item(d[0], { radio: true, checked: v === t.mode, disabled: lock, desc: d[1], pick: () => vscode.postMessage({ type: 'setMode', sid: t.id, value: v }) })); }
      if (t.kind === 'codex') m.append(el('div', 'note', 'Approvals: ' + (t.approvals || 'default') + '. Set with perch.codex.approvalPolicy.'));
    });
  });
  function openSlash(filter, typed) {
    const t = cur(); if (!t) return;
    const was = menu && menuOwner === 'slash' ? menu.querySelector('.filter') : null;
    if (was && typed) { was.value = filter; was.dispatchEvent(new Event('input')); return; }
    const m = openMenu('slash', $tSlash, (mm) => {
      const f = el('input', 'filter'); f.type = 'text'; f.placeholder = 'Filter commands'; f.value = filter || ''; f.hidden = !!typed;
      const list = el('div', 'list');
      const draw = () => {
        list.textContent = '';
        const q = f.value.trim().toLowerCase();
        // a short filter matches names only: one or two letters appear in almost every description
        const hits = commands[t.kind].filter((c) => !q || c.name.toLowerCase().includes(q) || (q.length >= 3 && c.description.toLowerCase().includes(q)))
          .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)));
        for (const c of hits.slice(0, 60)) list.append(item('/' + c.name, { hint: c.hint, desc: c.description, pick: () => { $input.value = '/' + c.name + ' '; grow(); $input.focus(); } }));
        if (!hits.length) list.append(el('div', 'note', 'No command matches.'));
      };
      f.addEventListener('input', draw);
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = list.querySelector('.it'); if (first) first.click(); } else if (e.key === 'Escape') { closeMenu(); $input.focus(); } });
      f.addEventListener('click', (e) => e.stopPropagation());
      mm.append(f, list); draw();
    });
    if (m && typed) m.dataset.typed = '1'; else if (m) m.querySelector('.filter').focus();
  }
  $tSlash.addEventListener('click', (e) => { e.stopPropagation(); openSlash('', false); });

  $add.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu('add', $add, (m) => {
      // a tab on the gateway is offered once there is a gateway file; before that the choice would only lead to a message
      const kinds = [['claude', 'New Claude tab', false], ['codex', 'New Codex tab', false]];
      for (const [kind, label, gateway] of kinds) {
        const row = el('div', 'row'); row.append(badge(kind), label);
        row.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); vscode.postMessage(gateway ? { type: 'new', kind, gateway: true } : { type: 'new', kind }); });
        m.append(row);
      }
    });
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (submenu) closeSubmenu(true); else if (menu) closeMenu(true); else if (dictating() && e.target !== $input) vscode.postMessage({ type: 'voiceCancel' }); });
  window.addEventListener('resize', () => closeSubmenu());
  $('e-claude').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'claude' }));
  $('e-codex').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'codex' }));

  // ---- transcript events
  function onEvent(sid, m) {
    const p = panes.get(sid); if (!p) return;
    // what it is doing now, for the line at the foot of the transcript
    const doing = { delta: 'Writing', text: 'Working', thinking: 'Thinking', tool_result: 'Working', user: 'Working' }[m.kind];
    if (doing) p.doing = doing; else if ((m.kind === 'tool_start' || m.kind === 'tool_use') && !m.update) p.doing = m.name === 'web_search' ? 'Searching the web' : 'Running ' + m.name;
    else if (m.kind === 'subagent' && m.state === 'waiting') p.doing = 'Waiting for sub-agents';
    if (m.kind === 'permission' || (m.kind === 'question' && !m.async)) p.asking++; else if (m.kind === 'clear') { p.asking = 0; p.doing = ''; }
    if (m.kind === 'voice') { if (m.phase === 'idle') voice.delete(sid); else voice.set(sid, m); if (sid === active) syncComposer(); return; }
    switch (m.kind) {
      case 'user': {
        endLive(p); if (m.text) p.sent.push(m.text); const d = add(p, 'user' + (m.queued ? ' queued' : ''), '');
        const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((t) => typeof t === 'string' && /^data:image\\/(png|jpeg|webp);base64,/.test(t)) : [];
        const unseen = (m.images || 0) - thumbs.length;    // images with no thumbnail are counted instead
        const tags = [m.queued ? 'queued' : '', unseen > 0 ? unseen + (unseen > 1 ? ' images' : ' image') : '', m.tag || ''].filter(Boolean);
        // a queued message can be taken back until its turn starts; its words stay in the arrow-up history of the box
        if (m.queued && m.qid) {
          const x = el('button', 'unq', '\u00d7'); x.type = 'button'; x.title = 'Remove from the queue. Its words stay in the message box\\'s history: press the up arrow there to get them back.';
          x.addEventListener('click', (e) => { e.stopPropagation(); x.disabled = true; vscode.postMessage({ type: 'unqueue', sid, qid: m.qid }); });
          d.append(x); p.queued[m.qid] = d;
        }
        if (tags.length) d.append(el('span', 'tag', tags.join(' · ')));
        if (thumbs.length) { const row = el('div', 'pics'); for (const t of thumbs) { const i = document.createElement('img'); i.src = t; i.alt = 'pasted image'; i.title = 'Click to see it larger'; i.addEventListener('click', () => { i.classList.toggle('big'); i.title = i.classList.contains('big') ? 'Click to shrink it' : 'Click to see it larger'; }); row.append(i); } d.append(row); }
        d.append(m.text); break; }
      case 'delta': if (!p.live) p.live = add(p, 'assistant md live', ''); p.liveText += m.text; p.live.textContent = ''; p.live.append(drawn(p.liveText)); copyable(p.live); break;
      case 'text': { endLive(p); const d = add(p, 'assistant md', ''); d.append(drawn(m.text)); copyable(d); break; }
      case 'thinking': endLive(p); add(p, 'thinking', m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text); break;
      case 'tool_use': { endLive(p); if (m.name === 'AskUserQuestion' && m.input && Array.isArray(m.input.questions)) { answered(add(p, 'ask done', ''), m.input.questions, null); break; }   // the question itself follows, or its answers did
        // a call said again once it is known in full (a Codex web search, on completing) is drawn again in its own place
        const tv = toolView(m.name, m.input), was = m.update && m.id ? p.tools[m.id] : null, d = was || add(p, 'tool', '');
        if (was) d.textContent = '';
        d.append(el('span', 'name', tv.title + (m.status ? ' · ' + m.status : '')), el('div', 'in' + (tv.mono ? ' mono' : ''), tv.body), copyButton(() => (tv.copy !== undefined ? tv.copy : commandOf(m.input)))); if (m.id) p.tools[m.id] = d; break; }
      case 'tool_result': {
        const d = add(p, 'toolres' + (m.isError ? ' err' : ''), (m.text || '(no output)') + (m.truncated ? '\\n…' : ''));
        const a = p.tools[m.id]; if (a && a.nextSibling !== d) a.after(d);
        if (d.scrollHeight > d.clientHeight + 1 || (m.text || '').split('\\n').length > 8) d.classList.add('more');
        d.addEventListener('click', () => { if (d.classList.contains('more') && !String(window.getSelection && window.getSelection()).length) d.classList.toggle('open'); });
        break;
      }
      case 'permission': {
        endLive(p); const d = add(p, 'perm', ''); const pv = permView(m.tool, m.input); const head = el('div'); head.append(el('b', null, 'Allow '), el('span', null, pv.title), '?');
        const btns = el('div', 'btns');
        for (const [dec, label, cls] of [['allow', 'Allow', 'primary'], ['always', 'Always', ''], ['deny', 'Deny', '']]) {
          if (dec === 'always' && !m.hasSuggestions) continue;
          const b = el('button', cls, label);
          b.addEventListener('click', () => { vscode.postMessage({ type: 'permission', sid, id: m.id, decision: dec }); d.className = 'msg status'; d.textContent = m.tool + ': ' + dec; p.asking = Math.max(0, p.asking - 1); syncWork(sid); });
          btns.append(b);
        }
        d.append(head, ...pv.body, btns); p.stick = true; break; }
      case 'question': { endLive(p); asking(add(p, 'ask', ''), m, sid, p); p.stick = true; break; }
      case 'answered': { endLive(p); answered(add(p, 'ask done', ''), m.questions, m.answers === null ? null : m.answers || {}); break; }   // null: asked in an earlier session, answered or not by what followed
      case 'subagent': {
        const say = { started: 'started', tasked: 'given a follow-up task', reported: 'reported', finished: 'finished its task', interrupted: 'interrupted' }[m.state];
        if (say && m.name) {
          const d = add(p, 'status sub', ''); d.append(el('span', 'who', m.name), ' ' + say);
          // its end says what its own thread file did: the model that answered it, and what its turns cost
          if (m.info && m.info.model) { d.append(' · ' + subModel(m.info) + ' · ' + subTokens(m.info)); if (m.info.nickname) d.title = m.info.nickname; }
        }
        break; }
      case 'result': { endLive(p); const u = m.usage || {};
        // through a gateway, which model answered: a turn is several requests, and a routed name may send each anywhere
        const via = Array.isArray(m.via) && m.via.length ? ' · via ' + m.via.map((v) => (v.short || v.model) + (v.n > 1 ? ' ×' + v.n : '')).join(', ') : '';
        // off the gateway, which models answered, when one is not the model the tab means: Claude Code moved the session after a refusal, say
        const by = Array.isArray(m.answered) && m.answered.length ? ' · answered by ' + m.answered.map((a) => a.label || a.model).join(', ') : '';
        // the turn's cost: the gateway's own figure when there is one (summed over the turn's requests), else Claude Code's estimate at list prices
        const gw = typeof m.gatewayCost === 'number', est = !gw && typeof m.gatewayEstimate === 'number', sub = cur() && cur().backend === 'subscription';
        const cost = gw ? ' · $' + gwUsd(m.gatewayCost) + ' this turn' : est ? ' · ≈$' + gwUsd(m.gatewayEstimate) + ' this turn' : m.costTurn !== undefined ? ' · ≈$' + usd(m.costTurn) + ' this turn' + (sub ? ' at API rates' : '') : '';
        const d = add(p, 'result', (m.ok ? 'done' : 'failed' + (m.error ? ': ' + m.error : '')) + (m.duration_ms ? ' · ' + (m.duration_ms / 1000).toFixed(1) + 's' : '') + (u.input !== undefined ? ' · in ' + u.input + ' · cached ' + (u.cache_read || 0) + ' · out ' + u.output : '') + cost + via + by);   // a first turn with nothing to subtract from says nothing: the session's total is in the tooltip
        if (gw) d.title = 'The gateway\\'s own figure for this turn, summed over its requests as the gateway reported each; the session so far $' + gwUsd(m.gatewayCostSoFar || m.gatewayCost) + ' by the same reckoning.' + (m.costTurn !== undefined ? ' Claude Code\\'s estimate at Anthropic\\'s list prices, ≈$' + usd(m.costTurn) + ', does not apply to a gateway\\'s names.' : '');
        else if (est) d.title = 'This turn at list prices for what answered: each request\\'s tokens at its model\\'s rates in LiteLLM\\'s public price table, since the gateway puts no price on a streamed response; the session so far ≈$' + gwUsd(m.gatewayEstimateSoFar || m.gatewayEstimate) + ' by the same reckoning.' + (m.costTurn !== undefined ? ' Claude Code\\'s own figure, ≈$' + usd(m.costTurn) + ', prices a gateway\\'s names as Opus.' : '');
        else if (m.cost !== undefined) d.title = (m.costTurn !== undefined ? 'This turn\\'s cost at Anthropic\\'s API list prices, as Claude Code reckons it; the session so far ≈$' + usd(m.cost) + '.' : 'The whole conversation so far ≈$' + usd(m.cost) + ' at Anthropic\\'s API list prices, as Claude Code reckons it; this turn\\'s own cost is shown from the next turn on.') + (sub ? ' On a subscription nothing is billed per token: turns count against the plan\\'s limits, shown in the footer.' : '');
        if (via) d.title = (d.title ? d.title + ' ' : '') + 'Answered through the gateway by ' + m.via.map((v) => v.model + (v.n > 1 ? ' (' + v.n + ' requests)' : '')).join(', ') + ', as the gateway reported.' + (gw || est ? '' : ' A gateway\\'s own billing is not Anthropic\\'s list price.');
        if (typeof m.keySpend === 'number') d.title = (d.title ? d.title + ' ' : '') + 'The gateway counts $' + gwUsd(m.keySpend) + ' spent on this token in all, every use of it included, as of this answer.';
        if (by) d.title = (d.title ? d.title + ' ' : '') + 'Answered by ' + m.answered.map((a) => a.model).join(', ') + ', as each response named its model' + (m.wanted ? ', not ' + m.wanted : '') + '.';
        // Codex: the turn's sub-agents as they ended, a count that opens to the table of them
        const sa = m.subagents;
        if (sa && Array.isArray(sa.list) && sa.list.length) {
          const count = el('span', 'sa', sa.list.length + (sa.list.length > 1 ? ' sub-agents' : ' sub-agent')), box = el('div', 'subs'); box.hidden = true;
          count.title = sa.list.map(subWords).join('\\n');
          count.addEventListener('click', () => { box.hidden = !box.hidden; if (!box.hidden) subsTable(box, sa.list); });
          d.append(' · ', count, box);
        }
        if (p.mxOpen) askUsage(sid);                     // the session's usage table, open: what the turn added
        if (p.ixOpen) askIndex(sid);                     // the index panel, open: what the turn's searches brought up to date
        break; }
      case 'note': { endLive(p); const d = addLinked(p, 'status' + (m.level === 'warn' ? ' warn' : ''), m.text);   // warn: Claude Code moved the session to another model, say
        if (m.vendor) { const t = el('span', 'sw'); t.append(...d.childNodes); d.classList.add('switch'); d.append(badge(m.vendor), t); }   // the tab went on with another vendor here (note 202)
        if (m.nid) d.dataset.nid = m.nid;                 // a note the host can mark done later (a login made)
        if (m.done) d.append(el('div', 'done', m.done));   // replayed after it was
        // what can be done about it stays with the note: a notification is gone in seconds
        if (Array.isArray(m.actions) && m.actions.length) {
          const btns = el('div', 'btns');
          // an action may be a link (an app to connect on chatgpt.com, say), which the host opens in the browser if it is one it allows
          m.actions.forEach((a, i) => { const b = el('button', i ? null : 'primary', a.label); b.addEventListener('click', () => vscode.postMessage(a.url ? { type: 'openExternal', url: a.url } : { type: 'noteAction', sid, action: a.id })); btns.append(b); });
          d.append(btns); p.stick = true;
        }
        break; }
      case 'dequeued': settleQueued(p, m.qid); break;      // its turn has started: an ordinary bubble now
      case 'unqueued': {
        const d = p.queued[m.qid];
        if (m.ok) { if (d) d.remove(); delete p.queued[m.qid]; break; }   // taken back, or dropped with a stopped turn (the note says so)
        settleQueued(p, m.qid, m.why === 'unsupported');
        add(p, 'status', m.why === 'unsupported' ? 'This version of Claude Code cannot take a queued message back; it will run.' : 'Not removed: its turn had already started.');
        break; }
      case 'noteDone':                                   // what the notes of this kind asked for is done: their buttons give way to the word
        for (const d of p.log.querySelectorAll('.status[data-nid="' + m.nid + '"]')) { const b = d.querySelector('.btns'); if (b) b.remove(); if (!d.querySelector('.done')) d.append(el('div', 'done', m.text)); }
        break;
      case 'session': p.work.title = 'session ' + m.id; break;
      case 'error': endLive(p); addLinked(p, 'error', m.text); break;
      case 'clear': p.log.textContent = ''; p.live = null; p.liveText = ''; p.tools = {}; p.queued = {}; p.stick = true; p.sent.length = 0; p.hist = null; break;
      case 'fill': if (sid === active) { $input.value = m.text; grow(); $input.focus(); } else p.draft = m.text; break;
      case 'insert': if (sid === active) insert(m.text); else p.draft = (p.draft && !/\\s$/.test(p.draft) ? p.draft + ' ' : p.draft) + m.text; break;
    }
    syncWork(sid);
    pin(p);
  }

  /** A queued message's bubble once it can no longer be taken back: no x; and, unless it is still waiting, no longer marked queued. */
  function settleQueued(p, qid, stillQueued) {
    const d = p.queued[qid]; if (!d) return;
    delete p.queued[qid];
    const x = d.querySelector('.unq'); if (x) x.remove();
    if (stillQueued) return;
    d.classList.remove('queued');
    const tag = d.querySelector('.tag');
    if (tag) { const rest = tag.textContent.split(' · ').filter((t) => t !== 'queued'); if (rest.length) tag.textContent = rest.join(' · '); else tag.remove(); }
  }

  // ---- a question from the agent. Each question is answered by a choice or a line of your own; all are sent together.
  function answered(d, questions, answers) {
    for (const q of questions || []) {
      if (!q) continue;
      const row = el('div', 'q'); if (q.header) row.append(el('span', 'chip', q.header), ' ');
      row.append(el('span', 't', q.question || ''));
      const a = answers ? answers[q.question] : undefined;
      row.append(el('span', 'a' + (a ? '' : ' none'), a || (answers ? 'not answered' : '')));
      d.append(row);
    }
  }
  function asking(d, m, sid, p) {
    const qs = (m.questions || []).filter((q) => q && typeof q.question === 'string');
    const picks = qs.map(() => new Set()), others = qs.map(() => ''), marks = [];
    // Codex can ask without waiting (request_user_input_async): it carries on, and the answer goes as the next message
    const send = el('button', 'primary', m.async ? (qs.length > 1 ? 'Send answers' : 'Send answer') : qs.length > 1 ? 'Answer all' : 'Answer'), skip = el('button', null, m.async ? 'Dismiss' : 'Skip');
    if (m.async) d.append(el('div', 'aside', 'Codex asked this and carried on without waiting. Your answer goes to it as your next message, queued behind the turn if it is still working.'));
    const ready = () => qs.every((q, i) => picks[i].size || others[i].trim());
    const refresh = () => { for (const f of marks) f(); send.disabled = !ready(); };
    const answers = () => { const out = {}; qs.forEach((q, i) => { out[q.question] = [...(q.options || []).filter((o) => o && picks[i].has(o.label)).map((o) => o.label), others[i].trim()].filter(Boolean).join(', '); }); return out; };
    const finish = (decision) => {
      vscode.postMessage(decision === 'answer' ? { type: 'permission', sid, id: m.id, decision, answers: answers() } : { type: 'permission', sid, id: m.id, decision });
      d.textContent = '';
      if (decision === 'answer') { d.className = 'msg ask done'; answered(d, qs, answers()); } else { d.className = 'msg status'; d.textContent = m.async ? 'question dismissed' : 'question skipped'; }
      if (!m.async) p.asking = Math.max(0, p.asking - 1);
      syncWork(sid);
    };
    qs.forEach((q, i) => {
      const sec = el('div', 'q'); if (q.header) sec.append(el('span', 'chip', q.header));
      sec.append(el('span', 't', q.question));
      for (const o of (q.options || [])) {
        if (!o || typeof o.label !== 'string') continue;
        const b = el('button', 'opt'); b.type = 'button'; b.append(el('span', 'l', o.label)); if (o.description) b.append(el('span', 'd', o.description));
        b.addEventListener('click', (e) => { e.stopPropagation(); if (q.multiSelect) { if (picks[i].has(o.label)) picks[i].delete(o.label); else picks[i].add(o.label); } else { picks[i] = new Set([o.label]); others[i] = ''; inp.value = ''; } refresh(); });
        marks.push(() => b.classList.toggle('on', picks[i].has(o.label)));
        sec.append(b);
      }
      const inp = el('input', 'other'); inp.type = 'text'; inp.placeholder = !(q.options || []).length ? 'Your answer…' : q.multiSelect ? 'Something else, as well or instead…' : 'Something else…';
      inp.addEventListener('input', () => { others[i] = inp.value; if (!q.multiSelect && inp.value.trim()) picks[i].clear(); refresh(); });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && ready()) { e.preventDefault(); finish('answer'); } });
      inp.addEventListener('click', (e) => e.stopPropagation());
      sec.append(inp); d.append(sec);
    });
    send.addEventListener('click', (e) => { e.stopPropagation(); if (ready()) finish('answer'); });
    skip.addEventListener('click', (e) => { e.stopPropagation(); finish('deny'); });
    const btns = el('div', 'btns'); btns.append(send, skip); d.append(btns); refresh();
  }

  // ---- usage, in the footer. It follows the active tab: Claude's backend and limits, or the ChatGPT plan's.
  const $meter = $('meter'), $mb = $('m-backend'), $mu = $('m-usage'), $mClaude = $('m-claude'), $mCodex = $('m-codex'), $muse = $('m-use'), $msubs = $('m-subs'), $mindex = $('m-index');
  $muse.title = 'This vendor\\'s usage: the backend, the plan as it reports it, each window of the plan or the cost, and when it was read';
  $muse.addEventListener('click', (e) => { e.stopPropagation(); const t = cur(); if (t) togglePlan(t.id); });
  $mindex.title = 'Codebase search for this workspace: on or off, for the workspace and for each folder, and each folder\\'s index: files, sections, how many have vectors, whether search is by keywords or by meaning, and whether it is being built';
  $mindex.addEventListener('click', (e) => { e.stopPropagation(); const t = cur(); if (t) toggleIndex(t.id); });
  $msubs.title = 'This session\\'s usage, thread by thread: the main thread and each sub-agent it started, each with its model, turns, tokens, and cost at list prices';
  $msubs.addEventListener('click', (e) => { e.stopPropagation(); const t = cur(); if (t) toggleUsage(t.id); });
  const meters = { claude: null, codex: null };
  let meter = null, meterKind = null, onGateway = false;
  // the gateway, as the host last said: whether there is a file to offer a tab on, and whether it is in order
  let gatewayInfo = { file: '', exists: false, ok: false };
  function applyMeter() {
    const t = cur();
    meterKind = t ? t.kind : null;
    meter = meterKind ? meters[meterKind] : null;
    { const pp = t ? panes.get(t.id) : null; if (pp && pp.puOpen) drawPlan(pp); }   // the panel follows the tab and its vendor, never showing another's reading
    $meter.hidden = !meter;
    if (!meter) return;
    const claude = meterKind === 'claude';
    // These are actions, not identity marks: show where the tab can continue. The current vendor is already the tab's
    // icon, composer, model and backend.
    const destination = t.switchTo && t.switchTo.kind ? t.switchTo.kind : claude ? 'codex' : 'claude';
    $mClaude.hidden = destination !== 'claude'; $mCodex.hidden = destination !== 'codex'; $mb.hidden = false;
    syncPlanButton();                                // the plan is in the usage panel, for both vendors
    $msubs.hidden = !t.thread; syncUsageButton();   // a tab whose session is on record: its usage, thread by thread
    $mindex.hidden = !t.index; syncIndexButton();   // codebase search on for the workspace: the index, folder by folder
    // the backend: Claude's subscription or API / Bedrock, or the gateway this tab is on; Codex's ChatGPT login or API key
    onGateway = claude && !!t.gateway;
    if (onGateway) {
      $mb.textContent = 'gw' + (t.gatewayWarn ? ' \u26A0' : '');
      $mb.className = 'mb' + (t.gatewayWarn ? ' warn' : '');
      $mb.title = 'Claude backend for this tab: the gateway, with the variables in ' + (gatewayInfo.file || 'the gateway file') + '. ' + (t.gatewayWarn ? 'That file is missing or incomplete; the next message says what to do. ' : '') + 'Click to change.';
      $mu.textContent = ''; $mu.className = 'mu none';
      $mu.append(el('span', 'seg none', '\u2014'));
      $mu.title = 'Usage through the gateway is not reported here. The line under each answer shows its tokens.';
      return;
    }
    // a backend of the tab's own, not the window's: the pill says the tab's, and the window's reading is not shown as its
    if (claude && t.own && t.own !== meter.backend) {
      const mine = t.own === 'api' ? 'API / Bedrock' : 'subscription (login)';
      $mb.textContent = t.own === 'api' ? 'API' : 'sub'; $mb.className = 'mb';
      $mb.title = 'Claude backend for this tab: ' + mine + ', its own choice; the window is on ' + (meter.backendName || meter.backendLabel) + '. Click to change.';
      $mu.textContent = ''; $mu.className = 'mu none';
      $mu.append(el('span', 'seg none', '\u2014'));
      $mu.title = 'This tab is on ' + mine + '; the window\\'s usage reading is the ' + (meter.backendName || meter.backendLabel) + '\\'s, not this tab\\'s. The line under each answer shows its tokens.';
      return;
    }
    $mb.textContent = (meter.backendLabel || '') + (meter.backendWarn ? ' \u26A0' : '');
    $mb.className = 'mb' + (meter.backendWarn ? ' warn' : '');
    $mb.title = meter.backendTitle || '';
    $mu.textContent = '';
    $mu.className = 'mu ' + meter.level + (meter.stale ? ' stale' : '');
    if (meter.segments.length) for (const seg of meter.segments) { const n = el('span', 'seg ' + seg.level, seg.text); if (seg.title) n.title = seg.title; $mu.append(n); }
    else $mu.append(el('span', 'seg none', meter.action === 'login' ? 'log in' : '\u2014'));
    const time = meter.fetchedAt ? new Date(meter.fetchedAt).toLocaleTimeString() : '';
    const when = !time ? '' : meter.asOf ? 'As of the last Codex turn on this machine, ' + time + '. ' : 'Updated ' + time + '. ';
    const hint = 'Click for detail' + (meter.action === 'login' ? ', and to log in' : ' and to refresh') + '.';
    const stale = meter.stale ? '\\n' + meter.lines[meter.lines.length - 1] : '';
    if (!meter.segments.some((x) => x.title)) $mu.title = meter.lines.join('\\n') + '\\n' + when + hint;
    else { $mu.title = ''; for (const n of $mu.children) n.title += stale + '\\n' + when + hint; }
  }
  // Each vendor's backends are a menu: Codex's three (every tab), Claude's two of the window's and, for this tab, the gateway.
  $mb.addEventListener('click', (e) => {
    const t = cur();
    if (!t) return;
    e.stopPropagation();
    if (meterKind !== 'claude') {
      openMenu('backend', $mb, (m) => {
        const c = meters.codex || {}, b = c.bedrock || {}, pick = (value) => () => vscode.postMessage({ type: 'codexBackend', value });
        m.append(el('div', 'h', 'Codex backend'));
        m.append(item('ChatGPT (login)', { radio: true, checked: c.backend === 'chatgpt', desc: 'Every tab. Your ChatGPT plan and its limits.', pick: pick('chatgpt') }));
        m.append(item('OpenAI API key', { radio: true, checked: c.backend === 'api', desc: 'Every tab. Billed per token; the key stays in VS Code\\'s secret storage.', pick: pick('api') }));
        m.append(item('Amazon Bedrock', { radio: true, checked: c.backend === 'bedrock', desc: 'Every tab. ' + (b.endpoint === 'runtime' ? 'The runtime endpoint' : 'Mantle') + ' in ' + (b.region || '…') + (b.profile ? ', profile ' + b.profile : '') + ', with your AWS credentials; billed to that account.', pick: pick('bedrock') }));
      });
      return;
    }
    openMenu('backend', $mb, (m) => {
      const windowBackend = meter ? meter.backend : 'subscription', tabBackend = t.gateway ? 'gateway' : t.own || windowBackend;   // each choice is this tab's own
      const pick = (value) => () => vscode.postMessage({ type: 'setBackend', sid: t.id, value });
      m.append(el('div', 'h', 'Claude backend'));
      m.append(item('subscription (login)', { radio: true, checked: tabBackend === 'subscription', desc: 'This tab' + (windowBackend === 'subscription' ? ', as the window is' : '; the window stays on API / Bedrock') + '. Perch: Toggle Claude Backend switches the window.', pick: pick('subscription') }));
      m.append(item('API / Bedrock', { radio: true, checked: tabBackend === 'api', desc: 'This tab, with credentials of Claude Code\\'s own' + (windowBackend === 'api' ? ', as the window is' : '; the window stays on the subscription') + '.', pick: pick('api') }));
      m.append(item('LLM gateway', { radio: true, checked: !!t.gateway, desc: 'This tab only: Claude Code runs with the variables in ' + (gatewayInfo.file || 'the gateway file') + (gatewayInfo.exists ? '' : ', which does not exist yet') + '.', pick: pick('gateway') }));
    });
  });
  // A destination vendor's mark: go on in this tab with that vendor (note 202). A model row means its default effort;
  // its contextual submenu pins one of the effort levels that model actually accepts.
  function vendorMenu(anchor) {
    const t = cur(); if (!t) return;
    return openMenu('vendor', anchor, (m) => {
      const to = t.switchTo || { kind: t.kind === 'claude' ? 'codex' : 'claude', models: [] }, busy = !!(t.busy || t.attention);
      m.style.setProperty('--accent', to.kind === 'claude' ? '#D97757' : '#10a37f');
      const h = el('div', 'h'); h.append(badge(to.kind), document.createTextNode(' Continue on ' + VNAME[to.kind])); m.append(h);
      m.append(el('div', 'note', busy ? 'Once this turn has ended.' : 'Choose a model for its default effort, or open › for a specific effort. ' + VNAME[to.kind] + ' reads the conversation so far with your next message.'));
      m.classList.add('vendor');
      for (const o of to.models) {
        const efforts = norm(o.efforts).filter((e) => e.value);
        const pick = (effort) => vscode.postMessage({ type: 'switchVendor', sid: t.id, kind: to.kind, model: o.value, effort });
        const sub = efforts.length ? (sm) => {
          sm.append(el('div', 'h', o.label + ' effort'));
          sm.append(el('div', 'note', 'Click the model itself for ' + (o.defaultEffort ? 'its default, ' + cap(o.defaultEffort) + '.' : 'the model\\'s default.')));
          for (const e of efforts) sm.append(item(cap(e.label), { pick: () => pick(e.value) }));
        } : null;
        m.append(item(o.label, { hint: o.value, disabled: busy, submenu: sub, pick: () => pick('') }));
      }
    });
  }
  $mClaude.title = 'Continue on Claude'; $mCodex.title = 'Continue on Codex';
  $mClaude.addEventListener('click', (e) => { e.stopPropagation(); vendorMenu($mClaude); });
  $mCodex.addEventListener('click', (e) => { e.stopPropagation(); vendorMenu($mCodex); });
  for (const b of [$mClaude, $mCodex]) b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      const m = vendorMenu(b), first = m && m.querySelector('.it:not(.dis)'); if (first) first.focus();
    }
  });
  // the compact reading and "usage" open the same panel; refresh and login are buttons in it
  $mu.addEventListener('click', () => { const t = cur(); if (t) togglePlan(t.id); });
  $mu.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const t = cur(); if (t) togglePlan(t.id); } });

  window.addEventListener('message', (e) => {
    const m = e.data; if (!m) return;
    if (m.type === 'tabs') { if (m.gateway) gatewayInfo = m.gateway; applyTabs(m.tabs, m.active, m.single); }
    else if (m.type === 'event') onEvent(m.sid, m.ev);
    else if (m.type === 'meter') { meters.claude = m.meter || null; if ('codex' in m) meters.codex = m.codex || null; applyMeter(); }
    else if (m.type === 'subagentUsage') { const p = panes.get(m.sid); if (p) { p.mxData = m; if (p.mxOpen) drawUsage(p); } }
    else if (m.type === 'indexStatus') { const p = panes.get(m.sid); if (p) { p.ixData = m; if (p.ixOpen) drawIndex(p); } }
    else if (m.type === 'commands') { commands[m.kind] = m.list || []; syncComposer(); }
  });
  $send.innerHTML = SVG.up;
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

module.exports = { getHtml };
