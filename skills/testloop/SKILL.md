---
name: testloop
description: >
  Verify ASP.NET Core Web API behavior through evidence-backed fixtures, real HTTP execution,
  failure diagnosis, minimal repair, independent review, and retesting. Use when asked to test,
  validate, diagnose, repair, or regression-check controller-based ASP.NET Core API endpoints.
license: Apache-2.0
compatibility: Requires Node.js 20+ and an isolated Development or Test ASP.NET Core Web API environment.
metadata:
  author: ycagraoglu
  version: "0.5.0"
---

# TestLoop

TestLoop is a gated verification workflow for ASP.NET Core Web APIs.

## Invocation

Use one of these modes when the user requests a TestLoop run:

```text
smoke [scope]
standard [scope]
deep [scope]
```

Default to `standard` when the user does not choose a mode. Treat `scope` as the project, feature, controller, endpoint, or OpenAPI document the user wants tested.

The mode is applied where it belongs: `plan` and `scaffold` use it to decide what to generate, and a
run uses it only to refuse repairs in `smoke`. A deep run is therefore a standard run over a
configuration that already contains the extra scenarios.

## CLI usage

Confirm that the CLI is available before running a workflow:

```bash
testloop --help
```

Use the deterministic CLI for discovery, source analysis, OpenAPI inventory, planning, build, process startup, and workflow execution:

```bash
testloop discover <project-path>
testloop analyze <project-path>
testloop openapi <openapi-url>
testloop plan <openapi-url> <project-path> <smoke|standard|deep>
testloop scaffold <openapi-url> <project-path> <smoke|standard|deep>
testloop build <project-file>
testloop serve <project-file> <base-url> <Development|Test>
testloop run <config-file>
testloop resume <run-id> <scenario-id> <approve|decline>
```

`scaffold` prints a run configuration derived from the plan and the source manifest. Treat it as a
draft: fill in its `REPLACE_WITH_*` placeholders, add `roles` when the repair loop is wanted, and
confirm the proposed fixture endpoints before running it. It deliberately omits destructive
operations and credential endpoints; add those by hand only when the user asks.

Do not invent command flags. When an interface is unclear, run `testloop --help` and use the documented command shape. TestLoop commands must not wait for interactive secrets or confirmations; provide required values through configuration, environment variables, or an already authenticated local tool.

## Non-negotiable rules

1. Never mark an endpoint `FAIL` until required fixtures and business preconditions are verified.
2. Never invent a random persisted foreign key merely to complete a request.
3. Treat HTTP 4xx and 5xx responses as evidence, not automatic proof of an application bug.
4. Do not modify source code before diagnosis classifies the result as `APPLICATION_BUG`.
5. Never invoke the fix role for a confirmed `APPLICATION_BUG` without explicit human approval via `testloop resume <run-id> <scenario-id> approve`, unless the run config sets `requireApproval: false`. When gated, a decline ends the scenario as `SKIPPED`, not a silent retry.
6. The agent that implements a fix must not approve its own fix.
7. Do not begin retesting before review returns `APPROVED`.
8. Treat a repair that breaks a previously passing scenario as failed, however well it fixed its own target.
9. Do not weaken validation, authorization, tenant isolation, or ownership checks to make a test pass.
10. Do not run destructive or externally visible operations against production.
11. Preserve reproducible requests, responses, logs, fixture proofs, diffs, and review decisions.
12. Report `BLOCKED` or `ESCALATED` instead of retrying a failed step; the pipeline is single-pass by design.

## Supported MVP profile

- controller-based ASP.NET Core Web API;
- OpenAPI / Swagger;
- Entity Framework Core;
- FluentValidation or DataAnnotations;
- JWT Bearer authentication;
- SQL Server or PostgreSQL;
- isolated Development or Test environment.

Unsupported or unsafe capabilities must be reported as `BLOCKED`, not guessed around.

## Modes

### smoke

Use cached project metadata and known fixtures. Execute happy-path checks and detect unexpected 5xx responses or contract mismatches. Do not repair code.

### standard

Resolve fixtures, authenticate, execute valid workflow-oriented tests, diagnose failures, apply a minimal fix when a defect is confirmed, review independently, and retest.

### deep

Standard behavior, plus the checks that prove an endpoint refuses what it should refuse. `testloop
scaffold <openapi-url> <project-path> deep` generates them from the analyzed source, so they are
visible in the configuration and can be edited or removed before the run:

- an unauthenticated call to every endpoint carrying `[Authorize]`, expecting `401` or `403`;
- one request per declared validation rule, breaking that rule alone and leaving the rest of the
  request valid, expecting `400` or `422`;
