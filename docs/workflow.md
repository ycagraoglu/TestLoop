# Gated Verification Workflow

## Per-scenario pipeline

`testloop run` walks each configured scenario through this pipeline. It is a single pass: no step
retries itself, and every branch below ends the scenario.

```text
RESOLVE FIXTURES ──── not verified ────→ BLOCKED   (the endpoint is never called)
       │ verified
       ↓
   EXECUTE  (authenticated request, real HTTP)
       ↓
   CLASSIFY
  ├─ expected status ──────────────────→ PASS
  ├─ ENVIRONMENT_ERROR / AUTH_ERROR / FIXTURE_ERROR / INCONCLUSIVE
  │                                    → FAIL or BLOCKED, without calling any role
  └─ APPLICATION_BUG (5xx with every precondition evidenced)
             ↓
        DIAGNOSE  (role)
  ├─ EXPECTED_REJECTION ───────────────→ PASS
  ├─ SPEC_MISMATCH ────────────────────→ SPEC_MISMATCH (reported, never repaired)
  ├─ FIXTURE_ERROR / AUTH_ERROR / ENVIRONMENT_ERROR / INCONCLUSIVE
  │                                    → BLOCKED
  └─ APPLICATION_BUG
        ├─ mode: smoke ────────────────→ FAIL (reported, never repaired)
        ├─ requireApproval: false ─────→ FIX
        └─ default ───────────────────→ AWAITING_APPROVAL  (run stops here)
                                            ├─ decline → SKIPPED
                                            └─ approve → FIX
                                                     ↓
                                              FIX (role)
                                       ├─ not SUCCESS → ESCALATED
                                       └─ SUCCESS
                                                     ↓
                                             REVIEW (role)
                                       ├─ not APPROVED → ESCALATED
                                       └─ APPROVED
                                                     ↓
                                        RETEST (re-authenticated)
                                       ├─ expected status → PASS (PASS_AFTER_FIX)
                                       └─ otherwise → FAIL (RETEST_FAILED)
```

`CHANGES_REQUESTED` from review and a failed retest are both terminal (`ESCALATED` / `FAIL`); TestLoop
does not loop back into `FIX` or `DIAGNOSE`. That is why it needs no retry budgets: there is nothing
that can run twice.

## Gates

Three gates decide whether the pipeline may continue, and each one fails closed:

1. **Fixture gate** — an unverified persisted dependency blocks the scenario before the endpoint is
   called. A supplied value with no evidence does not count as verified, and a random one is refused.
2. **Approval gate** — a confirmed `APPLICATION_BUG` does not reach the fix role without an explicit
   human `approve` (unless `requireApproval: false`), and never in `smoke` mode.
3. **Review gate** — the retest does not run until an independent reviewer returns `APPROVED`.

Role output is validated against its contract before any of this proceeds: an unknown status ends the
scenario as `ESCALATED` rather than being treated as a decision.

## Fixture resolution order

TestLoop resolves dependency values in this order:

1. fixture already created in the current workflow;
2. value returned by a producer endpoint;
3. known test seed data;
4. safe list or lookup endpoint;
5. read-only query against the isolated test database;
6. creation through a safe producer endpoint;
7. otherwise `BLOCKED`.

Random identifiers are never used for fields proven or strongly indicated to reference persisted data.

## Failure qualification

An HTTP error is not an application defect by itself. `APPLICATION_BUG` requires evidence that:

- authentication and authorization context are valid;
- required fixture records exist;
- tenant and ownership predicates are satisfied;
- declared validation constraints are satisfied;
- environment dependencies are healthy;
- the response remains unexpected after reproducible execution.

## Human approval gate

By default, a confirmed `APPLICATION_BUG` never invokes the fix role on its own initiative. The
workflow stops at `AWAITING_APPROVAL` and persists the pending request; a human must resume it
explicitly:

```bash
testloop resume <run-id> <scenario-id> approve
testloop resume <run-id> <scenario-id> decline
```

`approve` re-authenticates, replays the original request through the fix/review/retest chain. `decline`
ends the scenario as `SKIPPED` and never calls the fix role. This gate is separate from, and precedes,
the review gate below.

Either decision then picks the scenario loop back up: any scenarios configured after the paused one
that never ran (the original run stopped at `AWAITING_APPROVAL`) are attempted next, reusing outputs
captured by every scenario resolved so far, including the just-approved one. The run only stops there
too if the resumed result itself is `FAIL`, `ESCALATED`, or another `AWAITING_APPROVAL`.

Setting `requireApproval: false` in the run config removes this gate: `DIAGNOSE` goes straight to `FIX`
on `APPLICATION_BUG`, in the same process, with no `testloop resume` step.

`mode: "smoke"` overrides both: a confirmed `APPLICATION_BUG` is reported as `FAIL` and the fix role is
never invoked, with or without `requireApproval`.

Either way, the fix role receives `projectInstructions`: the contents of the target project's own
root-level `AGENTS.md` and/or `SKILL.md`, when present, so the fix follows that project's conventions.

## Retest scope

The retest replays the original request against whatever is listening on `baseUrl`. TestLoop rebuilds
and restarts nothing, so a fix that only edits source is invisible to it and the scenario ends as
`RETEST_FAILED` against the old build. Making the change live is the fix role's responsibility, and it
must stop the previous process by listening port rather than by process name; the contract and the
reasoning are in [`agents/bugfix.md`](../agents/bugfix.md).

Authentication is re-resolved immediately before the retest, so a short-lived token captured before
diagnosis cannot expire during slow fix and review calls.

## Review gate

Retest cannot begin until an independent reviewer returns `APPROVED`. The reviewer must verify that the change:

- addresses the diagnosed root cause;
- does not weaken validation or authorization;
- does not bypass tenant or ownership checks;
- does not hide the error with broad exception handling;
- does not introduce unrelated refactoring;
- includes the necessary regression scope.

## Role failure

Role adapters are external processes. A timeout, a non-zero exit, output over the size limit, or a
status outside the role's contract ends that scenario as `ESCALATED` with classification
`RUNNER_ERROR`. It never aborts the run: remaining scenarios still execute and `summary.json` is still
written, because the evidence trail is worth more than the failed step.

## Cost ceiling

The pipeline is single-pass, so a scenario's cost is bounded by construction rather than by a budget
counter: at most one `diagnose`, one `fix`, and one `review` call, and at most one retest. Nothing
retries, so nothing can loop.

What is bounded explicitly:

| Limit | Where | Default |
|---|---|---|
| Role output size | `security.maxRoleOutputBytes` | 1 MB |
| HTTP response size | `security.maxResponseBytes` | 2 MB |
| Role runtime | `roles.timeoutMs` | 120 s |
| HTTP request timeout | `timeoutMs` | 30 s |
| Fixture creation recursion | `maxCreationDepth` | 3 |

Reaching any of these ends the scenario (`ESCALATED` or `BLOCKED`), never the run.
