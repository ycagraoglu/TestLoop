# TestLoop

**Test it. Fix it. Verify it.**

TestLoop is an agent-native verification workflow for ASP.NET Core Web APIs. It discovers endpoints, resolves valid test fixtures, executes real HTTP requests, diagnoses unexpected failures, applies evidence-based fixes, reviews those fixes independently, and reruns the original scenario.

## Core principle

An endpoint is never marked as failed until its authentication context, required dependencies, foreign keys, validation constraints, and relevant business preconditions have been verified.

## Initial scope

- ASP.NET Core controller-based Web APIs
- OpenAPI / Swagger
- Entity Framework Core
- FluentValidation and DataAnnotations
- JWT Bearer authentication
- SQL Server and PostgreSQL
- Development and isolated test environments

## Architecture

TestLoop combines three layers:

1. A deterministic local runner for project discovery, source analysis, OpenAPI parsing, HTTP execution, workflow state, and evidence capture.
2. LLM roles for business-rule interpretation, failure diagnosis, repair, and independent review.
3. A gated orchestrator that prevents invalid state transitions and unnecessary specialist-agent calls.

```text
Discover → Analyze → Plan → Resolve fixtures → Execute → Verify
                                                  │
                                                  └─ unexpected result
                                                            ↓
                                                  Diagnose → Fix → Review → Retest
```

## Runner

The deterministic runner is dependency-free and requires Node.js 20 or newer.

```bash
npm install
node ./bin/testloop.js discover .
node ./bin/testloop.js analyze .
node ./bin/testloop.js openapi https://localhost:7001/swagger/v1/swagger.json
node ./bin/testloop.js request GET https://localhost:7001/health
node ./bin/testloop.js workflow run-1 "POST /api/products" SUCCESS SUCCESS SUCCESS SUCCESS SUCCESS PASS
```

Available commands:

- `discover [root]`: finds `.sln` and `.csproj` files and identifies ASP.NET Core Web projects.
- `analyze [root]`: extracts controllers, routes, request DTOs, authorization metadata, FluentValidation rules, entities, and EF Core foreign-key evidence.
- `openapi <url>`: downloads an OpenAPI/Swagger document and emits its operations as structured JSON.
- `request <method> <url> [json-body]`: performs a real HTTP request and captures status, headers, body, and duration.
- `workflow <run-id> <target> [outcomes...]`: applies gated workflow transitions and enforces retry and agent-call budgets.

Run local checks with:

```bash
npm run check
npm test
```

## Safety and cost principles

- Never invent persisted foreign keys.
- Unresolved prerequisites produce `BLOCKED`, not `FAIL`.
- Deterministic work is done by the runner, not by an LLM.
- Successful paths avoid specialist subagents.
- Source code changes require confirmed application defects.
- Every fix requires independent review before retesting.
- Agent calls and repair loops have hard budgets.

## Status

Implemented:

- plugin/skill architecture and workflow contract;
- project and OpenAPI discovery;
- real HTTP execution;
- ASP.NET Core source manifest extraction;
- EF Core foreign-key evidence extraction;
- FluentValidation rule extraction;
- gated workflow transitions, fixture gate, failure classification, and cost budgets.

Next milestones are fixture acquisition, authentication context preparation, API process lifecycle management, persisted run artifacts, and plugin packaging.

## License

Apache-2.0
