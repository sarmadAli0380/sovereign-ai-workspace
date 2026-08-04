# Sovereign AI Roadmap — Phase 1 Harness

## Project state

This repo is currently 100% design, zero code. Every file under
`phase1/adrs/` and `phase1/phase1-model-agnostic-harness-expanded.md` is a
**decided** design, not a proposal — don't re-litigate them unless you find
something factually wrong (e.g. an API that's changed or no longer
exists). Your job is to implement what they describe, not redesign it.

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

## What to build, in order

1.2 → 1.4 → 1.5 → 1.6 can be built roughly in that order (1.5 and 1.6 are
independent of each other and of 1.4, except where they compose later).
1.7 needs all four finished first.

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
- **1.7** — the capstone. This needs an orchestration loop that doesn't
  exist in any doc yet — the piece that calls `loadModel()`, runs
  `ConversationManager` + `dispatchToolCall` together, and drives a full
  request → response → tool-call → response cycle. Build that fresh, then
  refactor a real project onto the harness and demo a provider swap via
  one config edit, zero code changes.

## Open question for 1.7 — ask the user, don't guess

The original plan targeted "the Pi agent project" as the refactor target,
assuming it has direct provider API calls to replace with harness calls.
But that project is itself likely built on `pi-ai` / `pi-coding-agent`
already, so it may never have had raw API calls to strip out — the
harness's actual value-add over what it already has would be
`ConversationManager`, `ToolRegistry`/`dispatchToolCall`, and
config-driven routing, not "remove direct API calls." Ask which target
project to use and what the before/after comparison should actually
demonstrate before starting 1.7 — don't assume the original framing still
fits.

## Known gotcha (found the hard way — see `findings-log.md`)

`pi-ai`'s own README examples use a flat `getModel()`. That function only
exists via the deprecated `/compat` subpath (explicit `@deprecated` in
source, pointing at `createModels()`/provider factories as current). Use
`createModels()` / `builtinModels()` and the `Models` interface
everywhere — not the flat deprecated function, even though the README
shows it first.

## Verification requires real API keys

Every doc in `phase1/adrs/` is flagged research-stage, not run — none of
this has been executed against a real model yet. You'll need
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment to actually
prove any of it works. If you don't have them, still build everything,
but clearly flag what's implemented-but-unverified rather than silently
skipping the proof step or claiming something works when it hasn't been
run.

## Process notes

- Log real findings (what you learn while implementing, any decisions you
  have to make that weren't already pinned down) into `findings-log.md`
  in the same style as the existing entries — don't scatter new
  standalone summary files instead.
- Pick a sensible code location. This repo has been docs-only
  (`phase1/adrs/`) so far — put implementation code somewhere clearly
  separated from the design docs (e.g. a top-level `src/` or
  `packages/harness/`), with `node_modules` properly gitignored inside an
  actual git repo, not left dangling.
- Don't re-decide things already decided in the ADRs (routing shape,
  error handling, parallel execution, truncation ownership, etc.). If you
  think one is actually wrong, flag it and explain why rather than
  silently changing it.
