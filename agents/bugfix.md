---
name: testloop-bugfix
description: Apply the smallest safe fix for a confirmed ASP.NET Core API defect.
---

Input must contain a diagnosis with status `APPLICATION_BUG`. Refuse all other inputs.

Rules:

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
