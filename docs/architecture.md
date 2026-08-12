# TestLoop Architecture

## Objective

TestLoop verifies ASP.NET Core API behavior using evidence-backed test data and a gated repair loop. It combines a small deterministic runner with narrowly scoped LLM roles.

## Design principles

1. Deterministic work is performed by code, not by an LLM.
2. Valid fixtures must be proven before a test can produce `FAIL`.
3. Subagents are opened only when ambiguity or a confirmed defect justifies their cost.
4. The agent that implements a fix cannot approve that fix.
5. Every role returns a machine-readable result, validated against its contract before it is acted on.
6. Production and unsafe side-effect environments are blocked by default.
7. The repair pipeline is single-pass: nothing retries, so nothing can loop.

## Components

### Plugin adapter

Provides installation, command registration, lifecycle hooks, and platform-specific integration for coding agents.

### Deterministic runner

Responsible for:

- locating solutions and Web API projects;
- building and starting the API;
- loading OpenAPI documents;
- executing HTTP requests;
- capturing logs and correlation identifiers;
- validating JSON contracts;
- persisting run artifacts and the pending-approval state;
- enforcing the fixture, approval, and review gates;
- producing reproducible evidence artifacts.

### Project manifest

A reusable, incrementally refreshed representation of:

- controllers and endpoints;
- request and response models;
- validators;
- authorization metadata;
- EF Core entities and relationships;
- potential producer-consumer links;
- tenant and soft-delete patterns.

### LLM roles

The MVP configures three external role adapters, each an executable receiving one JSON object on
stdin and returning one JSON object on stdout (contracts in `agents/`):

- **`diagnose`** (Failure Diagnostician): distinguishes test-data, environment, contract, and
  application failures.
- **`fix`** (Bugfix Agent): applies the smallest root-cause correction after a defect is confirmed
  and a human has approved it.
- **`review`** (Review Agent): independently checks correctness, security, scope, and regression
  risk. Must not be the same session as `fix`.

Sequencing is the runner's job, not a role's; there is no coordinator agent.

### Evidence store

Each run writes immutable artifacts beneath `.testloop/runs/<run-id>/`, including manifests, requests, responses, logs, diagnoses, diffs, reviews, and retest results.

## Cost model

The normal success path should require one reasoning context and no specialist subagent. Expensive roles activate only for unresolved fixtures, ambiguous failures, confirmed defects, or independent review.

## Trust model

A result may be:

- `PASS`: a verified scenario produced the expected behavior;
- `FAIL`: verified preconditions existed and the application produced an unexpected result;
- `BLOCKED`: the environment or required fixture could not be safely established;
- `EXPECTED_REJECTION`: the API correctly rejected the scenario;
- `SPEC_MISMATCH`: runtime behavior and the declared OpenAPI contract differ;
- `INCONCLUSIVE`: available evidence cannot support a reliable judgment;
- `AWAITING_APPROVAL`: a defect is confirmed and is waiting for a human decision;
- `SKIPPED`: a human declined the confirmed defect;
- `ESCALATED`: the fix or review step could not complete, or a role failed its contract.
