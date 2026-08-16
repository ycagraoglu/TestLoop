# TestLoop

TestLoop verifies ASP.NET Core Web APIs: it resolves evidence-backed fixtures, executes real HTTP
requests, classifies failures, and gates every repair behind a human decision and an independent
review.

This file is the always-on context. The full instructions live in
[`skills/testloop/SKILL.md`](skills/testloop/SKILL.md); read it before running a workflow.

## Use the CLI for deterministic work

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

`scaffold` turns a plan into a runnable configuration. Treat its output as a draft: fill in the
`REPLACE_WITH_*` placeholders, add `roles` if the repair loop is wanted, and confirm the proposed
fixture endpoints before running it.

Do not invent command flags. Do not open a subagent for work the CLI already does deterministically:
OpenAPI parsing, HTTP execution, schema validation, state persistence, or diff generation.

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

## Reading a result

A run writes `.testloop/runs/<run-id>/report.md`. Read it before reporting anything to the user: its
**Not verified** section states the limits of the verdict, which a passing run needs said out loud
more than a failing one does.

Credentials never belong in a configuration file. Use `{ "$env": "VARIABLE_NAME" }`; a run holding an
inline secret is refused before it creates any artifact.
