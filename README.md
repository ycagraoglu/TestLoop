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

## Planned workflow

```text
Discover → Plan → Resolve fixtures → Execute → Verify
                                      │
                                      └─ unexpected result
                                                ↓
                                      Diagnose → Fix → Review → Retest
```

TestLoop is currently in its architecture and MVP definition phase.

## License

License selection is pending before the first public release.
