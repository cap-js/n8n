# CAP - n8n Plugin

CAP plugin to trigger [n8n](https://n8n.io/) workflows from CAP applications -
declaratively via `@n8n.trigger` annotations and programmatically via a
`N8nService` you can `cds.connect.to`.

- [Setup](#setup)
  - [Local development with docker](#local-development-with-docker)
  - [Profiles & credentials](#profiles--credentials)
  - [Test vs. production webhooks](#test-vs-production-webhooks)
  - [HTTP timeouts](#http-timeouts)
  - [Retry semantics](#retry-semantics)
  - [Authentication](#authentication)
- [Annotations](#annotations)
  - [Triggering a workflow](#triggering-a-workflow)
  - [Conditional triggers](#conditional-triggers)
  - [Input mapping](#input-mapping)
  - [Multiple triggers per entity](#multiple-triggers-per-entity)
- [Programmatic API](#programmatic-api)
- [Build-time validation](#build-time-validation)
- [Cross-plugin compatibility](#cross-plugin-compatibility)
- [MVP scope & limitations](#mvp-scope--limitations)
- [Development](#development)

---

## Setup

```bash
npm add @cap-js/n8n
```

The plugin auto-registers on CAP boot. No further wiring is needed for the
common cases.

### Local development with docker

n8n runs as a first-class docker container. The [sample bookshop](tests/sample/bookshop)
ships a `docker-compose.yml` that starts n8n on `http://localhost:5678`:

```bash
cd tests/sample/bookshop
docker compose up -d
```

Then start CAP:

```bash
cds watch
```

The `[development]` profile defaults the plugin's `baseUrl` to
`http://localhost:5678` - no configuration required.

### Profiles & credentials

The plugin ships two service kinds:

| Kind                    | Used when                            | Behavior                                                                     |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `rest-n8n-service`      | default (dev / hybrid / production)  | Real HTTP calls against an n8n instance.                                     |
| `console-n8n-service`   | opt-in - set `kind` explicitly       | Log-only impl. In-memory execution store for tests / offline development.    |

The default profile matrix is:

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "kind": "rest-n8n-service",
        "credentials": {
          "baseUrl": "env:N8N_BASE_URL",
          "apiKey":  "env:N8N_API_KEY"
        },
        "[development]": {
          "credentials": { "baseUrl": "http://localhost:5678" }
        }
      }
    }
  }
}
```

**Resolution order** for the REST kind:

1. Bound / inline `credentials.{baseUrl, apiKey}` (accepts `env:VAR` refs)
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

**Opt into console kind** (e.g. for a `[test]` profile):

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "[test]": { "kind": "console-n8n-service" }
      }
    }
  }
}
```

### Test vs. production webhooks

n8n exposes two webhook prefixes:

| Prefix          | When to use                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `/webhook`      | Published workflows. Always active. Handles bulk calls. **Default.**                            |
| `/webhook-test` | One-shot capture for workflow authoring. Requires clicking "Listen for Test Event" in the n8n UI before each call, and only fires once per arming. |

Toggle via the `useTestWebhook` flag on the service credentials:

```jsonc
{
  "cds": {
    "requires": {
      "N8nService": {
        "credentials": {
          "baseUrl": "http://localhost:5678",
          "useTestWebhook": true
        }
      }
    }
  }
}
```

Resolution order for the flag mirrors the base URL: bound / inline credentials
first (accepts `env:VAR` refs), then `N8N_USE_TEST_WEBHOOK`, then a BTP
destination property `URL.useTestWebhook`, then `false`.

The flag only affects webhook POSTs. Calls to n8n's public REST API
(`/api/v1/executions/…`) always use the canonical `/api/v1` prefix.

### HTTP timeouts

The plugin applies a request-scoped timeout on all calls to n8n. Defaults
match the sister Java plugin: **3 s connect + 5 s read** (8 s aggregate).
Override via credentials or env vars:

```jsonc
{
  "credentials": {
    "timeout": { "connect": 2000, "read": 8000 }
  }
}
```

Env-var equivalents: `N8N_CONNECT_TIMEOUT_MS`, `N8N_READ_TIMEOUT_MS`.

Because Node's `fetch` doesn't distinguish the phases at the API level, the
two values are summed and applied as a single abort deadline. The pair is
surfaced for symmetry with the Java plugin and for future flexibility.

### Retry semantics

Failed webhook calls are retried by the CAP outbox - but only when the
failure is worth retrying:

| Failure                     | Retried by the outbox? |
| --------------------------- | ---------------------- |
| Network error / DNS / socket | **Yes** - n8n was unreachable. |
| Read timeout                 | **Yes** - no response before the deadline. |
| HTTP 4xx                     | No - misconfiguration; retrying won't fix it. |
| HTTP 5xx                     | No - n8n received the call but the workflow failed. |

Non-retryable failures are logged at `ERROR` and the outbox marks the message
done, keeping the queue clean.

### Authentication

The `apiKey` credential is sent as HTTP headers, with different semantics per
endpoint:

| Endpoint            | Header(s) sent                               | Why |
| ------------------- | -------------------------------------------- | --- |
| `/webhook/…` POSTs  | `X-N8N-API-KEY` **and** `X-Webhook-Secret`   | n8n workflows can validate whichever header they choose; sending both interoperates with workflows written for either the Node plugin's or Java plugin's convention. |
| `/api/v1/…` GETs    | `X-N8N-API-KEY` only                         | n8n's public REST API validates the canonical header specifically. |

---

## Annotations

### Triggering a workflow

**String shorthand** - fires on CREATE + UPDATE:

```cds
@n8n.trigger: 'book-created'
entity Books as projection on my.Books;
```

**Record form** - pick events explicitly:

```cds
@n8n.trigger: {
  workflow: 'order-shipped',
  on: 'UPDATE'                           // CREATE | UPDATE | DELETE | <boundAction> | '*'
}
entity Orders as projection on my.Orders;
```

The plugin's `after` handler runs post-commit; the outboxed `N8nService`
persists the emit in the same transaction and dispatches it after commit,
so a failing n8n call never rolls back your business transaction.

For `DELETE` triggers the plugin registers a before-handler that SELECTs the
row prior to deletion and stashes it on the request context, so the webhook
payload carries the pre-delete state (title, status, associations, …) rather
than just the keys.

### Conditional triggers

```cds
@n8n.trigger: {
  workflow: 'order-shipped',
  on: 'UPDATE',
  if: (status = 'shipped')
}
entity Orders as projection on my.Orders;
```

The `.if` clause is ANDed onto the SELECT used to fetch the payload. If the
condition evaluates false, no trigger is fired.

### Input mapping

Same semantics as `@cap-js/process`. Without `inputs`, all direct scalar
attributes are sent.

```cds
@n8n.trigger: {
  workflow: 'shipment-ready',
  on: 'UPDATE',
  inputs: [
    $self.ID,                                       // scalar
    { path: $self.total, as: 'orderAmount' },       // alias
    $self.items,                                    // expand all child fields
    $self.items.ID,                                 // combined: wildcard + specific
    { path: $self.items.title, as: 'ItemTitle' }
  ]
}
entity Shipments as projection on my.Shipments;
```

Special values:

- `$self` alone means "all scalar fields of the current entity".
- `$self.assoc` alone expands all direct attributes of the associated entity.

### Multiple triggers per entity

Use CDS qualifiers to attach several triggers:

```cds
@n8n.trigger #created:  { workflow: 'wf-created',   on: 'CREATE' }
@n8n.trigger #archived: { workflow: 'wf-archived',  on: 'DELETE' }
entity Books as projection on my.Books;
```

---

## Programmatic API

```js
const n8n = await cds.connect.to('N8nService')

// Fire a webhook - routed through the outbox, POSTed after commit
await n8n.emit('trigger', {
  workflow: 'book-created',
  payload:  { title: 'Moby Dick', quantity: 3 }
})

// Query executions (synchronous)
const list = await n8n.send('listExecutions', { workflowId: 'abcd' })
const one  = await n8n.send('getExecution',   { executionId: 'exec-42' })
```

The `N8nService` model (`srv/N8nService.cds`):

| Operation        | Type    | Purpose                                                            |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `trigger`        | event   | POST `{baseUrl}/webhook/<workflow>` with `payload`                 |
| `getExecution`   | function | GET `/api/v1/executions/{id}?includeData=true`                    |
| `listExecutions` | function | GET `/api/v1/executions?workflowId={id}&includeData=true`         |

---

## Build-time validation

`cds build` validates `@n8n.trigger.*` annotations. The plugin registers a
`n8n-validation` task via `cds.build.register`.

**Errors** (stop the build):

- `workflow` and `on` must be present together in the record form.
- `on` must be `CREATE | UPDATE | DELETE`, a declared bound action of the
  entity, or `*`.
- `inputs` must be an array of `{ '=': '$self.…' }` or
  `{ path: { '=': '…' }, as: '…' }` entries.
- `if` must be a CDS expression.
- The string-shorthand form must be a non-empty string.

**Warnings** (build succeeds, message logged):

- Unknown sub-keys under `@n8n.trigger.*`.

---

## MVP scope & limitations

Deliberately excluded to keep the first release small and to avoid pretending
n8n supports semantics it doesn't:

- **No `cancel` / `suspend` / `resume`** - n8n has no first-class equivalents.
- **No `businessKey` correlation** - could later be simulated via execution tags.
- **No `cds import --from n8n`** - string webhook paths cover the MVP; typed
  imports are on the roadmap.
- **No Fiori draft events** (`SAVE`, `EDIT`, `NEW`, `PATCH`, `DISCARD`) -
  only CRUD + bound actions for now.
- **No `READ` event triggers** - high volume, easy to create feedback loops.
  Use bound actions or CDS events instead.

---

## Cross-plugin compatibility

A sister CAP plugin exists for Java applications:
[`cds-feature-n8n`](https://github.com/SAP/cap-n8n). The two share the same
intent but expose different surfaces:

| Aspect                | This plugin (Node)                         | `cds-feature-n8n` (Java)          |
| --------------------- | ------------------------------------------ | --------------------------------- |
| Annotation name       | `@n8n.trigger`                             | `@n8n.process.start`              |
| Path key              | `workflow`                                 | `path`                            |
| Conditional dispatch  | `if: (…)`                                  | not supported                     |
| String shorthand      | `@n8n.trigger: 'wf'`                       | not supported                     |
| Wildcard `on: '*'`    | supported                                  | not supported                     |
| BTP destinations      | supported                                  | not supported                     |
| Executions REST API   | `getExecution`, `listExecutions`           | not exposed                       |
| Auth header (webhook) | `X-N8N-API-KEY` **and** `X-Webhook-Secret` | `X-Webhook-Secret`                |

The two plugins consume different annotation names, so a single CDS model
cannot be shared verbatim. When migrating between them, translate
`@n8n.trigger.workflow` ↔ `@n8n.process.start.path` and rewrite
`if`/`inputs`/qualifier forms accordingly.

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
  `console-n8n-service` kind. Verifies annotation-driven dispatch,
  `.if` gating, `.inputs` mapping, and the programmatic API.
- `tests/integration/rest/**` - skips gracefully when
  `http://localhost:5678/healthz` is unreachable. Enable it by starting the
  docker container in `tests/sample/bookshop`.

## License

Apache-2.0
