# 102 — Why a shell and not an agent

An **agent** is the program that runs the loop: it decides what goes
into each request, receives the model's requests to read, run, and
edit, executes them, and feeds back the results. A **model** only
produces text. Whoever runs the loop owns the tools, the permissions,
and the cost.

perch does not run the loop. Each tab starts the vendor's agent through
the vendor's SDK and renders its event stream. This is the central
decision, and the reason is cost.

## The cost of replacing the agent

An agent does not send one request per message. It sends one per step,
and each carries the whole conversation. A 20-step task whose context
grows by about 3k tokens a step sends on the order of 930k input tokens.
Prompt caching is what makes that affordable: a cache hit is billed at
0.1 times the input rate, a write at 1.25 times.

A cache hit needs a **byte-identical prefix**. So caching is not a header
to add. It is a property of how the whole prompt is laid out and kept
stable from call to call, which only the agent controls.

| Harness, with Claude as the model | Cache markers | Prefix kept stable | Cache lifetime | Billing |
| --- | --- | --- | --- | --- |
| Claude Code | placed by the agent | yes, by design | 1 hour on a subscription | subscription, or API |
| OpenCode | first two system messages and last two conversation messages | largely: a purpose-built coding agent | 5 minutes | API, per token |
| Continue | opt-in, coarse (`cacheBehavior`) | no: context providers re-render near the front | 5 minutes | API, per token |
| Continue behind LiteLLM | injected at the gateway | no, same | 5 minutes | API, per token, capped |
| Cursor | its own, closed source | yes, measured: ~96 % of each turn read back on turns 2+ (bench 006, Bedrock Opus 5.5) | 5 minutes on Bedrock | Cursor's plans, or API |

OpenCode's row was checked against its source
(`packages/opencode/src/provider/transform.ts`, `applyCaching`). Its
caching is sound. What it lacks relative to Claude Code is the one-hour
lifetime and subscription billing, not the markers. Continue's weakness
is the prefix, which a gateway cannot repair because it sits below the
harness.

The same reasoning applies on the other side: Codex's agent manages its
own caching against OpenAI's API.

## What was claimed about Cursor, and what was measured

Until 2026-10-06 the design document and the README said a harness such as
Cursor costs "several times a terminal session", and the README's diagram
showed a harness missing the cache on every turn because it re-renders
editor state near the front of the prompt. That was reasoning from
Continue's source applied to Cursor by analogy, and the "several times"
figure had no source of its own. Two sources now exist, and they say
less than the claim did.

- **A public comparison** ([futureproofing.dev, "Claude Code vs Cursor:
  token efficiency, 2026"](https://www.futureproofing.dev/resources/ai-native-team/claude-code-vs-cursor-token-efficiency-2026))
  reports Claude Code using 33 K tokens against Cursor Agent's 188 K on
  one task, a Next.js build with Tailwind 4 and shadcn: 5.5×. Read
  closely it does not support a caching claim: it is one run by one
  developer, Claude Code on Opus against Cursor on GPT-5 (the authors
  say so, and warn against "a universal constant across every task"),
  it gives no cache hit rates and no cache-busting analysis, and it
  states that "a controlled, multi-task, peer-reviewed token benchmark
  across identical models does not exist in sourceable form".
- **A controlled measurement**, the user's bench (2026-10-06):
  Claude Code and Cursor on the same model and provider, Opus 5.5 on
  Bedrock, the same three prompts, on one price basis. Cache hits on
  turns 2+: 95 % for Claude Code, 96 % for Cursor. Model cost per run:
  $0.40 against $0.44 (tokens only), a 10 % gap, which is Cursor's
  twice-as-many tool calls (19 against 8) at cached rates, not the cache.
  An earlier 50 % figure in that bench came from pricing Opus 5.5 at Opus
  4.x list; the corrected rates fit Claude Code's own accounting to a
  cent.

So the cache is not what separates a shell from a harness: a harness
that lays its prompt out carefully, as Cursor evidently does, keeps its
prefix stable too. What separates them is the billing path (a
subscription applies only to the vendor's own agent; a harness is API
billing by construction), the agent's own prompt, tools, compaction and
permissions, and the agent's tool-call style. perch's claim is
accordingly narrower than it was: it adds nothing that could bust the
cache, which is a guarantee of not making it worse, and it keeps the
vendor's billing. The 5.5× above is a mixed-model single run and is not
cited as a multiple anywhere else in these notes.

## What follows from the decision

- perch never constructs a model request. It cannot break caching,
  because it does not take part in it.
- Permissions, memory, skills, hooks, `CLAUDE.md`, MCP servers, and
  compaction are the vendor's, unchanged.
- Two agents means two contexts. Tabs do not share history. The one
  bridge is **handoff**, which pastes a tab's last answer into another
  tab's message box. Shared context would defeat each agent's caching.
- Both agents run on the user's existing logins. That is a personal-use
  arrangement. Distributing perch to others would require API-key
  billing under both vendors' terms.
