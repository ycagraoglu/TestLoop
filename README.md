# TestLoop

**Test it. Fix it. Verify it.**

TestLoop is an agent-native verification workflow for ASP.NET Core Web APIs. It discovers endpoints, resolves valid fixtures, executes real HTTP requests, classifies failures, and pauses a confirmed defect for explicit human approval before delegating it to independent diagnosis/fix/review roles and retesting.

TestLoop includes an [Agent Skills](https://agentskills.io/) compatible skill at `skills/testloop/SKILL.md` and a deterministic CLI that performs the underlying project analysis and test execution.

## What TestLoop supports

Read this first. Most surprises come from pointing it at a project shaped differently than it reads.

| Area | Support | Notes |
| --- | --- | --- |
| Controller-based ASP.NET Core | **Full** | Routes, actions, `[Authorize]`, request models, entities and EF Core foreign keys are read from source. |
| Minimal APIs (`app.MapGet(...)`) | **Partial** | HTTP execution, scaffolding from OpenAPI and the whole repair loop work. Source analysis does not, so request models, validator-derived boundary tests and foreign-key fixtures must be written by hand. `analyze` says so rather than returning a silent zero. |
| OpenAPI / Swagger document | **Required** for `plan`, `scaffold` and response-contract checking | `run` itself does not need one. |
| EF Core foreign keys | **Yes** | `HasOne<T>(...).HasForeignKey(...)`. Other configurations fall back to matching a `<Entity>Id` property against a discovered entity. |
| FluentValidation | **Yes** | `NotEmpty`, `MinimumLength`, `MaximumLength`, `GreaterThan` become deterministic payloads and deep-mode boundary tests. |
| DataAnnotations | **Partial** | `[Required]` is read. `[Range]`, `[MaxLength]` and friends are not turned into boundary tests. |
| JWT bearer, and login endpoints taking a JSON body | **Yes** | The token is attached to every request, including fixture lookups, and refreshed before a retest. |
| OAuth2 token endpoints (Keycloak, IdentityServer, Auth0, Azure AD) | **No** | They require a form-encoded body, and credentials cannot be referenced safely there yet. |
| Multi-tenancy | **Not modelled** | A tenant-header override check can be written by hand; running a scenario as a second identity is not supported. |
| Test-database access | **No** | Fixtures come from HTTP endpoints only. |
| Destructive scenarios (`DELETE`) | **Opt-in** | Never scaffolded automatically; `cleanup: true` removes only records the run itself created. |

**Environments.** Node.js 20 or newer is declared; development and testing so far have been on Node 23,
macOS, and .NET 10 against controller-based projects. Windows and older .NET versions are not yet
verified — reports from those are welcome and are the most useful kind of issue to open.

## Trust rule

An endpoint is never marked as failed until authentication, persisted dependencies, foreign keys, validation constraints, tenant context, and relevant business preconditions are verified. Unresolved preconditions are `BLOCKED`, never fake failures.

## Implemented MVP

- `.sln` and `.csproj` discovery
- ASP.NET Core controller, route, action, DTO, authorization, FluentValidation, entity, and EF Core FK analysis
- OpenAPI operation inventory and feature-oriented test planning
- deterministic payload generation
- verified fixture acquisition from static evidence, workflow outputs, safe HTTP list endpoints, and cycle-limited create-if-missing entities (`ensure-entity`)
- JWT bearer and login-based authentication contexts
- real HTTP execution with structured evidence
- persisted `.testloop/runs/<run-id>` artifacts
- safe `dotnet build` and Development/Test API process lifecycle
- failure classification that attributes a result to its failed precondition before blaming the application
- external diagnosis, bugfix, and independent review role adapters
- confirmed application bugs pause at `AWAITING_APPROVAL` by default; the fix role only runs after `testloop resume ... approve` (or immediately when `requireApproval: false`), and a decline ends the scenario as `SKIPPED`; either way, `resume` then continues any later scenarios that hadn't run yet
- the fix role receives the target project's own root-level `AGENTS.md`/`SKILL.md` as `projectInstructions` when present, so fixes follow existing project conventions
- retest only after review returns `APPROVED`, then a regression sweep re-runs every scenario that had already passed; a fix that breaks one of them is `REGRESSION_DETECTED`, never a green run
- optional response-shape checking against the published OpenAPI document (`openApiUrl`): a body that breaks its declared contract is `SPEC_MISMATCH`, decided in code rather than by an agent
- `scaffold ... deep` generates the negative checks that prove refusals: anonymous access to protected endpoints, one request per validation rule, and lookups for identifiers that cannot exist; a call that succeeds where refusal was demanded is `REJECTION_NOT_ENFORCED`
- every run writes a human-readable `report.md` stating not just what passed, but what it left behind and what it never verified
- every record a run creates is listed in `created.json`; `cleanup: true` then removes them in reverse order, making a run repeatable without ever touching data it did not create
- Agent Skills compatible metadata and instructions
- Claude-style plugin metadata, role prompts, schemas, and configuration template

## Install and verify

```bash
npm install
npm run verify
npm link
```

Node.js 20 or newer is required. The runner has no runtime npm dependencies. Verification is intentionally local and does not require GitHub Actions.

`npm run verify` performs JavaScript syntax checks, Agent Skills specification checks, automated tests, and npm package-content verification. The skill check can also be run independently:

```bash
npm run skill:check
```

## Agent Skill

The portable skill is located at:

```text
skills/testloop/SKILL.md
```

Its frontmatter uses the standard `name`, `description`, `license`, `compatibility`, and `metadata` fields. The skill documents the `smoke`, `standard`, and `deep` modes and instructs compatible agents to delegate deterministic operations to the TestLoop CLI.

Clients that use the cross-client `.agents/skills/` discovery convention can install or copy the `skills/testloop` directory into:

```text
.agents/skills/testloop/
```

The Agent Skills specification defines the contents of a skill directory; installation and discovery locations may vary by client.

## Commands

```bash
testloop discover .
testloop analyze .
testloop openapi http://127.0.0.1:5099/swagger/v1/swagger.json
testloop plan http://127.0.0.1:5099/swagger/v1/swagger.json . standard
testloop scaffold http://127.0.0.1:5099/swagger/v1/swagger.json . standard > testloop.config.json
testloop build ./src/MyApi/MyApi.csproj
testloop serve ./src/MyApi/MyApi.csproj http://127.0.0.1:5099 Development
testloop run ./testloop.config.json
testloop resume <run-id> <scenario-id> approve
testloop resume <run-id> <scenario-id> decline
```

`testloop scaffold` turns a plan into a runnable configuration: it carries the analyzed request model,
validator rules and foreign-key dependencies into each scenario, proposes the collection endpoint each
dependency can be read from, and chains `/things/{id}` to the `POST /things` that creates what it
addresses. Destructive operations and credential endpoints are left out, and the auth block is a
skeleton with an `$env` reference — a run refuses to start on an inline secret. Review the result
before running it: it is a draft, not an authority, and every fixture it proposes is still verified at
run time or the scenario blocks.

Alternatively, copy `templates/testloop.config.example.json` and adapt it by hand. Run evidence is
written under `.testloop/runs`.

## Local release workflow

GitHub Actions is not required for verification, packaging, tagging, npm publication, or GitHub Release creation.

Before the first publication, authenticate the local machine:

```bash
npm login
gh auth login
```

Run a release dry-run from a clean, up-to-date local `main` branch:

```bash
npm run release:check -- 0.5.1 --notes "Describe the release"
```

The dry-run restores all changed version files after validation.

Publish the release:

```bash
npm run release -- 0.5.1 --notes "Describe the release"
```

The release command performs these checks and operations in order:

1. Requires a clean local `main` branch that exactly matches `origin/main`.
2. Verifies npm and GitHub CLI authentication.
3. Updates `package.json`, `package-lock.json`, Claude plugin metadata, and `CHANGELOG.md`.
4. Runs syntax checks, Agent Skills validation, tests, and npm package-content verification.
5. Creates the release commit and annotated Git tag.
6. Publishes the public npm package from the local machine.
7. Pushes the release commit and tag to GitHub.
8. Creates the GitHub Release through `gh release create`.

If npm publication fails, the local release commit and tag are rolled back. To publish without creating a GitHub Release, pass `--skip-github-release`. No GitHub repository secret or paid Actions runner is needed.

## Agent integration

TestLoop does deterministic work itself. Expensive agent roles are called only for unexpected results that survive fixture and authentication checks. Role commands receive one JSON object on stdin and must return one JSON object on stdout.

```json
{
  "roles": {
    "diagnose": { "command": ["my-agent-cli", "diagnose"] },
    "fix": { "command": ["my-agent-cli", "fix"] },
    "review": { "command": ["my-independent-agent-cli", "review"] }
  }
}
```

Role contracts are documented in `agents/`. The fix and review roles must not be the same session.

When the target project (`root`) has a root-level `AGENTS.md` or `SKILL.md`, its content is passed to the fix role as `projectInstructions` so fixes follow that project's own conventions.

## Safety

- A confirmed application bug never reaches the fix role without an explicit `testloop resume <run-id> <scenario-id> approve`, unless `requireApproval: false` opts into immediate fixing; declining (when gated) marks the scenario `SKIPPED`.
- Credentials live in the environment, never in the config: a run whose `auth` holds an inline secret is refused, and `{ "$env": "NAME" }` pointers are resolved in memory. Persisted artifacts keep the pointer and never the value.
- An authentication failure mid-run is reported as `BLOCKED` / `AUTH_ERROR`, never as a test failure or an application bug.
- Production process startup is refused.
- Persisted IDs are never randomly generated.
- Supplied foreign keys still require verification evidence.
- Authorization, validation, tenant isolation, and public contracts may not be weakened to make tests pass.
- Destructive and external-side-effect scenarios must be explicitly included by the user configuration.
- Cleanup deletes only what the run itself recorded creating, and only when `cleanup: true`; it is skipped entirely while a decision is pending.
- Missing agent commands produce an unavailable/escalated result rather than pretending a fix occurred.

## Scope

The MVP targets controller-based ASP.NET Core APIs, OpenAPI, EF Core, FluentValidation/DataAnnotations, JWT authentication, and isolated Development/Test environments. Complex dynamic C# constructs may require explicit configuration because source analysis is intentionally dependency-free and conservative.

## License

Apache-2.0
