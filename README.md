# TestLoop

**Test it. Fix it. Verify it.**

TestLoop is an agent-native verification workflow and deterministic CLI for controller-based ASP.NET Core Web APIs. It discovers endpoints, resolves evidence-backed fixtures, executes real HTTP requests, classifies failures, repairs confirmed defects through independent roles, and retests only after approval.

The repository contains one portable Agent Skills-compatible core at `skills/testloop/SKILL.md`. Claude Code, Codex, Copilot-compatible plugin hosts, and instruction-file-based agents reuse that same skill instead of maintaining separate testing logic.

## Trust rule

An endpoint is never marked as failed until authentication, persisted dependencies, foreign keys, validation constraints, tenant context, and relevant business preconditions are verified. Unresolved preconditions are `BLOCKED`, never fake failures.

## Plugin installation

Node.js 20 or newer must be available on `PATH`. The plugin repository already contains `bin/testloop.js` and `src/`, so npm publication is not required for plugin-based use.

### Claude Code

Run these as two separate commands inside Claude Code:

```text
/plugin marketplace add ycagraoglu/TestLoop
/plugin install testloop@testloop
```

### Codex CLI and Codex desktop

```bash
codex plugin marketplace add ycagraoglu/TestLoop
codex plugin add testloop@testloop
```

Restart Codex after installation. The Codex manifest is stored at `.codex-plugin/plugin.json` and points to the shared `skills/` directory.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add ycagraoglu/TestLoop
copilot plugin install testloop@testloop
```

Plugin command support depends on the installed Copilot CLI version. Agents that do not support plugin installation can still consume `skills/testloop/SKILL.md` or the repository-level `AGENTS.md` fallback.

## Local development installation

```bash
git clone https://github.com/ycagraoglu/TestLoop.git
cd TestLoop
npm install
npm run verify
npm link
```

After `npm link`, verify the global development command:

```bash
testloop --help
```

## Verification

```bash
npm run verify
```

This runs:

- JavaScript syntax checking;
- Agent Skills specification validation;
- Claude marketplace and Codex plugin manifest validation;
- automated tests;
- npm package-content verification.

Individual metadata checks:

```bash
npm run skill:check
npm run plugin:check
```

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

When no global command is installed, run the bundled CLI from a TestLoop checkout or plugin root:

```bash
node ./bin/testloop.js discover .
node ./bin/testloop.js analyze .
node ./bin/testloop.js run ./testloop.config.json
```

Copy `templates/testloop.config.example.json` into the target API repository and adapt it. Run evidence is written under `.testloop/runs/<run-id>`.

## Shared core and adapters

```text
skills/testloop/SKILL.md       shared Agent Skill
bin/ and src/                  deterministic TestLoop CLI
.claude-plugin/                Claude marketplace adapter
.codex-plugin/plugin.json      Codex plugin adapter
AGENTS.md                      portable instruction fallback
agents/                        diagnosis, fix, and review role contracts
schemas/ and templates/        machine-readable contracts and configuration
```

The platform adapters package and discover the shared skill; they do not duplicate TestLoop's workflow rules.

## Implemented MVP

- `.sln` and `.csproj` discovery;
- ASP.NET Core controllers, routes, actions, DTOs, authorization, validators, entities, and EF Core FK analysis;
- OpenAPI operation inventory and feature-oriented planning;
- deterministic payload generation and verified fixture acquisition;
- JWT bearer and login-based authentication contexts;
- real HTTP execution with structured evidence;
- safe Development/Test build and process lifecycle;
- gated classification, repair, independent review, and retesting;
- production refusal and security-preserving repair rules.

## Agent integration

Expensive agent roles are called only for unexpected results that survive fixture and authentication checks. Role commands receive one JSON object on stdin and return one JSON object on stdout.

```json
{
  "roles": {
    "diagnose": { "command": ["my-agent-cli", "diagnose"] },
    "fix": { "command": ["my-agent-cli", "fix"] },
    "review": { "command": ["my-independent-agent-cli", "review"] }
  }
}
```

The fix and review roles must not be the same session.

## Safety

- Production process startup is refused.
- Persisted IDs are never randomly generated.
- Supplied foreign keys still require verification evidence.
- Authorization, validation, tenant isolation, ownership, and public contracts may not be weakened to make tests pass.
- Destructive or external-side-effect scenarios must be explicitly configured.
- Missing agent commands produce an unavailable or escalated result instead of pretending a fix occurred.

## Local release workflow

Run a dry-run from a clean `main` branch:

```bash
npm run release:check -- 0.5.1 --notes "Describe the release"
```

The release script keeps package, lockfile, shared skill, Claude plugin, Codex plugin, marketplace, and changelog versions synchronized. GitHub Actions are intentionally not required.

## License

Apache-2.0
