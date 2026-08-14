# CAP - n8n Plugin

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/n8n)](https://api.reuse.software/info/github.com/cap-js/n8n)

CAP plugin to trigger [n8n](https://n8n.io/) workflows from CAP applications -
declaratively via `@n8n.process.start` annotations and programmatically via a
`N8nService` you can `cds.connect.to`.

- [CAP - n8n Plugin](#cap---n8n-plugin)
  - [Requirements](#requirements)
  - [Setup](#setup)
    - [Local development](#local-development)
    - [Bind against a real instance](#bind-against-a-real-instance)
    - [Profiles \& credentials](#profiles--credentials)
    - [Test vs. production webhooks](#test-vs-production-webhooks)
    - [HTTP method - PLACEHOLDER](#http-method---placeholder)
  - [Annotations](#annotations)
    - [Triggering a workflow](#triggering-a-workflow)
    - [Conditional triggers](#conditional-triggers)
    - [Input mapping](#input-mapping)
    - [Multiple triggers per entity](#multiple-triggers-per-entity)
  - [Programmatic API](#programmatic-api)
    - [Querying executions and workflows](#querying-executions-and-workflows)
      - [Supported `cds.ql` operations](#supported-cdsql-operations)
  - [Support, Feedback, Contributing](#support-feedback-contributing)
  - [Security / Disclosure](#security--disclosure)
  - [Code of Conduct](#code-of-conduct)
  - [Licensing](#licensing)

---

## Requirements

- Node.js 22 or newer
- `@sap/cds` 9 or newer
- An n8n instance for anything beyond local development (either local via Docker or remote)

## Setup

```bash
npm add @cap-js/n8n
```

### Local development

In the default `[development]` profile the plugin uses the `n8n-to-console` kind: workflow triggers are logged to stdout and stored in an in-memory execution store. **No n8n instance is required** - ideal for getting started, writing tests and iterating on your annotations before you have n8n set up.

Add the `@n8n.process.start` annotation to any entity in your service:

```cds
service CatalogService {
  @n8n.process.start: 'book-created'
  entity Books as projection on my.Books;
}
```

Then start your CAP application as usual:

```bash
cds watch
```

Every CUD event on `Books` now emits a trigger, and you'll see it logged
directly in the CLI:

<!-- TODO: screenshot of the CLI output -->

From here you can either point the plugin at a [real n8n instance](#bind-against-a-real-instance) or refine your triggers with [conditions](#conditional-triggers) and [input mapping](#input-mapping).

### Bind against a real instance

To fire actual webhooks you need a running n8n instance. Pick one:

- **Local via `npx`** - `npx n8n` brings it up on `http://localhost:5678`.
- **Local via Docker** - see the [bookshop sample](tests/bookshop) for a ready-made compose file.
- **Remote** - n8n Cloud or self-hosted; just note the base URL.

Then generate an API key (Settings → n8n API → Create API Key), bind it
to the service via `cds bind` (see [Profiles & credentials](#profiles--credentials)),
and run CAP with a non-development profile:

```bash
cds watch --profile hybrid
```

Every trigger is now a real `POST {url}/webhook/<path>`, visible in the
n8n **Executions** view.

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

### HTTP method - PLACEHOLDER

Every webhook trigger is a `POST {baseUrl}/webhook/<path>` with a JSON
body - even when the caller emits no payload. In that case the body is
just `{}`. The plugin doesn't switch between `GET` and `POST` based on
payload contents: annotation-driven flows without an explicit `.inputs`
mapping forward the full entity row, so a body is always the natural
shape to expect on the n8n side.

Configure your n8n Webhook node for `POST` accordingly.

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

Setting `on: []` (empty array) is a deliberate no-op - the annotation is kept
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

| Operation            | `WorkflowDefinitions`                                     | `WorkflowExecutions`                      |
| -------------------- | --------------------------------------------------------- | ----------------------------------------- |
| **READ (list)**      | ✓                                                         | ✓                                         |
| – limit              | ✓                                                         | ✓                                         |
| – where\*            | `id`, `id in […]`, `active`, `name`                       | `id`, `id in […]`, `workflowId`, `status` |
| – columns projection | –                                                         | –                                         |
| **READ (single)**    | ✓                                                         | ✓                                         |
| **CREATE**           | ✓                                                         | –                                         |
| – required fields    | `name`, `nodes`, `connections`, `settings`                | –                                         |
| **UPDATE**           | ✓ (partial - missing fields back-filled)                  | –                                         |
| – where\*            | `id`, `id in […]`                                         | –                                         |
| **UPSERT**           | –                                                         | –                                         |
| **DELETE**           | ✓                                                         | ✓                                         |
| – where\*            | `id`, `id in […]`                                         | `id`, `id in […]`                         |
| **Unbound actions**  | `publishWorkflow`, `unpublishWorkflow`, `archiveWorkflow` | `retryExecution`, `stopExecution`         |

> [!NOTE] WHERE-clause fields listed are those the handler maps to n8n query params or path segments. Any additional predicates in the CQN clause are ignored by the REST call - apply them client-side over the returned rows if you need them.

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
