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

### HTTP method: GET vs POST

The plugin picks the HTTP method based on whether the emitted `payload` is
non-empty:

| Emitted `payload`                    | HTTP method                                          |
| ------------------------------------ | ---------------------------------------------------- |
| `undefined`, `null`, `{}`, or `[]`   | `GET {baseUrl}/webhook/<path>` — no body, no query.  |
| Any primitive, non-empty object/array | `POST {baseUrl}/webhook/<path>` with JSON body.     |

This lets n8n Webhook nodes configured for `GET` (e.g. simple "ping"
workflows that don't need input) work out of the box: emit `trigger` without
a `payload` and the plugin issues a `GET`. As soon as a payload is present,
the call switches back to `POST` with `Content-Type: application/json`.

The switch is inferred purely from the emitted `payload` — there is no way
to force a method explicitly today.

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

**String shorthand** - fires on all CRUD events (CREATE + UPSERT + UPDATE + DELETE):

```cds
@n8n.process.start: 'book-created'
entity Books as projection on my.Books;
```

**Record form** - `on` is optional and defaults to all CRUD events; specify it to
narrow the event set (any CAP event: CRUD, bound-action names, `SAVE` / `WRITE`, or `*`):

```cds
@n8n.process.start: {
  path: 'order-shipped',
  on:   'UPDATE'                         // any CAP event name, or '*'
}
entity Orders as projection on my.Orders;
```

Setting `on: []` (empty array) is a deliberate no-op — the annotation is kept
but registers no handlers. Useful for temporarily disabling a trigger without
deleting the annotation.

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

The `@n8n.process.start.inputs` annotation allows you to specify which elements are part of the request sent to n8n to trigger the workflow. All direct entity attributes are sent by default when no inputs are specified.

```cds
@n8n.process.start: {
  path: 'shipment-ready',
  on:   'UPDATE',
  inputs: [
    $self.ID,
    $self.total,
    $self.items,                          // expand all child fields
    $self.items.ID,                       // combined: wildcard + specific
    $self.items.title
  ]
}
entity Shipments as projection on my.Shipments;
```

Special values:
- `$self` alone means that all fields of the current entity are sent (default)
- `$self.<assoc>` expands all direct attributes of the associated entity

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

`N8nService` exposes two entities projected from n8n's public REST API: `WorkflowDefinitions` and `WorkflowExecutions`. In addition, five unbound actions are specified: `publishWorkflow`, `unpublishWorkflow`, `archiveWorkflow`, `retryExecution`, `stopExecution`. 

```js
const n8n = await cds.connect.to("N8nService")
const { WorkflowExecutions, WorkflowDefinitions } = n8n.entities

// List executions for a specific workflow
const list = await SELECT.from(WorkflowExecutions).where({ workflowId: "abcd" })

// Fetch a single execution (includes the heavy `data` payload)
const one = await SELECT.one.from(WorkflowExecutions).where({ id: "exec-42" })

// Only active workflows, top 20
const active = await SELECT.from(WorkflowDefinitions).where({ active: true }).limit(20)

// Batch read
const some = await SELECT.from(WorkflowDefinitions).where({ id: ["a", "b", "c"] })

await UPDATE(WorkflowDefinitions, "abc").with({ name: "Renamed" })

// Actions
await n8n.send("publishWorkflow", { id: "abc" })
await n8n.send("archiveWorkflow", { id: "abc" })
await n8n.send("stopExecution", { id: "exec-42" })
await n8n.send("retryExecution", { id: "exec-42", loadWorkflow: true })
```

#### Supported `cds.ql` operations

| Operation                     | `WorkflowDefinitions`                         | `WorkflowExecutions`                          |
| ----------------------------- | --------------------------------------------- | --------------------------------------------- |
| **READ (list)**               | ✓                                             | ✓                                             |
|  – limit                      | ✓                                             | ✓                                             |
|  – where\*                    | `id`, `id in […]`, `active`, `name`           | `id`, `id in […]`, `workflowId`, `status`     |
|  – columns projection         | –                                             | –                                             |
| **READ (single)**             | ✓                                             | ✓                                             |
| **CREATE**                    | ✓                                             | –                                             |
|  – required fields            | `name`, `nodes`, `connections`, `settings`    | –                                             |
| **UPDATE**                    | ✓ (partial — missing fields back-filled)      | –                                             |
|  – where\*                    | `id`, `id in […]`                             | –                                             |
| **UPSERT**                    | –                                             | –                                             |
| **DELETE**                    | ✓                                             | ✓                                             |
|  – where\*                    | `id`, `id in […]`                             | `id`, `id in […]`                             |
| **Unbound actions**           | `publishWorkflow`, `unpublishWorkflow`, `archiveWorkflow` | `retryExecution`, `stopExecution` |

\* WHERE-clause fields listed are those the handler maps to n8n query params or path segments. Any additional predicates in the CQN clause are ignored by the REST call — apply them client-side over the returned rows if you need them.

Notes:

- `id in […]` batch operations fan out to per-id HTTP calls (n8n has no bulk endpoints). Missing rows drop out of READ results; failures on individual DELETE calls are logged but don't short-circuit the batch.
- On non-2xx responses the parser logs and returns `{}` instead of throwing — same contract as `cap-js/ai`. Callers that need strict error propagation should inspect the returned shape.
- Column projection (`.columns([...])`) is accepted by the CQL layer but the REST handlers currently return the full row shape returned by n8n. The console mock (SQLite-backed) does honor projection.
- **Pagination**: n8n uses cursor-based pagination (`nextCursor`). Only `SELECT.limit(N)` is forwarded — offsets and cursor chaining are not currently exposed via CQL.
- **`retryExecution`** accepts an optional `loadWorkflow: Boolean` in the action payload; omitted → no request body, `true`/`false` → forwarded verbatim.
- **`archiveWorkflow`** flips `isArchived: true` (and deactivates the workflow); **`publishWorkflow`** / **`unpublishWorkflow`** flip `active` only.

---

## Build-time validation

`cds build` validates `@n8n.process.start.*` annotations. The plugin registers
a `n8n-validation` task via `cds.build.register`.

**Errors** (stop the build):

- Record form requires `path`. `on` is optional (defaults to all CRUD events).
- `on` must be a string or an array of strings; values are forwarded verbatim
  to `service.after` (any CAP event name — CRUD, bound-action names, CAP
  aliases like `SAVE` / `WRITE`, or `*`). CAP validates the actual event names
  at handler-registration time.
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
