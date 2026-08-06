# TestLoop agent instructions

Use the shared `skills/testloop/SKILL.md` workflow for controller-based ASP.NET Core Web API verification.

## Operating rules

- Start with project discovery and source analysis.
- Treat missing authentication, fixtures, tenant context, and business preconditions as `BLOCKED`; never invent persisted identifiers.
- Refuse production process startup and destructive production execution.
- Do not modify source code until evidence supports an `APPLICATION_BUG` diagnosis.
- Keep fixes minimal and preserve validation, authorization, ownership, and tenant-isolation checks.
- A fix must be independently reviewed before retesting.
- Preserve reproducible requests, responses, logs, fixture evidence, diffs, and review decisions under `.testloop/runs`.

## Local CLI

The plugin ships the TestLoop CLI with the repository. When a global `testloop` command is unavailable, run it from the plugin checkout:

```bash
node ./bin/testloop.js --help
node ./bin/testloop.js discover .
node ./bin/testloop.js analyze .
node ./bin/testloop.js run ./testloop.config.json
```

When the plugin host exposes its installation root, resolve `bin/testloop.js` relative to that root instead of assuming the current project contains TestLoop.
