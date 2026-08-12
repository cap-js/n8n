# CAP - n8n Plugin

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/n8n)](https://api.reuse.software/info/github.com/cap-js/n8n)

CAP plugin to trigger [n8n](https://n8n.io/) workflows from CAP applications -
declaratively via `@n8n.process.start` annotations and programmatically via a
`N8nService` you can `cds.connect.to`.

- [Requirements](#requirements)
- [Setup](#setup)
  - [Local development](#local-development)
  - [Profiles & credentials](#profiles--credentials)
  - [Test vs. production webhooks](#test-vs-production-webhooks)
  - [Retry semantics](#retry-semantics)
  - [Authentication](#authentication)
- [Annotations](#annotations)
  - [Triggering a workflow](#triggering-a-workflow)
  - [Conditional triggers](#conditional-triggers)
  - [Input mapping](#input-mapping)
  - [Multiple triggers per entity](#multiple-triggers-per-entity)
- [Programmatic API](#programmatic-api)
- [Build-time validation](#build-time-validation)
- [MVP scope & limitations](#mvp-scope--limitations)
- [Development](#development)

---

## Setup

```bash
npm add @cap-js/n8n
```

### Local development

By default in the `[development]` profile, the plugin uses the
`n8n-to-console` kind: workflow triggers are logged to stdout and stored
in an in-memory execution store. No n8n instance is required.

To develop against a real n8n instance, the [sample bookshop](tests/bookshop)
ships a `docker-compose.yml` that starts n8n on `http://localhost:5678`:

```bash
cd tests/bookshop
docker compose up -d
```

Then start CAP with the profile that uses the REST kind (e.g. `[hybrid]`):

```bash
cds watch --profile hybrid
```

### Profiles & credentials

The plugin ships two service kinds:

| Kind             | Used when                              | Behavior                                                                   |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `n8n-to-console` | default in `[development]`             | Log-only impl with an in-memory execution store. No n8n instance required. |
| `n8n-to-rest`    | default in any non-development profile | Real HTTP calls against an n8n instance.                                   |

The default profile matrix is:

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "kind": "n8n-to-rest",
        "credentials": {
          "baseUrl": "env:N8N_BASE_URL",
          "apiKey": "env:N8N_API_KEY",
        },
        "[development]": {
          "kind": "console-n8n-service",
        },
      },
    },
  },
}
```

**Resolution order** for the REST kind:

1. Bound / inline `credentials.{baseUrl, apiKey}`
2. BTP destination via `credentials.destination` or top-level `destination`
3. Environment variables `N8N_BASE_URL` + `N8N_API_KEY`
4. Dev-only fallback `http://localhost:5678` (development profile only -
   throws in any other profile)

**Hybrid** - bind against a user-provided service with `cds bind`:

```bash
cf create-user-provided-service n8n -p '{"baseUrl":"https://your.n8n.cloud","apiKey":"eyJ..."}'
cds bind N8nService -2 n8n
```

**Production** - the same user-provided service (tagged `n8n`) is picked up
via VCAP, or use a BTP destination named `n8n`.

**Opt into the REST kind in `[development]`** (e.g. when developing against a
local n8n instance):

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "[development]": {
          "kind": "n8n-to-rest",
          "credentials": { "baseUrl": "http://localhost:5678" },
        },
      },
    },
  },
}
```

### Test vs. production webhooks

n8n exposes two webhook prefixes:

| Prefix          | When to use                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/webhook`      | Published workflows. Always active. Handles bulk calls. **Default.**                                                                               |
| `/webhook-test` | One-shot capture for workflow authoring. Requires clicking "Listen for Test Event" in the n8n UI before each call, and only fires once per arming. |

Toggle via the `useTestWebhook` flag on the service credentials:

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "credentials": {
          "baseUrl": "http://localhost:5678",
          "useTestWebhook": true,
        },
      },
    },
  },
}
```

Resolution order for the flag mirrors the base URL: bound / inline credentials
first, then `N8N_USE_TEST_WEBHOOK`, then a BTP destination property
`URL.useTestWebhook`, then `false`.

The flag only affects webhook POSTs. Calls to n8n's public REST API
(`/api/v1/executions/…`) always use the canonical `/api/v1` prefix.

### Retry semantics

Failed webhook calls are retried by the CAP outbox (persistent queue backed
by the application database) - but only when the failure is worth retrying:

| Failure                      | Retried by the outbox?                              |
| ---------------------------- | --------------------------------------------------- |
| Network error / DNS / socket | **Yes** - n8n was unreachable.                      |
| Read timeout                 | **Yes** - no response before the deadline.          |
| HTTP 4xx                     | No - misconfiguration; retrying won't fix it.       |
| HTTP 5xx                     | No - n8n received the call but the workflow failed. |

Non-retryable failures are logged at `ERROR` and the outbox marks the message
done, keeping the queue clean.

### Authentication

The plugin sends the configured `apiKey` as HTTP header **`X-N8N-API-KEY`** on
every request - both webhook POSTs (`/webhook/…`) and public-API GETs
(`/api/v1/…`). This is the same header n8n itself uses for its
[public REST API](https://docs.n8n.io/api/authentication/), so a single API
key works across the whole plugin surface.

To validate incoming webhook calls inside n8n, add a **Header auth**
credential to the Webhook node with:

- **Name**: `X-N8N-API-KEY`
- **Value**: the same API key configured on the CAP side

---

## Annotations

### Triggering a workflow

**String shorthand** - fires on CREATE + UPDATE:

```cds
@n8n.process.start: 'book-created'
entity Books as projection on my.Books;
```

**Record form** - pick events explicitly:

```cds
@n8n.process.start: {
  path: 'order-shipped',
  on:   'UPDATE'                         // CREATE | UPDATE | DELETE | <boundAction> | '*'
}
entity Orders as projection on my.Orders;
```

The plugin's `after` handler emits to the outboxed `N8nService`, which
persists the emit in the same transaction. The actual HTTP call to n8n is
dispatched after the transaction commits, so a failing n8n call never rolls
back your business transaction.

### Conditional triggers

```cds
@n8n.process.start: {
  path: 'order-shipped',
  on:   'UPDATE',
  if:   (status = 'shipped')
}
entity Orders as projection on my.Orders;
```

The `.if` predicate is evaluated against the entity's current state
(post-update for `UPDATE`, the pre-delete row for `DELETE`). If it evaluates
to `false`, no trigger is fired.

### Input mapping

Without `inputs`, all direct scalar attributes are sent.

```cds
@n8n.process.start: {
  path: 'shipment-ready',
  on:   'UPDATE',
  inputs: [
    $self.ID,                                       // scalar
    $self.total,                                    // scalar
    $self.items,                                    // expand all child fields
    $self.items.ID,                                 // combined: wildcard + specific
    $self.items.title
  ]
}
entity Shipments as projection on my.Shipments;
```

Special values:

- `$self` alone means "all scalar fields of the current entity" (=> which is the default).
- `$self.assoc` alone expands all direct attributes of the associated entity.

### Multiple triggers per entity

Use CDS qualifiers to attach several triggers:

```cds
@n8n.process.start #created:  { path: 'wf-created',   on: 'CREATE' }
@n8n.process.start #archived: { path: 'wf-archived',  on: 'DELETE' }
entity Books as projection on my.Books;
```

---

## Programmatic API

```js
const n8n = await cds.connect.to("N8nService")

// Fire a webhook - routed through the outbox, POSTed after commit
await n8n.emit("trigger", {
  path: "book-created",
  payload: { title: "Moby Dick", quantity: 3 },
})
```

### Querying executions and workflows

`N8nService` exposes read-only entities `WorkflowExecutions` and `WorkflowDefinitions` projected from n8n's public REST API. Reads are delegated live to n8n through the same connection the plugin uses for webhook triggers.

```js
const n8n = await cds.connect.to("N8nService")
const { WorkflowExecutions, WorkflowDefinitions } = n8n.entities

// List executions for a specific workflow
const list = await SELECT.from(WorkflowExecutions).where({ workflowId: "abcd" })

// Fetch a single execution (includes the heavy `data` payload)
const one = await SELECT.one.from(WorkflowExecutions).where({ id: "exec-42" })

// Only active workflows, top 20
const active = await SELECT.from(WorkflowDefinitions).where({ active: true }).limit(20)

// Selecting `data` explicitly opts into the heavier `?includeData=true`
// query on the list endpoint (single-by-id always includes it):
const withData = await SELECT.from(WorkflowExecutions)
  .columns("id", "status", "data")
  .where({ workflowId: "abcd" })
```

The `N8nService` model (`srv/N8nService.cds`):

| Entity                | Access    | Backed by                                           |
| --------------------- | --------- | --------------------------------------------------- |
| `trigger` (event)     | emit      | POST `{baseUrl}/webhook/<path>` with `payload`      |
| `WorkflowExecutions`  | READ-only | `GET /api/v1/executions[/{id}]` (CQN → querystring) |
| `WorkflowDefinitions` | READ-only | `GET /api/v1/workflows[/{id}]` (CQN → querystring)  |

**WHERE-clause mapping** (equality only — anything more complex is applied client-side over the returned rows):

- `WorkflowExecutions`: `id`, `workflowId`, `status`, `projectId`
- `WorkflowDefinitions`: `id`, `active`, `name`, `projectId`

**Pagination**: n8n uses cursor-based pagination (`nextCursor`). The READ handler transparently follows cursors up to a soft cap (5 pages) to satisfy `SELECT.limit(N)`. `SELECT.limit(N, OFFSET)` is emulated client-side.

---

## Build-time validation

`cds build` validates `@n8n.process.start.*` annotations. The plugin registers
a `n8n-validation` task via `cds.build.register`.

**Errors** (stop the build):

- `path` and `on` must be present together in the record form.
- `on` must be `CREATE | UPDATE | DELETE`, a declared bound action of the
  entity, or `*`.
- `inputs` must be an array of `{ '=': '$self.…' }` entries.
- `if` must be a CDS expression.
- The string-shorthand form must be a non-empty string.

**Warnings** (build succeeds, message logged):

- Unknown sub-keys under `@n8n.process.start.*`.

---

## MVP scope & limitations

Deliberately excluded from this initial release:

- **No Fiori draft events** (`SAVE`, `EDIT`, `NEW`, `PATCH`, `DISCARD`) -
  only CRUD + bound actions for now.
- **No `READ` event triggers** - high volume, easy to create feedback loops.
  Use bound actions or CDS events instead.
- **No typed workflow import** - string webhook paths cover the MVP;
  typed imports are on the roadmap.

---

## Development

```bash
npm install
npm test           # unit + console-integration tests (no docker required)
npm run test:live  # add: real REST calls against localhost:5678 (docker up first)
```

Test layout:

- `tests/unit/**` - pure JS tests: input parser, annotation scanner,
  build validations, connection resolver, n8n client URL builder.
- `tests/integration/console/**` - runs the sample bookshop with the
  `n8n-to-console` kind. Verifies annotation-driven dispatch,
  `.if` gating, `.inputs` mapping, and the programmatic API.
- `tests/integration/rest/**` - skips gracefully when
  `http://localhost:5678/healthz` is unreachable. Enable it by starting the
  docker container in `tests/bookshop`.

---

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via
[GitHub issues](https://github.com/cap-js/n8n/issues). Contribution and
feedback are encouraged and always welcome. For more information about how
to contribute, the project structure, as well as additional contribution
information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the
instructions found [in our security policy](https://github.com/cap-js/n8n/security/policy)
on how to report it. Please do not create GitHub issues for security-related
doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our
community a harassment-free experience for everyone. By participating in this
project, you agree to abide by its
[Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md)
at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and n8n contributors.
Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license
information. Detailed information including third-party components and their
licensing/copyright information is available
[via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/n8n).
