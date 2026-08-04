Paste this into Claude Code, pointed at this repo.

---

Read `CLAUDE.md` first — it has the full context, reading order, and build
sequence for this project. Don't skip it.

This repo (sovereign AI roadmap, Phase 1 harness) is 100% design right
now, zero code. I want you to implement it: 1.2, then 1.4, then 1.5, then
1.6, in that order, followed by 1.7. Each of 1.2/1.4/1.5/1.6 has a decided
design in `phase1/adrs/` — build what's there, don't redesign it. 1.7 has
no doc because it's the integration/proof step, not a prior design — that
one you build fresh once the others exist.

Before you touch 1.7 specifically: stop and ask me which project to
target and what the before/after should demonstrate. `CLAUDE.md` explains
why the original target ("the Pi agent project") might not actually fit
anymore — don't assume it still does.

I do[/don't] have `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` available in
this environment — [fill in which]. If they're not available, build
everything anyway and clearly mark what's implemented-but-unverified
rather than skipping the proof steps silently.

Log what you find/decide into `findings-log.md`, same style as the
existing entries, not a new standalone file.
