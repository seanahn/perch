# 114 — Testing

| Suite | What it runs | Model calls |
| --- | --- | --- |
| `test/meter.test.js` | Usage, cost, the switch, in throwaway homes and four timezones | no |
| `test/gateway.test.js` | The gateway file: parsing, what makes it usable, the template, in a throwaway directory | no |
| `test/relay.test.js` | The relay, against a stand-in gateway on the loopback interface: forwarding, streaming, headers read, errors passed on, a gateway that is down | no |
| `test/codexMeter.test.js` | Codex usage, in throwaway session directories | no |
| `test/models.test.js` | Catalog and command parsing | no |
| `test/voice.test.js` | The engine, against a stand-in server | no |
| `audio/test/recorder.test.js` | The recorder and its commands, with a library that plays back frames | no |
| `test/host.test.js` | The host, against a stubbed VS Code API and stand-in agents | no |
| `test/page.test.js` | The real page script, in jsdom | no |
| `test/harness.mjs` | Live: both agents, catalogs, usage, queueing | **yes** |

`make test-offline` runs the first nine. `make test` runs all ten.

## Rules learned the hard way

1. **Assert on what is rendered, not on attributes.** A test checked the
   `hidden` attribute while a `display: flex` rule overrode it, so every
   pane drew on top of the others and the test passed. It now checks
   computed style.
2. **`set -o pipefail` before any pipeline that gates a commit.** A
   failing suite was piped through a filter, the filter's status won,
   and a commit went in with a test failing.
3. **The page script lives in a template literal.** An escape written one
   level short, `\n` for `\\n`, becomes a raw line break inside a string
   and the script does not parse. The page test checks parsing first and
   names this cause.
4. **Never exercise the real backend switch.** It writes the user's
   Claude settings. The suite compares that file before and after.
5. **Do not call the usage endpoint in a loop.** It rate-limits. The live
   check treats a rate limit as a skip.
6. **Kill test processes by name, not by pattern.** A pattern that
   appears in the command that runs it matches that command's own shell.
7. **Anchor time-dependent tests to local noon.** "Today" is a local
   notion, and a fixed UTC instant lands on different days.
8. **A stand-in must behave like the real thing.** A stand-in server that
   answered requests concurrently produced failures the real server
   cannot.
9. **Point the tests at a gateway file of their own.** The default path
   is a real file on the developer's machine; a host test read it and
   found a gateway on offer that the test had not made. The stub now
   names a path that does not exist, and the gateway tests write their
   own file in a throwaway directory.
10. **Probe the CLI from a clean environment.** A probe run from inside a
    Claude Code session inherits its variables (`CLAUDECODE`,
    `CLAUDE_CODE_CHILD_SESSION`, its effort), and the CLI it started
    answered `supportedModels()` without the `default` entry, which
    looked like a finding about the SDK. Probes now run under `env -i`
    with only `HOME`, `PATH`, `USER` and `LANG`.
