# TestLoop Roadmap

## Phase 0 — Architecture baseline

- [x] Define project purpose and non-negotiable trust rules
- [x] Define gated workflow and result classifications
- [x] Add the initial agent skill
- [x] Add a machine-readable workflow result contract
- [ ] Select the initial plugin host and compatibility target
- [ ] Select the license

## Phase 1 — Deterministic runner skeleton

- [ ] Discover `.sln` and Web API `.csproj` files
- [ ] Build and start an API in an isolated environment
- [ ] Locate and parse OpenAPI documents
- [ ] Execute and capture reproducible HTTP requests
- [ ] Persist run state under `.testloop/runs/<run-id>/`
- [ ] Validate role outputs against JSON Schema
- [ ] Enforce transition and retry budgets

## Phase 2 — ASP.NET Core project manifest

- [ ] Discover controller actions, routes, verbs, and response metadata
- [ ] Map request DTOs and validators
- [ ] Read authorization policies and roles
- [ ] Extract EF Core entities and foreign-key relationships
- [ ] Detect tenant, ownership, soft-delete, and active-state predicates
- [ ] Incrementally cache metadata using source hashes

## Phase 3 — Evidence-backed fixtures

- [ ] Reuse workflow-created fixtures
- [ ] Capture producer endpoint outputs
- [ ] Read seed metadata
- [ ] Resolve values through safe lookup endpoints
- [ ] Support read-only isolated test database queries
- [ ] Track creation and cleanup ownership
- [ ] Prohibit random persisted identifiers

## Phase 4 — Verification loop

- [ ] Run workflow-oriented happy paths
- [ ] Distinguish `PASS`, `FAIL`, `BLOCKED`, and `SPEC_MISMATCH`
- [ ] Package reproducible failure evidence
- [ ] Invoke diagnosis only for unexpected results
- [ ] Gate source modification behind confirmed application defects
- [ ] Require independent review before retest

## Phase 5 — Plugin packaging

- [ ] Add Claude Code adapter
- [ ] Add Codex adapter
- [ ] Add lifecycle hooks and command registration
- [ ] Add platform-neutral agent handoff contracts
- [ ] Publish installation and example project documentation

## Deferred scope

- Minimal APIs
- Dapper-only dependency discovery
- gRPC and GraphQL
- Distributed multi-service workflows
- Real payment, email, or SMS side effects
- Production execution
