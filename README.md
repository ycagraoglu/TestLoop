# TestLoop

**Test it. Fix it. Verify it.**

TestLoop is an agent-native verification workflow for ASP.NET Core Web APIs. It discovers endpoints, resolves valid fixtures, executes real HTTP requests, classifies failures, delegates confirmed defects to independent diagnosis/fix/review roles, and retests only after approval.

TestLoop includes an [Agent Skills](https://agentskills.io/) compatible skill at `skills/testloop/SKILL.md` and a deterministic CLI that performs the underlying project analysis and test execution.

## Trust rule

An endpoint is never marked as failed until authentication, persisted dependencies, foreign keys, validation constraints, tenant context, and relevant business preconditions are verified. Unresolved preconditions are `BLOCKED`, never fake failures.

## Implemented MVP

- `.sln` and `.csproj` discovery
- ASP.NET Core controller, route, action, DTO, authorization, FluentValidation, entity, and EF Core FK analysis
- OpenAPI operation inventory and feature-oriented test planning
- deterministic payload generation
- verified fixture acquisition from static evidence, workflow outputs, and safe HTTP list endpoints
- JWT bearer and login-based authentication contexts
- real HTTP execution with structured evidence
- persisted `.testloop/runs/<run-id>` artifacts
- safe `dotnet build` and Development/Test API process lifecycle
- gated workflow state, classification, retry budgets, and agent-call budgets
- external diagnosis, bugfix, and independent review role adapters
- retest only after review returns `APPROVED`
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
testloop build ./src/MyApi/MyApi.csproj
testloop serve ./src/MyApi/MyApi.csproj http://127.0.0.1:5099 Development
testloop run ./testloop.config.json
```

Copy `templates/testloop.config.example.json` and adapt it to the target API. Run evidence is written under `.testloop/runs`.

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

## Safety

- Production process startup is refused.
- Persisted IDs are never randomly generated.
- Supplied foreign keys still require verification evidence.
- Authorization, validation, tenant isolation, and public contracts may not be weakened to make tests pass.
- Destructive and external-side-effect scenarios must be explicitly included by the user configuration.
- Missing agent commands produce an unavailable/escalated result rather than pretending a fix occurred.

## Scope

The MVP targets controller-based ASP.NET Core APIs, OpenAPI, EF Core, FluentValidation/DataAnnotations, JWT authentication, and isolated Development/Test environments. Complex dynamic C# constructs may require explicit configuration because source analysis is intentionally dependency-free and conservative.

## License

Apache-2.0
