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
- Return one JSON object and no prose.

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
