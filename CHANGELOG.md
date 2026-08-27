# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 0.0.1 - 2026-08-27

### Added

- Trigger n8n workflows declaratively via the `@n8n.process.start` annotation and programmatically via `n8n.trigger()`.
- Support for CAP events (CRUD, Fiori, bound actions), configurable HTTP methods (default `POST`), conditional triggering with `if`, and payload selection with `inputs`.
- Webhook authentication via Basic, Bearer, or custom header (`credentials.webhookAuth`).
- Query and manage n8n workflow definitions and executions through the `/api/v1` API using CQL (`cds.ql`) and CAP actions (publish, unpublish, archive, retry, stop).
- Connection resolution from `cds.requires.n8n.credentials`, including BTP destination support with destination precedence over inline credentials.
- Two service kinds: `n8n-to-rest` (real HTTP client) and `n8n-to-console` (log-only, in-memory store for local development).
- `useTestWebhook` flag to target n8n's test-webhook path prefix.
- Annotation validation at both build time (`cds build`) and runtime.
