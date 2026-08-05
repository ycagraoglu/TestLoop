# Changelog

All notable changes to TestLoop are documented here.

## [0.5.0] - 2026-08-05

### Added

- URL security policy with scheme, credential, host allowlist, private-network, and response-size controls.
- Explicit external-command allowlists and restricted child-process environments.
- Recursive secret redaction for requests, responses, artifacts, and role handoffs.
- Environment-reference support for authentication request bodies.
- npm package smoke verification.
- Cross-platform Node.js CI matrix.
- Tag-driven npm publish and GitHub Release workflow with provenance.

### Changed

- Inline bearer tokens are no longer accepted; use environment variables.
- Role commands must be configured as argument arrays and explicitly allowlisted.
- Private and loopback HTTP targets require explicit opt-in.
- Package version advanced to `0.5.0`.
