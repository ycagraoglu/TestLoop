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
  ├─ expected status ──────────────────→ PASS  (body also checked, if openApiUrl is set,
  │                                             so a broken shape is SPEC_MISMATCH)
  ├─ success where refusal was demanded → FAIL (REJECTION_NOT_ENFORCED)
  ├─ AUTH_ERROR / FIXTURE_ERROR / ENVIRONMENT_ERROR / INCONCLUSIVE
  │                                    → BLOCKED, without calling any role
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
                                       ├─ reproduces the defect → FAIL (RETEST_FAILED)
                                       ├─ neither → BLOCKED (RETEST_INCONCLUSIVE)
                                       └─ expected status
                                                     ↓
                                         REGRESSION SWEEP
                                    (everything that already passed)
                                       ├─ all still pass → PASS (PASS_AFTER_FIX)
                                       └─ any now fails → FAIL (REGRESSION_DETECTED)
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

## Credentials

`auth.type: "login"` posts the configured body to the token endpoint and attaches the resulting JWT
to every later request, including fixture lookups. `auth.type: "bearer"` reads an existing token from
`tokenEnv`. Either way the secret comes from the environment: a config holding an inline credential is
refused before the run creates any artifact, and `{ "$env": "NAME" }` pointers are resolved in memory
only. The persisted `config.json` keeps the pointer so `resume` can re-authenticate; `auth.json` keeps
the evidence but redacts the token and drops the login response entirely.

The check reads strings as well as keys. A raw string body is currently the only way to send
form-encoded content, and it hides its credentials from any key-based inspection — an object key
named `body` looks harmless while `password=…&client_secret=…` sits inside its value. Such a string
is refused in `auth`, and redacted anywhere else in the config before it is persisted. Sending
form-encoded credentials safely needs first-class support, which does not exist yet: a standard
OAuth2 token endpoint (Keycloak, IdentityServer, Auth0, Azure AD) cannot be used as the login URL
today, because `{ "$env": … }` is resolved in objects, not inside strings.

A scenario may not set a credential header of its own. Authentication comes from the run's `auth`,
and `anonymous: true` withholds it; anything else is refused before the run starts. Writing a second
identity's token into a scenario appears to work and then fails silently, because the persisted
config redacts the value and a resumed run sends the literal string `[REDACTED]`. Running a scenario
as a second identity is not supported yet — a header that carries test intent rather than a
credential, such as a tenant override, is unaffected.

If the token endpoint fails or the token is missing at `tokenPath`, the run ends `BLOCKED` without
executing a single scenario. A 401 or 403 *during* a scenario is classified `AUTH_ERROR` and reported
as `BLOCKED` — unless the scenario expected that status, which is a `PASS` (deep mode asserts 401/403
on purpose for role and tenant checks). There is no token refresh mid-run; authentication is resolved
once per run and again immediately before a retest.

## Contract checking

Set `openApiUrl` and a response that meets its expected status is also checked against the schema the
API publishes for it. A body that breaks the declared shape is `SPEC_MISMATCH`, decided in code rather
than by a role, because a missing required property or an array where an object was promised is a fact.

The checks are deliberately narrow, since a false `SPEC_MISMATCH` sends someone to debug an endpoint
that is behaving correctly. Structure and primitive types are checked; `oneOf`/`anyOf`, string formats,
patterns, numeric bounds and extra properties are not. An unmapped path or a status with no declared
response is skipped rather than guessed at.

The value of this depends entirely on how precise the published document is, and generated documents
are often loose. ASP.NET Core's default OpenAPI output, for example, emits no `required` array and
widens numeric properties to accept strings, so a response missing half its fields still satisfies it.
What that document does still pin down — an array that became an object, a string that became a
number — is caught.

## Regression sweep

A repair is only acceptable if it left everything else standing, so after a retest passes, every
scenario that had already passed is executed again against the fixed application. If any of them now
fails, the repaired scenario becomes `FAIL` / `REGRESSION_DETECTED` and names what it broke: retesting
the repaired scenario alone proves the reported defect is gone and nothing more.

The sweep re-runs writes as well as reads, because a regression check that skips mutations is not a
regression check. Its evidence is written alongside the original under a `.regression` label, so the
run it is being compared against stays intact. Set `regressionCheck: false` to skip the sweep,
accepting the risk in exchange for not repeating side effects.

## Proving refusals

A guard is only proven to exist by watching it reject something, and a missing `[Authorize]` or a
validator that was never wired up passes every happy-path scenario ever written. `scaffold ... deep`
generates the scenarios that try: an unauthenticated call to each protected endpoint, one request per
declared validation rule breaking that rule alone, and a lookup for an identifier that cannot exist.

`anonymous: true` on a scenario withholds the credentials the rest of the run uses, which is what
makes the first of those possible.

Each expectation accepts the family of statuses that mean the same thing (`401` or `403`, `400` or
`422`), because a scenario that fails over which rejection code was chosen teaches nobody anything.
When such a scenario is answered with success instead, the result is `FAIL` /
`REJECTION_NOT_ENFORCED` — the one shape of unexpected 2xx that no precondition can explain.

## The report

Every run writes `report.md` next to its artifacts, including a run that never got past the login.
`summary.json` is for machines; this is what a person reads before deciding whether to trust the
verdict.

Beyond the outcome of each scenario, it carries three sections that qualify that outcome:

- **Changes** — what was modified, who approved it, and what the regression sweep found afterwards.
- **Remaining risks** — failures, contract violations, decisions still waiting on a person, and any
  records the run left in the environment.
- **Not verified** — the limits of the verdict. Scenarios that could not proceed, and the questions
  the configuration never asked: no contract document, refusals not exercised outside deep mode, a
  disabled regression sweep. A passing run needs this stated more than a failing one does, because a
  green result is only ever as broad as what was actually executed.

## What a run leaves behind

TestLoop writes: `ensure-entity` creates records to satisfy foreign keys, scenarios exercise POST
endpoints, and the regression sweep repeats those writes on every repair. Two separate concerns
follow, and they are deliberately not the same setting.

**Recording is unconditional.** Every record the run created is listed in `created.json` with the
collection that produced it and what caused it, so a run can always say exactly what it left behind.
This is what the fixture evidence rules mean by creation responsibility.

**Removing is opt-in.** Deleting is a destructive operation and this tool does not perform those
unless asked, so `cleanup: true` is required. It then deletes each recorded resource in reverse
creation order, inferring the route from the collection that produced it
(`DELETE <collection>/<id>`). That is a convention rather than a fact, so every attempt is recorded
in `cleanup.json` and a failure never changes the verification verdict. Nothing the run did not
create is ever touched.

Cleanup is skipped while a run is paused at `AWAITING_APPROVAL`: the pending retest replays a request
that depends on those records, so removing them would sabotage a decision the human has not made yet.
`testloop resume` reloads the ledger and finishes the job once the run is really over.

With cleanup enabled a run is repeatable — the same configuration twice leaves the same state, rather
than accumulating a new record each time.

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
