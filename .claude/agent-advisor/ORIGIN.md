# Origin

This project is a Claude Code adaptation of the selective-routing workflow from
Sol Advisor, a Codex-native plugin by Daniel McAteer.

~~~text
source_repository=https://github.com/DannyMac180/sol-advisor.git
source_version=0.6.0
source_license=MIT
implemented_for=Claude Code
relationship=adaptation — substantial prose derived from the original, not a clean-room rewrite
~~~

## How close it actually is

The canonical workflow here was written by working through the Codex
`skills/orchestration/SKILL.md` section by section, not from a blank page.

Measured at the sentence level, against the current text of both files:

| Measure | Count | Share |
|---|---|---|
| Sentences in this project's workflow | 151 | — |
| Sentences in the Codex original | 49 | — |
| This project's sentences ≥70% similar to one in the original | 22 | **15%** |
| The original's sentences with a ≥70% match here | 22 | **45%** |
| Sentences identical after case folding | 8 | 5% |

**The second row is the one that matters for attribution.** Fifteen percent sounds small,
but it is small only because this file grew: the derived core stayed the same size while
everything built on top of it was added. Nearly half of the original's workflow is
recognizably present here.

An earlier version of this file reported "29 of 69 sentences." That was measured when the
workflow was roughly a third of its current length, and it went stale rather than wrong —
left uncorrected it now *overstates* the borrowing, which is its own kind of inaccuracy.

The resemblance is concentrated, not spread evenly. Of eighteen sections, three carry
nearly all of it and eleven carry none:

| Section | Derived / total |
|---|---|
| Keep architect work in the primary session | 8 / 15 |
| Handling the verdict | 4 / 13 |
| Route delivery without duplication | 3 / 12 |
| Failover discipline | 0 / 42 |
| Record the return before acting on it | 0 / 33 |
| Diagnose the cause, then take exactly one disposition | 0 / 24 |
| Select the review lane | 0 / 20 |
| *(seven other sections)* | 0 |

So what is borrowed is the **core role definition** — what the architect keeps, and what
the four modes mean. The identical sentences are terse statements of a rule: "Treat worker
reports as claims.", "Inspect the actual diff and rerun verification.", "No task tool call
may precede this declaration.", "State the exact owned files, preserve concurrent edits,
and never silently widen scope." Everything layered above that — partial and blocked
returns, the `LANE RETURN` block, review-lane selection, the announced-and-authorized
failover, chair escalation — has no counterpart in the original.

These sentences are not rewritten to reduce the measured overlap, and that is deliberate.
Rewriting "Treat worker reports as claims" into something longer and vaguer would make the
document worse while leaving the derivation exactly as real — it would remove the evidence,
not the borrowing. The mode contracts in particular *should* read alike; wording that
diverged there would be a defect, not originality.

Re-measured after the failover-rule revision, which added four sentences to the workflow:
the denominator moved 147 → 151 and every percentage rounds unchanged, because the added
sentences are new work with no counterpart in the original. The figures below are current.

Sentence-splitting is arbitrary, so a different method will produce different denominators.
The figures above come from splitting on sentence boundaries after stripping frontmatter,
fenced blocks, inline code, and tables, keeping only sentences of five words or more, and
scoring with Python's `difflib.SequenceMatcher` on case-folded text. Re-measure rather than
trust this table if the workflow changes substantially again.

The chair skills were likewise adapted from that project's thin alias skills
(`sol-advisor`, `astra-advisor`, `daybreak-advisor`), and keep their shape and some of
their phrasing: "Before taking any task action", the setup-action-versus-task-action
distinction, and "Never substitute an inferred or partial workflow." An earlier draft
also carried its `$name:` shorthand sentence nearly verbatim. That line is gone, but it
was removed for being meaningless in Claude Code rather than to obscure the resemblance.

No file was copied. That is a weaker claim than "independently written", and only the
weaker one is true here.

## Carried over

- The machine-auditable route declaration and the four delivery modes (`solo`,
  `delegate`, `audit`, `full`).
- The one-auxiliary-by-default discipline, and the rule that the orchestrator owns
  architecture, verification, escalation, and acceptance.
- The five-part worker specification and the structured implementation report.
- The fail-closed posture: unobservable or missing routing evidence stops a lane rather
  than falling back.
- The thin-entry-point structure — a short skill per orchestrator that sets only which
  model presides, deferring to one canonical workflow it must not restate.
- Much of the wording, as measured above.

## Newly built here

- Every agent definition, and the Claude lane pins.
- The chair/floor mechanism, and the two-chair structure with differing route floors.
- The enforcement properties described in the README: implementers hold no Agent tool,
  so the one-auxiliary maximum cannot be exceeded by a worker delegating onward; the
  reviewer holds no write tools and no Bash, so its read-only isolation is enforced
  rather than requested. The Codex original needs prose and runtime inspection for
  both; here they are properties of the agent definitions.
- The honest treatment of what Claude Code cannot expose: lane model pins are
  declarative, because the parent cannot observe a subagent's realized model.
- `scripts/verify.sh`.

## Licence

The original is MIT. MIT permits derivative works, including close ones, provided the
copyright notice travels with them — see `LICENSE`, which carries both his notice and
the notice for the new work. The point of this file is not permission, which is not in
question. It is to avoid overstating how much of this is original.