- a lookup for an identifier that cannot exist, expecting `404`.

A request that succeeds where a scenario demands refusal is `FAIL` / `REJECTION_NOT_ENFORCED`: no
unmet precondition can explain it, so it is reported as a fault rather than as inconclusive.

Not generated, because nothing in the source establishes them: role-specific rejections need a second
set of credentials, and tenant isolation needs a tenant model that this profile does not describe.
Write those by hand. Regression coverage is not generated either — it happens automatically after
every repair.

Use deep only when requested or justified by release risk.

## Workflow

Follow this exact sequence:

```text
DISCOVER → PLAN → RESOLVE FIXTURES → AUTHENTICATE → BUILD REQUEST
→ EXECUTE → VERIFY
```

If verification passes, complete the workflow.

If verification is unexpected, `testloop run` classifies it first, and only a 5xx with every
precondition already evidenced reaches the `diagnose` role. Each branch below ends the scenario:
nothing loops back, so report `BLOCKED` or `ESCALATED` rather than retrying a step.

```text
DIAGNOSE
  ├─ fixture problem → BLOCKED
  ├─ authentication problem → BLOCKED
  ├─ environment problem → BLOCKED
  ├─ expected rejection → PASS
  ├─ specification mismatch → SPEC_MISMATCH (reported, never repaired)
  ├─ inconclusive → BLOCKED
  └─ confirmed application bug
        ├─ mode: smoke → FAIL (reported, never repaired)
        ├─ requireApproval: false → FIX → REVIEW → RETEST
        └─ default (gated) → AWAITING_APPROVAL
              ├─ human declines → SKIPPED
              └─ human approves (`testloop resume ... approve`) → FIX → REVIEW → RETEST
                    └─ RETEST passed → REGRESSION SWEEP over everything that already passed
                          ├─ all still pass → PASS (PASS_AFTER_FIX)
                          └─ any now fails → FAIL (REGRESSION_DETECTED)
```

A role adapter that times out, exits non-zero, or returns a status outside its contract ends that
scenario as `ESCALATED` / `RUNNER_ERROR`. The run continues and still writes its evidence trail.

## Efficient agent use

The normal success path should remain in one test-analysis context. Open a specialist only when its expected value exceeds its context cost.

Specialists may be used for:

- ambiguous fixture or tenant resolution;
- failure diagnosis;
- confirmed bug implementation;
- independent review.

Do not open a subagent for deterministic work such as OpenAPI parsing, HTTP execution, schema validation, retry counting, state persistence, or diff generation when the runner can perform it.

## Fixture evidence

Resolve persisted dependencies in this order:

1. current workflow fixture;
2. producer endpoint response;
3. test seed;
4. safe lookup endpoint;
5. read-only isolated test database query;
6. safe creation endpoint;
7. otherwise `BLOCKED`.

For each resolved dependency, record its value, source, existence, tenant or ownership match, status predicates, and creation/cleanup responsibility.

Records the run creates are listed in `created.json` whatever the configuration says. They are removed
only when the run sets `cleanup: true`, which is what makes a run repeatable; without it the run
reports what it left behind and leaves it there. Never enable cleanup against an environment whose
data someone else depends on.

## Result classification

Return one of:

- `PASS`
- `FAIL`
- `BLOCKED`
- `EXPECTED_REJECTION`
- `SPEC_MISMATCH`
- `INCONCLUSIVE`
- `AWAITING_APPROVAL`
- `SKIPPED`
- `ESCALATED`

Only `APPLICATION_BUG` diagnosis with verified preconditions may lead to source modification, and only after a human approves the `AWAITING_APPROVAL` gate via `testloop resume`.

## Repair rules

A fix must:

- follow the target project's own `AGENTS.md`/`SKILL.md` conventions when present (passed to the fix role as `projectInstructions`);
- rebuild and restart the API so the retest reaches the fixed build; TestLoop replays the request against whatever is listening and rebuilds nothing;
- target the root cause;
- use the smallest safe diff;
- avoid unrelated refactoring;
- preserve public contracts unless the contract is itself proven wrong;
- preserve security and isolation checks;
- leave a reproducible verification trail.

## Completion

A repaired scenario is complete only when:

1. the reviewer approved the diff;
2. the original request passes using verified fixtures;
3. required related regression checks pass;
4. the final report lists evidence, changes, remaining risks, and blocked coverage.

Every run writes that report to `.testloop/runs/<run-id>/report.md`, whatever its outcome. Read it
before reporting a result to the user: its **Not verified** section states the limits of the verdict,
which a passing run needs said out loud more than a failing one does.
