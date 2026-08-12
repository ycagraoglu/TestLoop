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
testloop build <project-file>
testloop serve <project-file> <base-url> <Development|Test>
testloop run <config-file>
testloop resume <run-id> <scenario-id> <approve|decline>
```

Do not invent command flags. When an interface is unclear, run `testloop --help` and use the documented command shape. TestLoop commands must not wait for interactive secrets or confirmations; provide required values through configuration, environment variables, or an already authenticated local tool.

## Non-negotiable rules

1. Never mark an endpoint `FAIL` until required fixtures and business preconditions are verified.
2. Never invent a random persisted foreign key merely to complete a request.
3. Treat HTTP 4xx and 5xx responses as evidence, not automatic proof of an application bug.
4. Do not modify source code before diagnosis classifies the result as `APPLICATION_BUG`.
5. Never invoke the fix role for a confirmed `APPLICATION_BUG` without explicit human approval via `testloop resume <run-id> <scenario-id> approve`, unless the run config sets `requireApproval: false`. When gated, a decline ends the scenario as `SKIPPED`, not a silent retry.
6. The agent that implements a fix must not approve its own fix.
7. Do not begin retesting before review returns `APPROVED`.
8. Do not weaken validation, authorization, tenant isolation, or ownership checks to make a test pass.
9. Do not run destructive or externally visible operations against production.
10. Preserve reproducible requests, responses, logs, fixture proofs, diffs, and review decisions.
11. Respect workflow and token budgets; escalate instead of looping indefinitely.

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

Run standard behavior plus negative, boundary, role, tenant, and regression scenarios. Use only when requested or justified by release risk.

## Workflow

Follow this exact sequence:

```text
DISCOVER → PLAN → RESOLVE_FIXTURES → PREPARE_AUTH → GENERATE_REQUEST
→ EXECUTE → VERIFY
```

If verification passes, complete the workflow.

If verification is unexpected:

```text
DIAGNOSE
  ├─ fixture problem → RESOLVE_FIXTURES
  ├─ authentication problem → PREPARE_AUTH
  ├─ environment problem → BLOCKED
  ├─ expected rejection → COMPLETE
  ├─ specification mismatch → REPORT
  ├─ inconclusive → REPORT
  └─ confirmed application bug
        ├─ requireApproval: false → FIX → REVIEW → RETEST
        └─ default (gated) → AWAITING_APPROVAL
              ├─ human declines → SKIPPED
              └─ human approves (`testloop resume ... approve`) → FIX → REVIEW → RETEST
```

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
