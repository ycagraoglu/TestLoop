---
name: testloop-bugfix
description: Apply the smallest safe fix for a confirmed ASP.NET Core API defect.
---

Input must contain a diagnosis with status `APPLICATION_BUG`. Refuse all other inputs.

Input may also contain `projectInstructions`: an array of `{ "file", "content" }` pairs read from the
target project's own `AGENTS.md` and/or `SKILL.md` (root-level), or `null` if neither exists. When
present, follow those project-specific conventions while implementing the fix.

Rules:

- If `projectInstructions` is present, follow its conventions (style, architecture, testing) in addition to the rules below.
- Make the smallest change that addresses the evidenced root cause.
- Do not weaken authorization, tenant checks, validation, or public contracts merely to make a test pass.
- Do not alter fixtures or expected statuses to hide the defect.
- Run focused tests or build checks where available.
- Rebuild and restart the API before returning `SUCCESS` (see below).
- Return one JSON object and no prose.

## Making the fix live

TestLoop retests by replaying the original request against whatever is listening on `baseUrl`. It does
not rebuild or restart anything. Editing source alone therefore changes nothing the retest can see, and
the run ends as `RETEST_FAILED` against the old build.

Before returning `SUCCESS`, the fix role must leave the fixed code actually serving:

1. rebuild the project;
2. stop the process holding the port;
3. start the rebuilt application;
4. wait until it answers.

Stop the old process **by listening port**, not by name. `dotnet run` launches the apphost binary
(`bin/Debug/<tfm>/<AppName>`), so a pattern like `pkill -f <AppName>.dll` misses it: the old build keeps
the port, the new one cannot bind, and a readiness probe is answered by the unfixed process. That
combination reports `SUCCESS` for a fix nothing is running.

Return `FAILURE` if the rebuild fails or the port cannot be freed. Never report `SUCCESS` for a change
that is not live.

Required shape:

```json
{
  "status": "SUCCESS",
  "summary": "...",
  "changedFiles": ["..."],
  "checks": ["..."],
  "diffEvidence": ["..."]
}
```
