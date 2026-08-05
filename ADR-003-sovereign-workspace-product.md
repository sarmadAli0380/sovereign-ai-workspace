# ADR-003 — The deliverable is a sovereign AI workspace, built from scratch

**Status:** Decided with the user, 2026-08-05
**Supersedes:** the framing of `00-original-roadmap.md`, and 1.7's
"the harness's value is subtraction" positioning
**Sits alongside:** ADR-002 (built on `@earendil-works/pi-ai`)

## Why this exists

Every design doc in this repo describes **a component**: "an abstraction
layer that swaps between hosted APIs and self-hosted models without touching
business logic." 1.7 went further and defined the harness's value as
*subtraction* — a model call with nothing attached, explicitly declining to
build an agent loop or a tool suite.

That is not what the project is for. Stated by the user, 2026-08-05:

> a sovereign harness layer like Claude is, which is fully built by us and
> has the model agnostic capability — imagine the Claude desktop app but all
> the data is retained on enterprise servers, not in foreign databases;
> model agnostic so LLMs can be changed according to client demands. The
> harness needs to be such a good model agnostic that any LLM can be
> integrated without flakiness.

So the deliverable is **a product**, and the harness is its engine rather
than the end goal. The docs described the engine and called it the car.

## What is being built

A self-hosted AI workspace a client runs entirely on their own
infrastructure:

- **Chat, agents and tools** — the working surface. An agent loop, built-in
  tools, MCP, file handling.
- **All data resident on the client's servers** — conversations, messages,
  attachments, embeddings, logs. Nothing in a foreign database, and for
  some clients nothing leaving the network at all.
- **Model-agnostic to the point of being boring** — swap the LLM per client
  requirement, hosted or self-hosted, without the swap being a project.
- **Auditable** — who asked what, when, against which model.

**Deployment shape:** server plus web UI first, both inside the client's
network. A desktop client later, once the core is proven. Decided with the
user, 2026-08-05.

## Decision 1 — build it ourselves

Surveyed the field before deciding. Recorded because the licence findings
are worth keeping regardless of which way we went:

| project | licence | white-label to a client? |
|---|---|---|
| LibreChat | MIT | yes |
| AnythingLLM | MIT | yes |
| Jan | Apache-2.0 (GitHub mislabels it) | yes |
| Open WebUI | modified BSD-3 | **no** — branding must remain in any deployment |
| LobeChat | Apache + conditions | **no** — commercial licence required to distribute a derivative |
| Dify | Apache + conditions | **no** — logo cannot be removed from the frontend |
| odysseus | AGPL-3.0 | source rights pass to the client; distributed changes must be published |

Note the shape of that table: the three largest projects by stars (Dify
151k, Open WebUI 148k, odysseus 85k) are all **unusable for white-labelled
client delivery**. Popularity and licence suitability are unrelated.

Forking LibreChat was the recommended option and was **not** taken. The
user's reasoning, accepted: the differentiator has to be ours. A fork means
either living with someone else's model layer — the exact layer this
project exists to be better at — or replacing it and diverging from upstream
permanently.

**Decision: implement everything ourselves.** The cost is understood and
real: this is many months of work, and most of it (UI, storage, auth,
files) is not the model-agnostic part. Recorded here so nobody later
mistakes the timeline for a surprise.

## Decision 2 — how we use other projects

They are **reference material, not a source of code**.

- **Take:** what features exist and why, and how a specific bug was solved.
- **Never take:** code, file structure, or the shape of an implementation.
- **Prefer permissive sources for close reading.** MIT and Apache-2.0
  (LibreChat, AnythingLLM, Jan) are low-risk to read carefully. For AGPL or
  restricted-licence projects (odysseus, Dify, LobeChat), take the
  *observation* and not the structure — features and facts are ideas, code
  is expression, and only the second is copyrightable.
- **Record every borrowing** in `findings-log.md`, naming the source.

There is already a worked precedent. From odysseus we took the finding that
*usage absence is a per-response transport event rather than a provider
property* — a fact about how providers behave, learned from the existence of
their regression test. It changed our Decision A in 1.8. No code moved, the
source is cited, and the reasoning is ours. That is the standard.

## Decision 3 — 1.7's "subtraction" positioning is retired

1.7 concluded the harness should stay deliberately small, and that building
an agent loop would push it into competing with `pi-coding-agent`. **That
reasoning was correct for a library and is wrong for a product.** A
Claude-like workspace needs precisely the things that ADR declined to
build.

What survives from 1.7, and is still right:

- `step()` stays a **single transition**. The agent loop is built *on top*
  of it, not instead of it. The stopping rule stays inspectable, and the
  primitive stays available to any application that wants one call.
- The comparison with `pi-coding-agent` remains accurate about altitude —
  we are simply now building at the higher altitude too.

What changes: the harness is the product's runtime engine, and an agent
loop, a tool suite and MCP support are now in scope.

## Decision 4 — the differentiator is conformance evidence

"Any LLM without flakiness" is not a feature that gets written once. It is
a **conformance program**, and everything measured on this project says so:

- `openai-codex` accepts `maxTokens` and silently ignores it
- Ollama accepts `max_completion_tokens` and does nothing with it
- `qwen3:4b` advertises 262,144 context and is served 4,096
- reasoning content is replayed by one provider, discarded by another, and
  it varies by message shape
- usage reporting can be dropped by the transport rather than the provider

The competing pattern is one hand-written adapter per provider — AnythingLLM
carries **thirty-plus** of them. Breadth by adapter count is breadth by
places-to-be-silently-wrong.

**Decision: a model is not "supported" until it passes a conformance
suite**, and the suite's output is a client-facing artifact. The claim we
want to be able to make is not "we support many models" but "these models
are verified, on this date, against these checks."

`scripts/verify-live.ts`, `scripts/verify-swap.ts` and
`scripts/size-model.ts` are the beginning of that suite, and
`findings-log.md`'s catalogue of provider lies is its specification.

## What this changes in the repo

- `00-original-roadmap.md` is kept as history; `product-roadmap.md`
  supersedes it.
- `phase1/adrs/1.7-integration-and-comparison.md` — positioning superseded
  here; its evidence and its `step()` decision stand.
- `CLAUDE.md` — project state rewritten to describe a product.

## What does NOT change

Phases 1 and 2 were not wasted and are not being rewritten. Config-driven
routing, conversation state and budgeting, tool dispatch, generic
OpenAI-compatible provider registration, and the sizing math are all correct
foundations for the product. The harness stops being the destination and
becomes the engine.
