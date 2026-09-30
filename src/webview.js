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
  @keyframes spin { to { transform: rotate(360deg); } }
  .msg { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  /* a message of the user's stands apart from the answers: to the right, a filled tint of the foreground so it shows in any theme, and space above it that marks where a turn begins */
  .user { margin: 18px 0 10px auto; width: fit-content; max-width: 88%; padding: 8px 12px; background: color-mix(in srgb, var(--vscode-foreground) 9%, var(--vscode-editor-background)); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); border-radius: 12px 12px 4px 12px; }
  .user:first-child { margin-top: 4px; }
  .user.queued { opacity: .75; border-style: dashed; }
  .user .tag { float: right; font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
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
  /* A long result is clipped, and does not take the wheel: scrolling the transcript passes over it. A click opens it to scroll on its own; another closes it. */
  .toolres { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-panel-border); max-height: 8em; overflow: hidden; position: relative; }
  .toolres.more { cursor: pointer; }
  .toolres.more::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2.5em; background: linear-gradient(to bottom, transparent, var(--vscode-sideBar-background, var(--vscode-editor-background))); pointer-events: none; }
  .toolres.open { overflow: auto; cursor: auto; }
  .toolres.open::after { content: none; }
  .toolres.err { border-left-color: var(--vscode-charts-red); color: var(--vscode-errorForeground); }
  .status { color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center; }
  .error { color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-charts-red); }
  .result { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: right; }
  .perm { border: 1px solid var(--vscode-inputValidation-warningBorder); background: var(--vscode-inputValidation-warningBackground); }
  .perm .btns { display: flex; gap: 6px; margin-top: 6px; }
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
  .ask .btns button { font-size: 11px; padding: 3px 12px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .ask .btns button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
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
  #menu { position: fixed; z-index: 10; min-width: 190px; max-width: min(340px, calc(100vw - 16px)); overflow-y: auto; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 12px; }
  #menu .h { padding: 5px 8px 3px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  #menu .note { padding: 5px 8px; color: var(--vscode-descriptionForeground); white-space: normal; }
  #menu .it { display: grid; grid-template-columns: 14px 1fr auto; column-gap: 6px; align-items: baseline; padding: 4px 8px; border-radius: 5px; cursor: pointer; }
  #menu .it:hover, #menu .it.cur { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
  #menu .it.dis { opacity: .45; cursor: default; pointer-events: none; }
  #menu .it .ck { color: var(--accent, currentColor); }
  #menu .it .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  #menu .it .d { grid-column: 2 / 4; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: normal; }
  #menu .filter { width: 100%; box-sizing: border-box; margin-bottom: 4px; padding: 4px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; outline: none; }
  #menu .row { display: flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 5px; cursor: pointer; }
  #menu .row:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }

  /* Claude usage and backend */
  #meter { display: flex; align-items: center; gap: 6px; padding: 2px 10px 6px; font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
  #meter .k { width: 12px; height: 12px; }
  #m-claude, #m-codex { flex: none; display: inline-flex; }
  #meter .plan { flex: none; padding: 0 6px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); text-transform: capitalize; }
  #meter .where { flex: none; display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; }
  #meter .where svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  #meter .mb { flex: none; padding: 0 6px; font-size: 11px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); background: none; color: inherit; }
  #meter .mb:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
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
  <div id="meter" hidden><span id="m-where" class="where" hidden></span><span id="m-claude">${badge('claude')}</span><span id="m-codex" hidden>${badge('codex')}</span><button id="m-backend" class="mb"></button><span id="m-plan" class="plan" hidden></span><span id="m-usage" class="mu" role="button" tabindex="0"></span></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const $tabs = $('tabs'), $add = $('add'), $panes = $('panes'), $empty = $('empty');
  const $composer = $('composer'), $input = $('input'), $send = $('send');
  const $tAdd = $('t-add'), $tSlash = $('t-slash'), $tCtx = $('t-ctx'), $tCache = $('t-cache'), $tModel = $('t-model'), $tMode = $('t-mode'), $tIde = $('t-ide'), $tMic = $('t-mic'), $sep = document.querySelector('#tools .sep'), $where = $('m-where');
  const panes = new Map();   // sid -> pane state
  const commands = { claude: [], codex: [] };
  let tabs = [], active = null, menu = null, menuOwner = null;
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
    laptop: '<svg viewBox="0 0 16 16"><rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.500h13"/></svg>',
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
  $where.innerHTML = SVG.laptop; $where.append(el0('span', 'Work locally')); $where.title = 'Perch runs Codex on this machine, through the Codex SDK. Cloud tasks are not available here.';
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
  /** What a tool call's copy button copies: the command itself when there is one, otherwise the input as shown. */
  function commandOf(input) { if (input && typeof input.command === 'string') return input.command; if (input && Array.isArray(input.command)) return input.command.join(' '); return fmtIn(input); }

  function el(tag, cls, text) { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; }
  function fmtIn(v) { try { const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch (_) { return String(v); } }
  const usd = (n) => (Number(n) >= 1 ? Number(n).toFixed(2) : Number(n).toFixed(3));   // a turn is often cents
  function fmtTok(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
  const cur = () => tabs.find((t) => t.id === active) || null;

  // vendor icon when its extension is installed; a letter otherwise, or if the image fails to load
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
    root.append(log, work); $panes.append(root);
    const p = { root, log, work, what, took, doing: '', asking: 0, live: null, liveText: '', tools: {}, draft: '', shots: [], kind: tab.kind, stick: true };
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
    } else { p.doing = ''; p.asking = 0; }
    if (was !== p.work.hidden) pin(p);
  }
  setInterval(() => { if (active) syncWork(active); }, 1000);

  function pin(p) { if (p.stick) p.log.scrollTop = p.log.scrollHeight; }
  function add(p, cls, text) { const d = el('div', 'msg ' + cls, text); p.log.append(d); pin(p); return d; }
  function endLive(p) { if (p.live) { p.live.remove(); p.live = null; } p.liveText = ''; }

  // ---- tabs
  function renderTabs() {
    $tabs.querySelectorAll('.tab').forEach((n) => n.remove());
    for (const t of tabs) {
      const d = el('div', 'tab' + (t.id === active ? ' active' : '') + (t.busy ? ' busy' : '') + (t.attention ? ' attn' : ''));
      d.title = t.title + ' · ' + t.kind + ' · double-click to rename';
      const k = badge(t.kind), tt = el('span', 't', t.title), b = el('span', 'b'), x = el('span', 'x', '×');
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
    for (const [id, p] of panes) if (!ids.has(id)) { p.root.remove(); panes.delete(id); voice.delete(id); }
    for (const t of tabs) { const p = panes.get(t.id) || makePane(t); p.root.hidden = t.id !== active; syncWork(t.id); }
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
    $tSlash.hidden = !claude || !commands.claude.length;
    $tCtx.hidden = !claude; $tCache.hidden = !claude;
    if (!t) { syncVoice(); $tModel.querySelector('.m').textContent = ''; $tModel.querySelector('.e').textContent = ''; $tMode.textContent = ''; $send.disabled = true; $send.className = ''; $send.innerHTML = SVG.up; return; }

    const model = resolved(t.models, t.model) || (claude ? 'Claude' : 'Codex');
    const hasEffort = (t.efforts || []).length > 1, effort = hasEffort ? cap(resolved(t.efforts, t.effort)) : '';
    $tModel.querySelector('.m').textContent = model;
    $tModel.querySelector('.e').textContent = effort;
    $tModel.title = (t.actualModel ? 'Running ' + t.actualModel + '. ' : '') + (t.backend ? 'Backend: ' + (t.backend === 'api' ? 'API / Bedrock' : 'subscription') + '. ' : '')
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
  $input.addEventListener('keydown', (e) => {
    if (menu && menuOwner === 'slash' && (e.key === 'Enter' || e.key === 'Tab')) { const first = menu.querySelector('.it:not(.dis)'); if (first) { e.preventDefault(); first.click(); return; } }
    if (e.key === 'Escape' && menu) { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Escape' && dictating()) { e.preventDefault(); vscode.postMessage({ type: 'voiceCancel' }); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $input.addEventListener('input', () => {
    grow();
    const t = cur(), m = /^\\/(\\S*)$/.exec($input.value);
    if (t && t.kind === 'claude' && m && commands.claude.length) openSlash(m[1], true);
    else if (menuOwner === 'slash' && menu && menu.dataset.typed) closeMenu();
  });
  $tAdd.addEventListener('click', () => { if (cur()) vscode.postMessage({ type: 'attach', sid: active }); });
  $tIde.addEventListener('click', () => { const t = cur(); if (t) vscode.postMessage({ type: 'setIde', sid: t.id, value: !t.ide }); });

  // ---- menus
  function closeMenu() { if (menu) { menu.remove(); menu = null; menuOwner = null; } }
  function openMenu(owner, anchor, fill) {
    if (menu && menuOwner === owner && !menu.dataset.typed) { closeMenu(); return null; }
    closeMenu();
    menu = el('div'); menu.id = 'menu'; menu.setAttribute('role', 'menu'); menuOwner = owner;
    const t = cur(); if (t) menu.style.setProperty('--accent', t.kind === 'claude' ? '#D97757' : '#10a37f');
    fill(menu);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect(), up = r.top > window.innerHeight / 2;
    menu.style.maxHeight = Math.max(120, (up ? r.top : window.innerHeight - r.bottom) - 12) + 'px';
    if (up) menu.style.bottom = (window.innerHeight - r.top + 4) + 'px'; else menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    return menu;
  }
  function item(label, o) {
    const n = el('div', 'it' + (o.checked ? ' on' : '') + (o.disabled ? ' dis' : '')); n.setAttribute('role', o.radio ? 'menuitemradio' : 'menuitem');
    if (o.radio) n.setAttribute('aria-checked', String(!!o.checked));
    n.append(el('span', 'ck', o.checked ? '✓' : ''), el('span', 'l', label), el('span', 'hint', o.hint || ''));
    if (o.desc) n.append(el('span', 'd', o.desc));
    if (!o.disabled) n.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); o.pick(); });
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
      for (const [kind, label] of [['claude', 'New Claude tab'], ['codex', 'New Codex tab']]) {
        const row = el('div', 'row'); row.append(badge(kind), label);
        row.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); vscode.postMessage({ type: 'new', kind }); });
        m.append(row);
      }
    });
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (menu) closeMenu(); else if (dictating() && e.target !== $input) vscode.postMessage({ type: 'voiceCancel' }); });
  $('e-claude').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'claude' }));
  $('e-codex').addEventListener('click', () => vscode.postMessage({ type: 'new', kind: 'codex' }));

  // ---- transcript events
  function onEvent(sid, m) {
    const p = panes.get(sid); if (!p) return;
    // what it is doing now, for the line at the foot of the transcript
    const doing = { delta: 'Writing', text: 'Working', thinking: 'Thinking', tool_result: 'Working', user: 'Working' }[m.kind];
    if (doing) p.doing = doing; else if (m.kind === 'tool_start' || m.kind === 'tool_use') p.doing = 'Running ' + m.name;
    if (m.kind === 'permission' || m.kind === 'question') p.asking++; else if (m.kind === 'clear') { p.asking = 0; p.doing = ''; }
    if (m.kind === 'voice') { if (m.phase === 'idle') voice.delete(sid); else voice.set(sid, m); if (sid === active) syncComposer(); return; }
    switch (m.kind) {
      case 'user': {
        endLive(p); const d = add(p, 'user' + (m.queued ? ' queued' : ''), '');
        const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((t) => typeof t === 'string' && /^data:image\\/(png|jpeg|webp);base64,/.test(t)) : [];
        const unseen = (m.images || 0) - thumbs.length;    // images with no thumbnail are counted instead
        const tags = [m.queued ? 'queued' : '', unseen > 0 ? unseen + (unseen > 1 ? ' images' : ' image') : '', m.tag || ''].filter(Boolean);
        if (tags.length) d.append(el('span', 'tag', tags.join(' · ')));
        if (thumbs.length) { const row = el('div', 'pics'); for (const t of thumbs) { const i = document.createElement('img'); i.src = t; i.alt = 'pasted image'; i.title = 'Click to see it larger'; i.addEventListener('click', () => { i.classList.toggle('big'); i.title = i.classList.contains('big') ? 'Click to shrink it' : 'Click to see it larger'; }); row.append(i); } d.append(row); }
        d.append(m.text); break; }
      case 'delta': if (!p.live) p.live = add(p, 'assistant md live', ''); p.liveText += m.text; p.live.textContent = ''; p.live.append(drawn(p.liveText)); copyable(p.live); break;
      case 'text': { endLive(p); const d = add(p, 'assistant md', ''); d.append(drawn(m.text)); copyable(d); break; }
      case 'thinking': endLive(p); add(p, 'thinking', m.text.length > 400 ? m.text.slice(0, 400) + '…' : m.text); break;
      case 'tool_use': { endLive(p); if (m.name === 'AskUserQuestion' && m.input && Array.isArray(m.input.questions)) { answered(add(p, 'ask done', ''), m.input.questions, null); break; }   // the question itself follows, or its answers did
        const d = add(p, 'tool', ''); d.append(el('span', 'name', m.name + (m.status ? ' · ' + m.status : '')), el('div', 'in', fmtIn(m.input)), copyButton(() => commandOf(m.input))); if (m.id) p.tools[m.id] = d; break; }
      case 'tool_result': {
        const d = add(p, 'toolres' + (m.isError ? ' err' : ''), (m.text || '(no output)') + (m.truncated ? '\\n…' : ''));
        const a = p.tools[m.id]; if (a && a.nextSibling !== d) a.after(d);
        if (d.scrollHeight > d.clientHeight + 1 || (m.text || '').split('\\n').length > 8) d.classList.add('more');
        d.addEventListener('click', () => { if (d.classList.contains('more') && !String(window.getSelection && window.getSelection()).length) d.classList.toggle('open'); });
        break;
      }
      case 'permission': {
        endLive(p); const d = add(p, 'perm', ''); const head = el('div'); head.append(el('b', null, 'Allow '), el('span', null, m.tool), '?');
        const btns = el('div', 'btns');
        for (const [dec, label, cls] of [['allow', 'Allow', 'primary'], ['always', 'Always', ''], ['deny', 'Deny', '']]) {
          if (dec === 'always' && !m.hasSuggestions) continue;
          const b = el('button', cls, label);
          b.addEventListener('click', () => { vscode.postMessage({ type: 'permission', sid, id: m.id, decision: dec }); d.className = 'msg status'; d.textContent = m.tool + ': ' + dec; p.asking = Math.max(0, p.asking - 1); syncWork(sid); });
          btns.append(b);
        }
        d.append(head, el('div', 'in', fmtIn(m.input)), btns); p.stick = true; break; }
      case 'question': { endLive(p); asking(add(p, 'ask', ''), m, sid, p); p.stick = true; break; }
      case 'answered': { endLive(p); answered(add(p, 'ask done', ''), m.questions, m.answers || {}); break; }
      case 'result': { endLive(p); const u = m.usage || {}; const d = add(p, 'result', (m.ok ? 'done' : 'failed' + (m.error ? ': ' + m.error : '')) + (m.duration_ms ? ' · ' + (m.duration_ms / 1000).toFixed(1) + 's' : '') + (u.input !== undefined ? ' · in ' + u.input + ' · cached ' + (u.cache_read || 0) + ' · out ' + u.output : '') + (m.costTurn !== undefined ? ' · \u2248$' + usd(m.costTurn) + ' this turn' + (cur() && cur().backend === 'subscription' ? ' at API rates' : '') : ''));   // a first turn with nothing to subtract from says nothing: the session's total is in the tooltip
        if (m.cost !== undefined) d.title = (m.costTurn !== undefined ? 'This turn\\'s cost at Anthropic\\'s API list prices, as Claude Code reckons it; the session so far \u2248$' + usd(m.cost) + '.' : 'The whole conversation so far \u2248$' + usd(m.cost) + ' at Anthropic\\'s API list prices, as Claude Code reckons it; this turn\\'s own cost is shown from the next turn on.') + (cur() && cur().backend === 'subscription' ? ' On a subscription nothing is billed per token: turns count against the plan\\'s limits, shown in the footer.' : ''); break; }
      case 'note': endLive(p); add(p, 'status', m.text); break;
      case 'session': p.work.title = 'session ' + m.id; break;
      case 'error': endLive(p); add(p, 'error', m.text); break;
      case 'clear': p.log.textContent = ''; p.live = null; p.liveText = ''; p.tools = {}; p.stick = true; break;
      case 'fill': if (sid === active) { $input.value = m.text; grow(); $input.focus(); } else p.draft = m.text; break;
      case 'insert': if (sid === active) insert(m.text); else p.draft = (p.draft && !/\\s$/.test(p.draft) ? p.draft + ' ' : p.draft) + m.text; break;
    }
    syncWork(sid);
    pin(p);
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
    const send = el('button', 'primary', qs.length > 1 ? 'Answer all' : 'Answer'), skip = el('button', null, 'Skip');
    const ready = () => qs.every((q, i) => picks[i].size || others[i].trim());
    const refresh = () => { for (const f of marks) f(); send.disabled = !ready(); };
    const answers = () => { const out = {}; qs.forEach((q, i) => { out[q.question] = [...(q.options || []).filter((o) => o && picks[i].has(o.label)).map((o) => o.label), others[i].trim()].filter(Boolean).join(', '); }); return out; };
    const finish = (decision) => {
      vscode.postMessage(decision === 'answer' ? { type: 'permission', sid, id: m.id, decision, answers: answers() } : { type: 'permission', sid, id: m.id, decision });
      d.textContent = '';
      if (decision === 'answer') { d.className = 'msg ask done'; answered(d, qs, answers()); } else { d.className = 'msg status'; d.textContent = 'question skipped'; }
      p.asking = Math.max(0, p.asking - 1); syncWork(sid);
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
      const inp = el('input', 'other'); inp.type = 'text'; inp.placeholder = q.multiSelect ? 'Something else, as well or instead…' : 'Something else…';
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
  const $meter = $('meter'), $mb = $('m-backend'), $mu = $('m-usage'), $mClaude = $('m-claude'), $mCodex = $('m-codex'), $plan = $('m-plan');
  const meters = { claude: null, codex: null };
  let meter = null, meterKind = null;
  function applyMeter() {
    const t = cur();
    meterKind = t ? t.kind : null;
    meter = meterKind ? meters[meterKind] : null;
    $meter.hidden = !meter;
    if (!meter) return;
    const claude = meterKind === 'claude';
    $mClaude.hidden = !claude; $mCodex.hidden = claude; $mb.hidden = !claude; $where.hidden = claude;
    $plan.hidden = claude || !meter.plan; $plan.textContent = meter.plan || ''; $plan.title = meter.plan ? 'ChatGPT plan: ' + meter.plan : '';
    if (claude) {
      $mb.textContent = meter.backendLabel + (meter.backendWarn ? ' \u26A0' : '');
      $mb.className = 'mb' + (meter.backendWarn ? ' warn' : '');
      $mb.title = meter.backendTitle;
    }
    $mu.textContent = '';
    $mu.className = 'mu ' + meter.level + (meter.stale ? ' stale' : '');
    if (meter.segments.length) for (const seg of meter.segments) { const n = el('span', 'seg ' + seg.level, seg.text); if (seg.title) n.title = seg.title; $mu.append(n); }
    else $mu.append(el('span', 'seg none', meter.action === 'login' ? 'log in' : '\u2014'));
    const time = meter.fetchedAt ? new Date(meter.fetchedAt).toLocaleTimeString() : '';
    const when = !time ? '' : meter.asOf ? 'As of the last Codex turn on this machine, ' + time + '. ' : 'Updated ' + time + '. ';
    const hint = meter.action === 'login' ? 'Click to log in.' : 'Click to refresh.';
    const stale = meter.stale ? '\\n' + meter.lines[meter.lines.length - 1] : '';
    if (!meter.segments.some((x) => x.title)) $mu.title = meter.lines.join('\\n') + '\\n' + when + hint;
    else { $mu.title = ''; for (const n of $mu.children) n.title += stale + '\\n' + when + hint; }
  }
  $mb.addEventListener('click', () => vscode.postMessage({ type: 'meterToggle' }));
  $mu.addEventListener('click', () => vscode.postMessage(meter && meter.action === 'login' ? { type: 'meterLogin' } : { type: 'meterRefresh', vendor: meterKind }));

  window.addEventListener('message', (e) => {
    const m = e.data; if (!m) return;
    if (m.type === 'tabs') applyTabs(m.tabs, m.active, m.single);
    else if (m.type === 'event') onEvent(m.sid, m.ev);
    else if (m.type === 'meter') { meters.claude = m.meter || null; if ('codex' in m) meters.codex = m.codex || null; applyMeter(); }
    else if (m.type === 'commands') { commands[m.kind] = m.list || []; syncComposer(); }
  });
  $send.innerHTML = SVG.up;
  vscode.postMessage({ type: 'ready' });
})();
</script></body></html>`;
}

module.exports = { getHtml };
