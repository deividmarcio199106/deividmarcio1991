# Claude Advisor

Risk-gated selective routing for Claude Code. The orchestrator owns intent,
architecture, verification, and acceptance, and declares a machine-auditable route
before its first task tool call. Solo delivery is normal; auxiliaries are spent
deliberately, one at a time.

Built for Claude, and adapted from [Sol Advisor](https://github.com/DannyMac180/sol-advisor)
by Daniel McAteer, MIT licensed. Not just its ideas: the workflow prose here was written
by working through his section by section, and a substantial share of it stays close to
the original. What is genuinely new is the Claude-specific machinery — the lane
definitions, the chair/floor mechanism, and the enforcement properties below.
[ORIGIN.md](ORIGIN.md) measures the overlap rather than asserting a comfortable number.

## Structure

One canonical workflow, one thin skill per orchestrator chair. A chair sets only which
model presides, how low its route may go, and which review lane it falls back to;
everything else is shared.

~~~text
plugins/agent-advisor/
├── agents/                        four pinned in-process lanes
├── scripts/review-codex.sh        the out-of-process review lane
├── skills/orchestration/          the authoritative workflow  <- edit behavior here
├── skills/opus/           chair: Opus 5.5,   floor: solo
└── skills/fable/          chair: Fable 5.1,  floor: audit
~~~

Adding a third chair costs about thirty-five lines and touches nothing else.

## Chairs

Stakes decide the chair, not subject matter. Start everyday; escalate deliberately.

| | `opus` | `fable` |
|---|---|---|
| Orchestrator | Opus 5.5 | Fable 5.1 |
| Route floor | `solo` | `audit` |
| `full` | explicit exception | ordinary |
| Below the floor | — | needs recorded justification |
| Review default | `reviewer-codex`: cross-vendor | `reviewer-codex`: cross-vendor |
| Review failover | `reviewer-sonnet`: cross-model | `reviewer`: cross-model |
| Successor | `fable` | none, this is the top |

The chair is the primary session's model, and a skill cannot change that. So the
everyday chair escalates by stopping and handing off explicitly — what it observed, what
is already verified, and which chair to enter after switching models. It never simulates
the higher chair.

## Routes

Four modes, at most one auxiliary subagent by default.

| Mode | Use it when | Delivery |
|---|---|---|
| `solo` | Risk is contained. | Orchestrator plans, implements, tests, self-reviews. |
| `delegate` | A complete spec is better executed by one implementer. | One pinned implementer; orchestrator verifies. No reviewer. |
| `audit` | Independent scrutiny matters more than delegation. | Orchestrator implements; the declared review lane reviews. |
| `full` | Broad or high-risk work needing both. | One implementer, orchestrator verification, declared review lane. |

## Lanes

| `subagent_type` | Model | Tools |
|---|---|---|
| `implementer-bounded` | `sonnet` (alias) | write + Bash, no Agent |
| `implementer-complex` | `opus` (alias) | write + Bash, no Agent |
| `reviewer-sonnet` | `sonnet` (alias) | read-only, no Bash |
| `reviewer` | `opus` (alias) | read-only, no Bash |

Review has a fourth lane that is not a subagent at all. `reviewer-codex` runs the review
out-of-process through the Codex CLI, pinned to `gpt-5.6-sol` at high effort in a
read-only sandbox, so the verdict comes from a different vendor than the chair. It is the
required lane for `audit` and `full`; the in-process reviewers are its failover, and each
chair names the one that is not its own model. Choosing an in-process reviewer instead —
up front or after a failure — needs your explicit say-so, since it is a weaker review and
since this lane sends the repository to a third-party CLI. The script passes `--ignore-user-config`, so a
local Codex config cannot retarget the review.

Two rules are enforced by the agent definitions rather than merely stated:

- Neither implementer holds the Agent tool, so a worker cannot delegate onward and break
  the one-auxiliary maximum.
- The reviewer holds no write tools and no Bash, so its read-only isolation is enforced.
  The cost is that it cannot run commands, so the orchestrator pastes the change set and
  the actual verification evidence into its prompt.

## Install

Local copy inside this repository — see [ADAPTACOES.md](ADAPTACOES.md) for what was changed from upstream and why. Run from the repository root:

~~~sh
/plugin marketplace add ./.claude/agent-advisor
~~~

~~~sh
/plugin install agent-advisor@agent-advisor
~~~

## Use

Plugin components are namespaced, so the lanes spawn as
`agent-advisor:implementer-bounded`, not the bare name — see the spawn contract
in the role contracts. A bare name fails as "agent type not found", which looks exactly
like an unregistered lane. If a chair skill or lane is still missing right after
installing, start a new session; components register at install time but a running
session may not pick them up immediately.

Put the right model in the chair, then invoke that chair:

~~~text
/agent-advisor:opus    (requires Opus 5.5)
~~~

~~~text
/agent-advisor:fable   (requires Fable 5.1)
~~~

Each chair checks the primary model before delegating and stops if the wrong model is
presiding. Give it the outcome, constraints, and any repository context that matters;
you do not select a lane.

## Known limits

- **In-process lane pins are declarative.** Claude Code does not expose a subagent's
  realized model to the parent, so the agent definition is the pin and there is nothing
  to verify at runtime. Both the workflow and the contracts forbid claiming observed
  routing for these lanes. `reviewer-codex` is the exception: Codex reports its realized
  model, sandbox, and effort, and the script verifies all three against the pin and
  fails if any differs, so that lane's pin may be stated as observed.
- **No reasoning-effort pin in-process.** Claude Code agent frontmatter has no equivalent
  field. `reviewer-codex` pins effort explicitly, because `--ignore-user-config` drops
  the user's configured value.
- **The review failover is a real downgrade, and it needs your say-so.** It never fires
  on a pin violation, a malformed verdict, or a caller error — those hard-stop. For the
  two unavailability exits it is gated on explicit authorization, because the CLI's
  presence, `CODEX_HOME`, and login state are all reachable from the session deciding
  whether to fail over. The exit code narrows the cause; it cannot prove it.
- **Cross-vendor review sends the change set to OpenAI.** The out-of-process lane hands
  the reviewed repository to the Codex CLI. Use an in-process lane where that is not
  acceptable.
