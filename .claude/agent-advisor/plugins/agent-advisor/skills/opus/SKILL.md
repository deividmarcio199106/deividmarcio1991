---
name: opus
description: Run a software-delivery request through selective routing with Claude Opus 5.5 as the primary orchestrator. The everyday chair; the route floor is solo. Use for routed, orchestrated, or reviewed delivery of a build, fix, or refactor when the stakes are ordinary.
---

# Opus chair

Treat this skill's arguments as the user's task request.

This is the everyday chair. Establish these three values, then follow the authoritative
workflow:

~~~text
chair: Claude Opus 5.5
floor: solo
failover: agent-advisor:reviewer-sonnet
~~~

Before taking any task action, read
[`../orchestration/SKILL.md`](../orchestration/SKILL.md) completely and follow it as the
authoritative workflow, along with any reference it requires. Reading it is a setup
action; do not inspect or modify the user's workspace until that workflow has declared
its `SELECTIVE ROUTE`.

If the primary session is not Opus 5.5, stop and give the user two options: switch the
chair to Opus 5.5, or state which chair they want instead.

**Review independence at this chair.** Review defaults to the out-of-process
`reviewer-codex` lane, which is cross-vendor. This chair's in-process failover is
`agent-advisor:reviewer-sonnet`, which is cross-model but same-vendor. Do not fail over
to `agent-advisor:reviewer`: it is pinned to this chair's own model, so it would be
context-clean and nothing more.

**Successor chair.** When newly observed risk exceeds what this chair should own, hand
off to `fable` after the user switches the primary session to Fable 5.1. Do not
simulate it from here.

If the authoritative workflow cannot be resolved, stop and tell the user to install the
plugin. Never substitute an inferred or partial workflow.
