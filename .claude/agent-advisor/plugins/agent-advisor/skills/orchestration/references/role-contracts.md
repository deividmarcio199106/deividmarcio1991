# Claude subagent role contracts

Use these contracts with the role-pinned Claude Code subagents in this plugin. They do
not change the primary session's model and do not alter global agent defaults. Adapt
every placeholder without removing a required field.

This reference is shared by every chair. It is authoritative for lanes, spawning, the
worker packet, and the mode contracts. It does not set the chair or the route floor —
those come from the chair skill you entered through.

## Lane pins

| Lane | Model pin | Tools | Use |
|---|---|---|---|
| `implementer-bounded` | sonnet | write + Bash, no Agent | Delegate/full bounded, fully specified work |
| `implementer-complex` | opus | write + Bash, no Agent | Delegate/full judgment-heavy or high-risk work |
| `reviewer` | opus | read-only, no Bash | Audit/full fresh review; context-clean beneath an Opus chair |
| `reviewer-sonnet` | sonnet | read-only, no Bash | In-process review failover; cross-model beneath an Opus chair |
| `reviewer-codex` | gpt-5.6-sol, out-of-process | read-only sandbox, no agent definition | Default audit/full review; cross-vendor |

Two properties are enforced by the agent definitions rather than by prose:

- Neither implementer holds the Agent tool, so the one-auxiliary maximum cannot be
  exceeded by a worker delegating onward.
- The in-process reviewers hold no write tools and no Bash, so their read-only isolation
  is enforced. They therefore cannot run commands — the orchestrator must supply the
  change set and the verification evidence in the prompt.
- `reviewer-codex` is a script, not an agent definition, so it is never spawned with the
  Agent tool and has no `subagent_type`. Its read-only isolation comes from the Codex
  sandbox and its freshness from a non-persisted session. Selection, invocation, pin
  verification, the untrusted-output rule, and the failover path are defined in
  [the canonical workflow](../SKILL.md), under "Review only when the route includes it".

In-process model pins are declarative. Claude Code does not expose a subagent's realized
model to the parent, so cite the agent definition as the pin's source and never claim you
observed realized routing. `reviewer-codex` is the exception: it reports its realized
model and sandbox, and its script verifies both, so that one pin may be stated as
observed.

## Spawn contract

Spawn with the Agent tool, naming the lane and nothing else:

~~~text
subagent_type: agent-advisor:implementer-bounded
run_in_background: false
description: <3-5 word task label>
prompt: <the complete packet below>
~~~

**Lane names are namespaced by the plugin that ships them.** Installed as a plugin, the
four in-process lanes are `agent-advisor:implementer-bounded`,
`agent-advisor:implementer-complex`, `agent-advisor:reviewer-sonnet`, and
`agent-advisor:reviewer`. The bare names apply only if the agent files were installed
standalone into `~/.claude/agents/`. `reviewer-codex` is not in this list because it is
a script rather than an agent, and so is never spawned this way at all. Passing a bare name against a plugin install fails as "agent type
not found" — if a lane comes back missing, check the prefix before concluding the lane
is unregistered, because the two failures look identical and only one of them is a real
hard stop.

Every Claude Code subagent starts in a fresh context, so no fork or reset flag is
needed. Do not pass a `model` override on the spawn — the lane's definition pins it, and
an override silently defeats the pin. Use `run_in_background: false`: the orchestrator's
next action is verification of this result.

## Shared implementation contract

Every implementer prompt must contain all five sections:

~~~text
OBJECTIVE
<Observable outcome and why it matters.>

FILES AND OWNERSHIP
You own only:
- <exact file or module>

You are not alone in the codebase. Other agents or the user may be editing concurrently.
Preserve their edits, do not revert unrelated work, and adapt to changes already present.
Do not modify files outside your ownership.

INTERFACES
- <Signatures, types, schemas, commands, or behavior that must remain compatible.>

CONSTRAINTS
- <Repository conventions, safety boundaries, excluded scope, and settled decisions.>

VERIFICATION
- Run: <exact command>
  Success: <concrete expected result>
- Inspect: <exact file, diff, or generated artifact>
  Success: <concrete expected evidence>

RETURN
Return exact commands and actual evidence. A completion claim without evidence is invalid.

IMPLEMENTATION REPORT
STATUS: complete | partial | blocked
OBJECTIVE: <one-line restatement>
CHANGES: <file-by-file summary from the actual diff>
VERIFIED: <exact commands plus concrete output evidence>
JUDGMENT CALLS: <decisions the specification left open, or none>
GAPS: <unfinished work, ambiguity, or none>
~~~

The orchestrator must inspect the diff and rerun verification itself.

`STATUS` reports the state of the specification, not the worker's effort:

- `complete`: every VERIFICATION item was run or inspected and passed, and nothing in
  GAPS is outstanding.
- `partial`: the specification was understood and some of it is implemented, with
  identified work remaining. GAPS must name what is left.
- `blocked`: something outside the worker's reach stopped it. GAPS must name the
  blocker.

What the orchestrator does with a `partial` or `blocked` return is defined once, in
[the canonical workflow](../SKILL.md), under "Handle a partial or blocked return". It is
not restated here.

## Exact mode contracts

- `solo`: the orchestrator plans, implements, tests, and self-reviews. Spawn no auxiliary.
- `delegate`: one selected implementer executes the complete five-part specification.
  The orchestrator verifies. Spawn no reviewer.
- `audit`: the orchestrator implements and verifies. The declared review lane inspects
  the accumulated change set. Spawn no implementer. On `fix-first`, the orchestrator
  implements the correction, re-verifies, and obtains a new fresh review.
- `full`: one selected implementer executes the complete specification, the orchestrator
  verifies, and the declared review lane inspects the accumulated change set. On
  `fix-first`, the selected implementer handles the correction, the orchestrator
  re-verifies, and a new fresh review inspects the result.

Which lane "the declared review lane" names, and what happens when it cannot run, are
defined in [the canonical workflow](../SKILL.md); the route's `review:` line records the
selection.

An implementer that returns `partial` or `blocked` is dispositioned by the orchestrator
under the canonical workflow's return handling; the orchestrator never writes the
remainder itself.

Auxiliary work substitutes for orchestrator work; it must not duplicate it. A route
escalates only with newly observed, recorded risk; it never silently downgrades. Route
escalation tops out at `full` — risk exceeding the chair itself is handled by the chair
handoff, not by widening the route further.

## Reviewer prompt

Only for an audit or full route, after orchestrator verification:

~~~text
ROLE
Act as the fresh final reviewer. You hold read tools only.

STATED GOAL
<The user's requested outcome.>

ACCUMULATED CHANGE SET
<Exact owned files plus the complete working-tree diff, pasted in full.>

INTERFACES AND CONSTRAINTS
- <Compatibility, repository rules, safety boundaries, and excluded scope.>

VERIFICATION EVIDENCE
- <command> -> <actual primary-session output evidence>
- <artifact or diff inspection> -> <actual evidence>

REVIEW
Read the actual files named above to confirm this account. Judge correctness,
completeness, regressions, scope discipline, interface preservation, test adequacy,
and material risk.

ADVISOR REVIEW
VERDICT: ship | fix-first | rethink
REASON: <decisive evidence-based reason>
FINDINGS: <precise file references and required fixes, or none>
RESIDUAL RISK: <most important remaining risk, or none>
~~~

If any fix is made after review, discard the verdict and run a new fresh review.
