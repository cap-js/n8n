# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.1.0 - 2026-07-24

Initial release of the `@cap-js/n8n` plugin.

### Added

- `@n8n.process.start` annotation to declaratively trigger n8n workflows on
  CRUD events (CREATE / UPDATE / DELETE) and bound actions. Supports:
  - String shorthand (`@n8n.process.start: 'workflow-path'`) firing on
    CREATE + UPDATE.
  - Record form with `path`, `on`, `if` (CDS predicate) and `inputs`
    (subset / alias / association expansion).
  - Multiple triggers per entity via CDS qualifiers.
  - DELETE prefetch that stashes the row in a before-handler so payloads
    carry the full record.
- Programmatic `n8n` with `trigger` (outboxed event), `getExecution`
  and `listExecutions` (synchronous functions).
- Two service kinds:
  - `n8n-to-rest` - real HTTP client with configurable timeouts,
    retry classification, `X-N8N-API-KEY` header,
    SSRF-hardened webhook paths, BTP destination support, and an
    optional `useTestWebhook` flag targeting the n8n test-webhook prefix.
  - `n8n-to-console` - log-only impl with an in-memory execution
    store for tests and offline development.
- `cds build` plugin task (`n8n-validation`) that surfaces errors /
  warnings for malformed annotations via the `cds.build` Plugin API.
- Bookshop sample under `tests/bookshop/` with a docker-compose file that
  brings up n8n on `http://localhost:5678` and a ready-to-import
  `book-created` workflow.
