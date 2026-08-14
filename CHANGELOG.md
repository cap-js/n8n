# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.1.0 - 2026-08-17

Initial release of the `@cap-js/n8n` plugin.

### Added

- Array form for `@n8n.process.start`: multiple triggers can now be declared
  in a single annotation instead of requiring separate qualified annotations:

  ```cds
  @n8n.process.start: [
    { path: 'book-created', on: 'CREATE' },
    { path: 'book-deleted', on: 'DELETE' }
  ]
  entity Books as projection on my.Books;
  ```

  Each element supports the same fields as the record form (`path`, `on`,
  `if`, `inputs`). Build-time validation covers all array elements including
  unknown-key warnings and per-element error references (e.g. `[1]`).

- `@n8n.process.start` annotation to declaratively trigger n8n workflows on
  explicitly selected events and bound actions. The record form requires
  `path` and `on`, and supports `if` (CDS predicate) and `inputs`
  (subset / association expansion).
  - Multiple triggers per entity via CDS qualifiers.
  - DELETE prefetch that stashes the row in a before-handler so payloads
    carry the full record.
- Programmatic `n8n` with `triggerWorkflow` (outboxed event)
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
