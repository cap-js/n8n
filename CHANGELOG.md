# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Configurable webhook methods on `@n8n.process.start` annotations, defaulting to `POST`.

- Array form for `@n8n.process.start`: multiple triggers can be declared in a
  single annotation:

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

- `@n8n.process.start` annotations to declaratively trigger n8n workflows for
  explicitly selected CRUD, Fiori, and bound-action events. Record and array
  forms support conditional triggering with `if` and payload selection with
  `inputs`.
- `READ` event triggers with condition evaluation and input projection.
- A programmatic trigger API exposed as `n8n.trigger()`.
- CAP actions for managing workflows and executions, including publishing,
  unpublishing, archiving, retrying, and stopping.
- Webhook authentication using Basic authentication, Bearer tokens, or a
  custom header via `credentials.webhookAuth`.
- Connection resolution from `cds.requires.n8n.credentials`, including BTP
  destination support with destination precedence over inline credentials.
- Cloud Foundry and BTP deployment configuration in the bookshop sample.
- Two service kinds:
  - `n8n-to-rest` - HTTP client for webhook delivery and n8n's `/api/v1`
    workflow and execution APIs. API keys are sent to `/api/v1`; webhook
    authentication is configured separately with `webhookAuth`. Webhook paths
    are validated against absolute URLs, newline characters, and `..`
    segments. The optional `useTestWebhook` flag targets n8n's test-webhook
    prefix.
  - `n8n-to-console` - log-only impl with an in-memory execution
    store for tests and offline development.
- `cds build` plugin task (`n8n-validation`) that surfaces errors /
  warnings for malformed annotations via the `cds.build` Plugin API. Runtime
  validation uses the same validation rules and checks `inputs` against the
  CDS model.
- Bookshop sample under `tests/bookshop/` with a docker-compose file that
  brings up n8n on `http://localhost:5678` and a ready-to-import
  `book-created` workflow.
- Connection settings use `cds.requires.n8n.credentials`; the legacy
  `N8N_BASE_URL`, `N8N_API_KEY`, and `N8N_USE_TEST_WEBHOOK` environment
  variables are no longer used.
- READ handlers avoid recursive re-entry when an annotation specifies
  `on: 'READ'`.
- DELETE triggers prefetch the row before deletion so the payload can contain
  the full pre-delete state and selected input mapping.
