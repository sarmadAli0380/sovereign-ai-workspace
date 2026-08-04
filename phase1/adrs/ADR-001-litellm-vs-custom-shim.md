# ADR-001: Model-Agnostic Harness — LiteLLM vs. Custom Shim

**Status:** Superseded by ADR-002 (hybrid architecture)
**Date:** 2026-07-27

## Context

Phase 1 of the sovereign AI roadmap requires an abstraction layer that swaps
between LLM providers without touching business logic, including
provider-agnostic tool-calling. Two options were considered:

1. **Custom shim** — hand-write the request/response translation and
   tool-call normalization layer.
2. **LiteLLM** — open-source Python library that already provides a unified
   `completion()` interface across 100+ providers, with tool-calling
   normalization and native MCP integration built in.

## Findings

LiteLLM's tool-calling layer is more mature than initially assumed:

- It already translates OpenAI-format tool definitions into each provider's
  native tool-call format automatically, including `tool_choice` strategy
  mapping and parallel-vs-sequential call handling.
- It has native MCP support — tools loaded via MCP get translated across
  providers the same way — which lines up directly with the MCP work already
  done on the Pi agent project.
- It's MIT-licensed and fully open source, so the translation logic is
  auditable even though it wasn't hand-written — relevant for explaining the
  system to a client.
- It supports self-hosting, including air-gapped deployment, which doesn't
  conflict with sovereign/on-prem requirements later in the roadmap.

The main cost of using it as-is: routing every call through LiteLLM's own
interface risks the harness becoming "whatever LiteLLM's schema is" rather
than something with an owned architecture — weaker to point to in a client
conversation about *how* the system works.

## Decision

**Hybrid: use the LiteLLM SDK as the translation engine, wrapped in a thin
custom harness.**

- LiteLLM's `completion()` handles the actual per-provider request/response
  and tool-call translation — no need to re-solve a problem it already
  solves well, especially for MCP tool routing.
- The harness itself — `UnifiedMessage`/`UnifiedResponse` schema (1.2),
  config-driven routing (1.4), `ConversationManager` (1.5), and
  `dispatchToolCall` (1.6) — stays custom and owned. This is the part that
  gets explained to clients and extended per-engagement.
- LiteLLM is a dependency *inside* the harness, not the harness's public
  interface. Swapping it out later (if a client requirement demands it)
  stays possible without changing anything above the adapter boundary.

## Consequences

- Faster path through 1.3 (provider adapters) and 1.6 (tool-calling) than a
  fully custom shim — more time available for Phase 2 onward.
- Slight dependency risk: LiteLLM's release cadence and breaking changes
  need tracking, since the harness sits on top of it.
- The "what makes this yours" story for clients rests on the harness
  architecture and governance layer (Phases 3–4), not the low-level
  translation code — which is an accurate story to tell either way.
