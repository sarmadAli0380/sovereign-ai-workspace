# Sovereign AI Roadmap — Phase 1 Harness

## Project state

**Phase 1 and Phase 2 are complete and verified against two live
providers.** This file used to say "100% design, zero code"; that has not
been true since 2026-08-03. `src/` holds the harness, `scripts/` the
verification and sizing tools, `phase1/adrs/` and `phase2/adrs/` the
decided designs behind them.

Those ADRs remain **decided** rather than proposals — don't re-litigate one
unless you find it factually wrong, and several now carry dated corrections
where exactly that happened. Phases 3–5 of `00-original-roadmap.md` are
untouched.

## Read these first, in order

1. `00-original-roadmap.md` — the full five-phase plan, for context on
   where Phase 1 fits. Only Phase 1 is in scope right now.
2. `phase1/phase1-model-agnostic-harness-expanded.md` — task-by-task
   breakdown (1.1–1.7), each with a "revised" section pointing at the ADR
   that has the actual decided shape.
3. `findings-log.md` — the "why" behind every decision, including
   corrections found mid-project. Read this even if you skim the ADRs —
   it has context the ADRs don't repeat.
4. Then, in this order: `phase1/adrs/1.2-schema-ontology-mapping.md`,
   `1.4-config-routing-design.md`, `1.5-conversation-manager-design.md`,
   `1.6-tool-calling-design.md` — these are what you're building.

`ADR-002-hybrid-pi-ai-litellm-gateway.md` is the load-bearing decision
underneath everything: the harness is built on `@earendil-works/pi-ai`,
not a custom shim or LiteLLM directly.

## What exists

All of the below is built, tested and run. Kept as a map of what each
piece is *for* — the original "what to build" instructions are in git
history if you need them.

| | file | |
|---|---|---|
| 1.2 | `types.ts`, `harness-result.ts`, `validate-context.ts` | ontology + pre-flight guard |
| 1.4 | `config.ts`, `load-model.ts` | configKey → model, one lookup |
| 1.5 | `conversation-manager.ts`, `truncation.ts` | conversation state, budget, truncation |
| 1.6 | `tool-registry.ts` | registry + parallel dispatch |
| 1.7 | `step.ts` | one transition; the caller owns iteration |
| 1.8 | in `conversation-manager.ts` | budget anchored on measured input |
| 2.4 | `sizing.ts`, `scripts/size-model.ts` | memory sizing from measurement |
| 2.5 | `openai-compatible.ts` | any `/v1` server, from JSON |

The original per-task briefs, still accurate as intent:

- **1.2** — mostly wiring, not building. Use `pi-ai`'s own `Context` /
  `Message` / `AssistantMessage` / `ToolResultMessage` / `Usage` types
  directly, don't reinvent them. The only new code is the `HarnessResult`
  wrapper (`{ message, configKey, routedVia, latencyMs }`) and a
  `validateContext()` pre-flight guard (empty messages, malformed tool
  schema, unknown config key).
- **1.4** — a config file (`model.config.json` or `.ts`) with `provider` /
  `modelId` / `maxTokens` / `temperature` per configKey. No
  `api_key_env`, no `fallbackConfigKey`, no `routedVia` field —
  deliberately deferred, see the doc for why. `loadModel(configKey)`
  resolves through `pi-ai`'s `createModels()` / `builtinModels()`
  registry.
- **1.5** — `ConversationManager`: a stateful class wrapping one
  `Context`. Methods: `append()`, `getHistory()`, `getContext()`.
  Truncation runs on every `append()`, via a pluggable
  `TruncationStrategy` interface — ship with drop-oldest as the default,
  and never split a tool-call from its tool-result. Also caps
  `ToolResultMessage.content` size on append (`maxToolResultChars`),
  separate from whole-conversation truncation. The exact drop-oldest
  cut-point algorithm and default numbers for `reserveTokens` /
  `maxToolResultChars` aren't finalized — pick reasonable defaults and
  mark them clearly in code comments as tunable, not settled.
- **1.6** — `ToolRegistry` (toolName → `{ definition, handler }`) plus
  `dispatchToolCall` / `dispatchToolCalls`. Auto-wrap thrown handler
  errors into `isError` results. Run multiple tool calls in one turn in
  parallel via `Promise.allSettled`. Keep dispatch decoupled from
  `ConversationManager` — it returns `ToolResultMessage[]`, it does not
  append them itself.
- **1.7** — see the section below. The refactor half was retired with
  evidence; the composition half shipped as `step()`.

## 1.7 is closed — the open question was answered

This section used to say "ask the user which project to refactor, don't
guess." **That question was settled on 2026-07-30 and 1.7 is complete
(2026-08-05).** Read `phase1/adrs/1.7-integration-and-comparison.md` rather
than re-opening it.

The short version: the intended target (`local-pi`) was checked and had
**zero** direct provider API calls to remove — it is already built on
`pi-coding-agent`, which supplies session management, an agent loop and
model resolution in more capable form, and its provider swap was already a
one-line config edit. A refactor would have deleted working code and made
the target worse. Decision with the user: don't do it.

1.7 became two deliverables instead — `scripts/verify-swap.ts` (the live
swap proof, now run genuinely cross-provider against `openai-codex` vs
`ollama`) and a written comparison of where this harness sits relative to
`pi-coding-agent`. Both done.

The composition piece that *was* missing, `step()`, now exists in
`src/step.ts`. It is deliberately one transition rather than a loop — the
caller owns iteration — and it is the single place that turns a failure
into a `HarnessResult` with `stopReason: "error"`.

## Known gotcha (found the hard way — see `findings-log.md`)

`pi-ai`'s own README examples use a flat `getModel()`. That function only
exists via the deprecated `/compat` subpath (explicit `@deprecated` in
source, pointing at `createModels()`/provider factories as current). Use
`createModels()` / `builtinModels()` and the `Models` interface
everywhere — not the flat deprecated function, even though the README
shows it first.

## Verification

Two providers are wired and working: `openai-codex` (OAuth, credential in
`.harness-credentials.json`, **expires** — re-run `node scripts/login.ts
openai-codex`, which needs the user at a browser) and `ollama` (needs
`ollama serve`). See `SESSION-HANDOFF.md` for the run commands.

The standard this project holds itself to: **mark claims `[VERIFIED]` /
`[UNVERIFIED]`, and separate decisions from facts.** If you cannot run
something, say it is implemented-but-unverified rather than skipping the
proof quietly or claiming it works.

## Read `lessons.md` before writing code

`lessons.md` records the recurring *authorial* failure modes on this
project — guards written against an earlier draft of the value, unions
whose sibling fields get scored at zero, `NaN` sailing past `<= 0`,
verification harnesses that quietly test nothing, and test fixtures blamed
on the implementation. Each entry has the concrete check that catches it,
and there is a pre-flight checklist at the bottom.

It is deliberately separate from `findings-log.md`: that one holds what was
learned about the world (pi-ai, providers, hardware), this one holds how the
code got written wrong. Add to it when you catch yourself repeating a
mistake — the entries earn their place by having actually shipped.

## Process notes

- Log real findings (what you learn while implementing, any decisions you
  have to make that weren't already pinned down) into `findings-log.md`
  in the same style as the existing entries — don't scatter new
  standalone summary files instead.
- Code lives in `src/` (library) and `scripts/` (executables), separate
  from the design docs. Tests sit beside their subject as `*.test.ts` and
  run with `npm test`.
- Don't re-decide things already decided in the ADRs (routing shape,
  error handling, parallel execution, truncation ownership, etc.). If you
  think one is actually wrong, flag it and explain why rather than
  silently changing it.
