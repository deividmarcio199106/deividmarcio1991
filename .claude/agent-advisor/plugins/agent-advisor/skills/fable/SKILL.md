---
name: fable
description: Run a software-delivery request through selective routing with Claude Fable 5.1 as the primary orchestrator. The heavyweight chair for the hardest or highest-stakes work; the route floor is audit, so independent review is the norm rather than the exception. Use when stakes exceed what the everyday opus chair should own.
---

# Fable chair

Treat this skill's arguments as the user's task request.

This is the heavyweight chair. Stakes decide the chair, not subject matter. Establish
these three values, then follow the authoritative workflow:

~~~text
chair: Claude Fable 5.1
floor: audit
failover: agent-advisor:reviewer
~~~

Before taking any task action, read
[`../orchestration/SKILL.md`](../orchestration/SKILL.md) completely and follow it as the
authoritative workflow, along with any reference it requires. Reading it is a setup
action; do not inspect or modify the user's workspace until that workflow has declared
its `SELECTIVE ROUTE`.

If the primary session is not Fable 5.1, stop and give the user two options: switch the
chair to Fable 5.1, or drop to the everyday `opus` chair and accept its lower
floor. Never proceed at this chair from another model.

**Why the floor is audit.** Entering this chair is itself a recorded claim that the
stakes are high, so independent review is the floor rather than the exception. `full` is
ordinary here. `delegate` drops review — take it only when the residual risk is in the
building, not the judging, and record why. `solo` is below the floor: it needs a
recorded justification, and if it is genuinely right, the everyday chair was probably
the correct chair.

**Review independence at this chair.** Review defaults to the out-of-process
`reviewer-codex` lane, which is cross-vendor. This chair's in-process failover is
`agent-advisor:reviewer`, pinned to Opus while you are Fable, so even the failover is
cross-model. Opus also sits beneath you as `implementer-complex` — delegating to it
transfers no architecture and no acceptance.

**Successor chair.** None. This is the top chair. If risk exceeds it, say so plainly and
stop rather than escalating further.

If the authoritative workflow cannot be resolved, stop and tell the user to install the
plugin. Never substitute an inferred or partial workflow.
