# Lessons — recurring mistakes, and the checks that catch them

**What this is:** my own authorial failure modes on this project, written
down so the next session doesn't repeat them. Every entry is a real mistake
that shipped or nearly shipped, not a general principle someone might find
in a style guide.

**What this is not:** `findings-log.md`. That holds project findings — what
was learned about pi-ai, providers, hardware, and why each decision went the
way it did. This holds *how I got things wrong*. If a lesson is about the
world, it belongs there; if it is about my process, it belongs here.

**How to use it:** read the checklist at the bottom before starting, and
read the relevant section before writing the kind of code it describes. The
sections are ordered by how much damage each one caused.

---

## 1. A guard written against an earlier draft of the value it guards

**What happened.** In `ConversationManager.anchorFrom()` I wrote the value
as `input + cacheRead + cacheWrite` and then wrote the gate as
`usage.input <= 0`. The comment justifying the gate — "a non-empty request
cannot cost nothing" — was true of the sum and false of `input` alone. A
fully cached prefix arrives as `input: 0, cacheRead: 8000`, so the
measurement was discarded *precisely when caching works*.

I had refined the value mid-writing and never went back to the guard.

**Same session, same shape.** `append()` invalidates the anchor when
truncation cuts into the anchored prefix — but I never re-checked the kept
set against the now-unwidened budget. The condition changed; the invariant
that depended on it did not get re-established. Measured at 4013 tokens
against a 3000 budget.

**The rule.** When you change what a value *is*, re-read every condition
that mentions it — including your own comment, which is a claim that can go
stale silently. When you invalidate a precondition, ask what was computed
*using* it and whether that result is still valid.

**The check.** After writing a guard, say out loud what quantity it protects
and confirm the expression names that exact quantity. If a comment explains
why a guard is safe, verify the comment against the current code, not
against what you were thinking when you wrote it.

---

## 2. Asserting a negative about a library instead of grepping it

**What happened.** I wrote in `1.8-token-budgeting.md` that codex was
"replaying reasoning the harness cannot see and cannot measure." It was
wrong. The payload was in `thinkingSignature` — 1146 characters of it — a
documented field on pi-ai's own `ThinkingContent` type. One grep would have
found it. Instead the claim went into an ADR, and the ~37 tokens/turn I
attributed to provider-side invisibility had a mundane explanation the
whole time.

This is the exact failure `CLAUDE.md` already warns about: *"Treat any
remaining 'pi-ai already handles X' claim as unverified until executed. A
grep would have caught most of these."* The project had been burned four
times before I did it a fifth.

**The rule.** "The library doesn't expose X" and "the provider doesn't send
X" are empirical claims, not reasoning steps. Grep the `.d.ts` before
writing either into a document.

**The check.** Before any sentence containing *cannot*, *never*, *doesn't
expose*, or *is not available* about a dependency: grep for it. It costs one
tool call.

---

## 3. Stating an inference I had already flagged as unsafe

**What happened.** From one tool-calling run where the arithmetic happened
to line up (turn-2 input 396 ≈ turn-1 total 376 + tool result), I concluded
qwen replays thinking. I *did* flag that it rested on an arithmetic
coincidence — and then said it anyway. A later probe disproved it: thinking
was not replayed at all on a plain turn.

Flagging a weak inference does not make it safe to state. It just makes the
error attributable.

**The rule.** If a claim is worth a caveat, it is worth a measurement — or
worth leaving out. "I think X, though this rests on one coincidence" is a
plan to go measure X, not a finding.

**The check.** When about to attach a hedge to a factual claim, ask what
single command would settle it. If one exists and is cheap, run it instead
of hedging.

---

## 4. Predicting effort before measuring it

**What happened.** I recorded in `SESSION-HANDOFF.md` that the token
budgeting work was "transcription, not design." Probing it found a second,
unrelated defect, disproved the obvious form of the fix, and changed the
ordering of the work. The framing had to be retracted in the ADR itself.

