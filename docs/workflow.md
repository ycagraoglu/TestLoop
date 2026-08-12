# Gated Verification Workflow

## State machine

```text
DISCOVER
  ↓ SUCCESS
PLAN
  ↓ SUCCESS
RESOLVE_FIXTURES
  ↓ SUCCESS
PREPARE_AUTH
  ↓ SUCCESS
GENERATE_REQUEST
  ↓ SUCCESS
EXECUTE
  ↓ SUCCESS
VERIFY
  ├─ PASS ─────────────────────────────→ COMPLETE
  ├─ BLOCKED ──────────────────────────→ REPORT
  └─ UNEXPECTED_RESULT
             ↓
          DIAGNOSE
  ├─ FIXTURE_ERROR ────────────────────→ RESOLVE_FIXTURES
  ├─ AUTH_ERROR ───────────────────────→ PREPARE_AUTH
  ├─ ENVIRONMENT_ERROR ────────────────→ REPORT
  ├─ EXPECTED_REJECTION ───────────────→ COMPLETE
  ├─ SPEC_MISMATCH ────────────────────→ REPORT
  ├─ INCONCLUSIVE ─────────────────────→ REPORT
  └─ APPLICATION_BUG
             ↓
      AWAITING_APPROVAL
  ├─ DECLINED ──────────────────────────→ SKIPPED
  └─ APPROVED
             ↓
            FIX
             ↓ SUCCESS
           REVIEW
  ├─ CHANGES_REQUESTED ────────────────→ FIX
  └─ APPROVED
             ↓
           RETEST
  ├─ PASS ─────────────────────────────→ COMPLETE
  └─ FAIL ─────────────────────────────→ DIAGNOSE
```

## Gate rules

A state transition is legal only when:

1. the current role returns schema-valid output;
2. the required artifacts exist;
3. the expected status or decision is present;
4. retry and token budgets remain available;
5. the next role is permitted for the current state.

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

Setting `requireApproval: false` in the run config removes this gate: `DIAGNOSE` goes straight to `FIX`
on `APPLICATION_BUG`, in the same process, with no `testloop resume` step.

Either way, the fix role receives `projectInstructions`: the contents of the target project's own
root-level `AGENTS.md` and/or `SKILL.md`, when present, so the fix follows that project's conventions.

## Review gate

Retest cannot begin until an independent reviewer returns `APPROVED`. The reviewer must verify that the change:

- addresses the diagnosed root cause;
- does not weaken validation or authorization;
- does not bypass tenant or ownership checks;
- does not hide the error with broad exception handling;
- does not introduce unrelated refactoring;
- includes the necessary regression scope.

## Loop limits

Default MVP limits:

```json
{
  "maxFixtureAttempts": 2,
  "maxDiagnosisAttempts": 2,
  "maxFixAttempts": 2,
  "maxReviewCycles": 2,
  "maxRetestAttempts": 2,
  "maxAgentCallsPerWorkflow": 8
}
```

When a limit is reached, the workflow ends as `ESCALATED`; it never loops indefinitely.
