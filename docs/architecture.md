# TestLoop Architecture

## Objective

TestLoop verifies ASP.NET Core API behavior using evidence-backed test data and a gated repair loop. It combines a small deterministic runner with narrowly scoped LLM roles.

## Design principles

1. Deterministic work is performed by code, not by an LLM.
2. Valid fixtures must be proven before a test can produce `FAIL`.
3. Subagents are opened only when ambiguity or a confirmed defect justifies their cost.
4. The agent that implements a fix cannot approve that fix.
5. Every workflow transition requires a machine-readable result and an explicit gate.
6. Production and unsafe side-effect environments are blocked by default.

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
- persisting workflow state;
- enforcing budgets, retries, and state transitions;
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

The MVP uses a small number of roles:

- **Coordinator:** selects the next legal workflow transition.
- **Test Analyst:** plans valid scenarios and requests fixture resolution.
- **Failure Diagnostician:** distinguishes test-data, environment, contract, and application failures.
- **Bugfix Agent:** applies the smallest root-cause correction after a defect is confirmed.
- **Review Agent:** independently checks correctness, security, scope, and regression risk.

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
- `INCONCLUSIVE`: available evidence cannot support a reliable judgment.