**The rule.** "This is mechanical" is a prediction about code not yet read.
It is fine to think it; it is not fine to write it down as a property of the
task.

**The check.** Describe scope in terms of what is known ("the algorithm is
specified in X") rather than what it will cost ("this is transcription").

---

## 5. Wrong test fixtures, read as wrong code

**What happened.** Three of my new tests failed on first run this session,
and **all three were bad fixtures, not bugs**:

- *Anchor invalidation:* I appended messages that never came close to the
  budget they were supposed to overrun, then asserted truncation had cleared
  the anchor. No truncation had occurred.
- *Credential corruption:* I simulated a truncated write by overwriting the
  file with content that no longer contained the token I then asserted had
  survived. I destroyed the evidence in the setup.
- *`maxContextFor`:* omitted `bitsPerWeight`, so the call threw for a reason
  unrelated to what the test was checking.

Each time the first instinct was to look at the implementation.

**The rule.** A red test is a hypothesis about **two** things: the code and
the test. Check the fixture first — it is newer, less reviewed, and was
written by someone (me) who had just decided what the answer should be.

**The check.** Before debugging the implementation, print the fixture's
actual state — lengths, totals, what got kept — and confirm the test reaches
the branch it claims to test. In this project that means: does the estimated
size actually exceed the budget, does the setup actually preserve what the
assertion looks for.

---

## 6. Assertions that cannot fail

**What happened.** Two truncation tests asserted
`estimateContextTokens(kept) <= budget || kept.length === 1`. Whenever the
single-message fallback triggered, the assertion passed regardless of what
the budget arithmetic did. The QA pass flagged them; they had been passing
for a reason unrelated to correctness.

Related, from the same pass: `validate-context.ts` checks for duplicate tool
names, but `ToolRegistry.register()` was a bare `Map.set`, so
`getToolDefinitions()` came out deduplicated and the check could never fire
on the real path. **A guard placed downstream of the thing that removes the
evidence is decoration.**

**The rule.** A disjunctive assertion passes on its weakest branch. Assert
what actually happens, and if the fallback is the expected outcome, assert
*that* — including the branch taken.

**The check.** For every `||` in an assertion, ask which branch is true in
this run, and whether the test would fail if the other branch silently broke.
For every validation, ask what upstream code could make the invalid state
unreachable before the check runs.

---

## 7. Numeric guards that fail open

**What happened.** `NaN <= 0` is `false`, so a `NaN` budget passed both of
`ConversationManager`'s "this window is unusable" guards. The result was a
conversation that never truncated at all — an invariant that appeared
satisfied because no comparison could ever be true. Reachable from one
typo'd field in an unvalidated JSON file.

Same family elsewhere: `sizing.ts` divided by `sequences: 0` and reported a
maximum context of `Infinity`; a negative context produced "−12.28 GB, ✓
fits".

**The rule.** `x > 0` is not a positivity check — it is a check that fails
open on `NaN`. Write `Number.isFinite(x) && x > 0`. For anything that will be
divided by, also reject zero explicitly.

**The check.** Grep new numeric validation for bare `<= 0`, `> 0`, `< n`
comparisons and confirm each has a finiteness check in front of it.

---

## 8. Validating one input path and not its sibling

**What happened.** `model.config.json` had field-by-field validation since
1.4, with a regression test proving a typo is rejected rather than ignored.
`local-providers.json` fed the same machinery through a bare `JSON.parse`.
One typo there reached `ConversationManager` as `undefined`.

I wrote the second file's loader and never asked why the first one had a
hundred lines of validation.

**The rule.** When two inputs reach the same consumer, they need the same
validation. If one has it and the other doesn't, that asymmetry is a bug,
not a style difference.

**The check.** When adding a config or data file, find the existing one and
diff the treatment: validated fields, unknown-key rejection, numeric bounds,
regression test for a typo.

---

## 9. Measuring one field of a union and zeroing its siblings

**What happened.** `estimateTokens` counted `thinking` and ignored
`thinkingSignature`; counted `text` and ignored `textSignature`. A message
carrying 1238 characters of replayed payload scored **5 tokens**.

This is the third instance of one mistake in this file's history — images
were the first (a conversation of screenshots reported 100/100 tokens while
holding megabytes), tool-call arguments the second.

**The rule.** When a type is a union of shapes, enumerate the union from the
type definition, not from the cases in mind. Anything not counted is being
asserted to cost zero, and that assertion should be deliberate.

**The check.** Open the `.d.ts`, list every field of every variant, and
account for each one — count it or write down why it is free.

---

## 10. Verification tooling that quietly does nothing

**What happened.** I wrote a shell loop to confirm the sizing CLI rejected
bad input:

```zsh
for a in "--sequences 0" ...; do node script.ts --budget 6 $a; done
```

zsh does **not** word-split unquoted parameter expansions, so `--sequences 0`
was passed as one literal argument, matched no flag, and the script ran
normally. Every case printed success. I nearly concluded a working fix was
broken. `${=a}` forces splitting.

Earlier in the same session I piped a validation loop through `tail -2` and
read the wrong lines, drawing the same wrong conclusion.

**The rule.** When a verification says "no problem found", confirm the
verification actually ran the case. A green result from a harness you just
wrote is the least trustworthy kind.

**The check.** Prove the negative control: make one case that *must* fail,
and confirm it does. If nothing fails, the harness is suspect before the code
is.

---

## 11. Documentation drift I introduced myself

**What happened.** Small but repeated: a `##` heading split across two lines
in `findings-log.md` (rendering as two headings); a test count updated in one
place in `SESSION-HANDOFF.md` and stale in another; a "Running it" block
still claiming 101 tests after the suite reached 142.

**And the serious version of it.** Closing 1.7 revealed `CLAUDE.md` — the
file loaded into *every* session — still opening with "this repo is
currently 100% design, zero code", months after that stopped being true,
plus a live-looking open question that had been answered in an ADR eight
days earlier. I read that navigation instead of the document it pointed at
and told the user 1.7 was unbuilt. It was finished.

**The rule.** A number written in two places will disagree with itself. A
*status* written once, at the top of the file everyone reads first, will be
believed long after it stops being true — and it will be believed by you.

Related: a checkbox whose blocker is resolved elsewhere does not untick
itself. 1.7's last item said "waiting on a second reachable provider"; a
later phase supplied one and nobody went back.

**The check.** `grep -rn "<old value>"` before considering a doc update
done. When a phase closes, grep the docs for "waiting on", "outstanding",
"deferred" and "not yet" — those are the claims most likely to have expired
without anyone noticing. And when a top-of-file summary contradicts the
code in front of you, trust the code and fix the summary.

---

## 12. Mixing failed observations into performance distributions

**What happened.** The first A0-M.3 aggregation correctly failed the overall
profile when provider calls failed, but it also put those samples' synthetic
zero throughput and zero tool-dispatch values into the latency/throughput
percentiles. The report was fail closed and still statistically wrong.

The same verifier initially required its excluded warm-up to conform. A
stochastic warm-up failure then prevented collection of the measured
population it was supposed to warm. Later, an arbitrary 64-token benchmark
cap made Qwen fail before a tool call even though the configured deployment
and established live verifier passed.

**The rule.** Availability/conformance and conditional performance are two
different populations. Failed samples determine failure rate and verdict;
only conformant samples describe successful-operation latency and throughput.
An excluded warm-up cannot qualify or veto the measured run. Any synthetic
workload control must be calibrated against the supported profiles and stored
in the artifact.

**The check.** Inject a failed sample with zero-valued metrics and assert that
the verdict/failure rate changes while successful-operation percentiles do
not. Inject an all-failed population and require `metrics: null`, never a
fabricated zero distribution. Confirm the report records warm-up exclusion,
generation cap, tool choice, and workload identity.

---

## 13. A batch gate inside an execution loop is not a batch gate

**What happened.** Approval resume authenticated one submission, acknowledged
its resolution, and immediately executed that tool before inspecting the next
submission. The one-call tests were green, but a two-call resume could perform
the first side effect and only then discover that the second authorization was
invalid or its journal acknowledgement failed.

The first MCP registration draft had the same shape: validate and publish one
remote tool at a time. A later invalid declaration could have left an earlier
tool active even though server admission as a whole failed.

**The rule.** For a batch safety boundary, finish the entire read/validate/
authenticate/acknowledge phase before the first execute or publish operation.
Do not interleave validation and mutation merely because both happen in one
loop.

**The check.** Use at least two items. Make the second fail at the last gate and
assert the first item neither executed nor became visible. A one-item batch
test cannot prove batch atomicity.

---

## 14. Cleanup begins when the temporary resource exists

**What happened.** The first B4 ingestion path created a quarantine file,
then validated the content-bound attachment ID before entering its `try` /
`finally` cleanup scope. A malformed caller ID could reject the upload and
leave the private temporary file behind even though size and MIME failure
paths cleaned up correctly.

**The rule.** Enter ownership cleanup immediately after a temporary resource
is created. Every later operation, including identity generation, metadata
validation, object publication, and database writes, must run inside that
scope.

**The check.** Fail at the first operation after staging and assert the
quarantine directory is empty. Also fail after object publication and assert
both the staged name and the uncommitted object are removed.

---

## 15. A tombstone check at statement start does not govern an older transaction

**What happened.** B6 initially checked the erasure tombstone in every
repository write and snapshotted all affected rows in the request statement.
That looked atomic and passed deterministic tests. It still allowed a write
transaction to insert before the request, remain uncommitted while the request
captured its scope, and commit after erasure. The content would be hidden by the
read view but absent from the worker's deletion scope.

**The rule.** A state transition that revokes future writes must govern
transactions that already crossed the write boundary, not only statements that
start afterward. Immediate filtering and asynchronous deletion are separate
invariants; neither proves the other.

**The check.** Hold a real content insert open in one database connection,
commit the tombstone from another, then attempt the old commit. It must fail and
leave no row. A sequential "write after tombstone" test cannot reach this race.

---

## Pre-flight checklist

Before writing code:

- [ ] Does an input path like this one already exist? Match its validation.
- [ ] Am I about to claim a dependency lacks something? Grep first.

While writing:

- [ ] Every numeric guard: `Number.isFinite(x) && …`, never bare `x > 0`.
- [ ] Every union type: enumerate from the `.d.ts`, account for each field.
- [ ] Changed what a value means? Re-read every condition and comment on it.
- [ ] Invalidated a precondition? Re-check whatever was computed from it.

While testing:

- [ ] Does each test reach the branch it claims to test? Print the state.
- [ ] Any `||` in an assertion — could the other branch break silently?
- [ ] A test failed: check the fixture before the implementation.
- [ ] A verification passed: prove it can fail, or don't trust it.

Before saying it's done:

- [ ] Every factual claim in a doc: measured, or removed.
- [ ] Grep for stale counts and superseded statements.
- [ ] Say plainly what is verified and what is only implemented.

---

## The meta-lesson

Two adversarial QA passes on this project have now found **six and then ten
defects while the full suite was green**. Both times the newest, most
carefully reviewed code was among the worst offenders — the second pass
found four defects in code I had written and reviewed that same day.

Passing tests cluster where the author was already thinking clearly. They
are evidence about the author's model of the problem, not about the code.
The defects live exactly where that model was wrong, which is exactly where
no test was written.

So: when something feels finished and well-covered, that is the moment to
attack it from outside — with a different reader, a different technique, and
no knowledge of what was intended.
