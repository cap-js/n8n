# CAP - n8n Plugin

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/n8n)](https://api.reuse.software/info/github.com/cap-js/n8n)

Trigger [n8n](https://n8n.io/) workflows from CAP applications with `@n8n.process.start` annotations or through the programmatic `n8n` service.

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Connect to n8n](#connect-to-n8n)
  - [Local n8n](#local-n8n)
  - [Environment variables](#environment-variables)
  - [Cloud Foundry binding](#cloud-foundry-binding)
  - [BTP destination](#btp-destination)
  - [Credential resolution](#credential-resolution)
- [Webhook requests](#webhook-requests)
  - [Test webhooks](#test-webhooks)
- [Annotations](#annotations)
  - [Events](#events)
  - [Conditions](#conditions)
  - [Payload mapping](#payload-mapping)
  - [Multiple triggers](#multiple-triggers)
- [Programmatic API](#programmatic-api)
  - [Trigger a workflow](#trigger-a-workflow)
  - [Manage workflows and executions](#manage-workflows-and-executions)
  - [Supported `cds.ql` operations](#supported-cdsql-operations)
- [Delivery behavior](#delivery-behavior)
- [Support, Feedback, Contributing](#support-feedback-contributing)
- [Security / Disclosure](#security--disclosure)
- [Code of Conduct](#code-of-conduct)
- [Licensing](#licensing)

## Requirements

- Node.js 22 or newer
- `@sap/cds` 9 or newer
- An n8n instance when using real webhooks or n8n's workflow and execution APIs

## Quick start

Install the plugin:

```bash
npm add @cap-js/n8n
```

Add a trigger to an entity exposed by a CAP service:

```cds
service CatalogService {
  @n8n.process.start: {
    path: 'book-created',
    on: 'CREATE'
  }
  entity Books as projection on my.Books;
}
```

Start the application as usual:

```bash
cds watch
```

During local development, the plugin simply logs the webhook path and payload instead of sending actual requests to to n8n

```sh
[@cap-js/n8n] - Triggering n8n workflow {
  method: 'POST',
  webhookUrl: '/webhook/book-created',
  payload: {
    createdAt: '2026-08-17T11:12:25.050Z',
    createdBy: 'anonymous',
    modifiedAt: '2026-08-17T11:12:25.050Z',
    modifiedBy: 'anonymous',
    ID: 273,
    title: 'Moby Dick',
    descr: null,
    author_ID: 101,
    genre_ID: null,
    stock: 5,
    price: '12.5',
    currency_code: null
  }
}
```

This allows you develop and test without running an n8n instance. To connect to an actual n8n instance, check [Connect to n8n](#connect-to-n8n).

## Connect to n8n

The plugin uses these profiles by default:

| Profile       | Behavior                                                 |
| ------------- | -------------------------------------------------------- |
| `development` | Logs triggers without making network requests            |
| `hybrid`      | Sends requests to a local n8n at `http://localhost:5678` |
| `production`  | Sends requests using the configured connection           |

An API key is optional for webhook delivery if the target webhook accepts the request without it. n8n's `/api/v1` workflow and execution APIs normally require an API key. When configured, the plugin sends it as `X-N8N-API-KEY`.

### Local n8n

Start n8n locally with `npx n8n`, Docker, or the [bookshop sample](tests/bookshop), then run CAP with the hybrid profile:

```bash
export N8N_API_KEY=eyJ...
cds watch --profile hybrid
```

The hybrid profile already supplies `http://localhost:5678` as the URL. Omit `N8N_API_KEY` if your webhook does not require it and you do not use the n8n workflow or execution APIs.

### Environment variables

Provide both values when connecting to a remote n8n directly:

```bash
export N8N_BASE_URL=https://your.n8n.cloud
export N8N_API_KEY=eyJ...
cds watch --profile production
```

### Cloud Foundry binding

Create and bind a user-provided service for hybrid development:

```bash
cf create-user-provided-service n8n \
  -p '{"url":"https://your.n8n.cloud","apiKey":"eyJ..."}'

cds bind n8n --to n8n
cds watch --profile hybrid
```

### BTP destination

Select a destination explicitly in the profile where it is used:

```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[production]": {
          "credentials": {
            "destination": "n8n",
          },
        },
      },
    },
  },
}
```

Authentication headers resolved from the destination are sent alongside an `X-N8N-API-KEY` when an API key is also configured. This supports destinations that authenticate an outer proxy in front of n8n.

### Credential resolution

Connections are resolved in this order:

1. A BTP destination named by `credentials.destination` or `destination`
2. Bound or inline `credentials.{url, apiKey}`
3. `N8N_BASE_URL` and `N8N_API_KEY`

If inline credentials provide only `url`, `N8N_API_KEY` can still supply the API key. An operation fails when none of these sources provides a URL.

To use real webhooks in the development profile, override its service kind:

```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[development]": {
          "kind": "n8n-to-rest",
          "credentials": {
            "url": "http://localhost:5678",
          },
        },
      },
    },
  },
}
```

## Webhook requests

Every trigger sends a JSON request to n8n:

```http
{method} {url}/webhook/<path>
Content-Type: application/json
X-N8N-API-KEY: <apiKey>  # when configured
```

The method defaults to `POST`. An annotation can override it with `method`, for example:

```cds
@n8n.process.start: {
  path: 'book-looked-up',
  method: 'GET',
  on: 'READ'
}
entity Books as projection on my.Books;
```

The annotation payload is the selected entity data. A programmatic trigger without a payload sends `{}`. Configure the n8n Webhook node to use the same method and path as the annotation or programmatic call. Supported methods are `DELETE`, `GET`, `HEAD`, `PATCH`, `POST`, and `PUT`.

### Test webhooks

n8n provides two webhook modes:

| Prefix          | Use                                                             |
| --------------- | --------------------------------------------------------------- |
| `/webhook`      | Published workflows; this is the default                        |
| `/webhook-test` | One test event after selecting **Listen for Test Event** in n8n |

Enable test webhooks in the credentials for the relevant profile:

```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[hybrid]": {
          "credentials": {
            "url": "http://localhost:5678",
            "useTestWebhook": true,
          },
        },
      },
    },
  },
}
```

`useTestWebhook` is resolved from the destination property `URL.useTestWebhook`, credentials, or `N8N_USE_TEST_WEBHOOK`, in that order. It only changes webhook URLs; workflow and execution operations continue to use`/api/v1`.

## Annotations

### Events

Use the record form and declare the event explicitly with `on`:

```cds
@n8n.process.start: {
  path: 'book-changed',
  method: 'PATCH',
  on: [ 'CREATE', 'UPDATE' ]
}
entity Books as projection on my.Books;
```

CAP event names, including CRUD events, Fiori events, and bound action names, are accepted. `on: []` disables the trigger without removing its annotation.

### Conditions

Use `if` to trigger only when the entity state matches a predicate:

```cds
@n8n.process.start: {
  path: 'order-shipped',
  on: 'UPDATE',
  if: (status = 'shipped')
}
entity Orders as projection on my.Orders;
```

In general, the state of the entity after the event was executed is used to check against the condition. The exception is the DELETE event, where the entity state immediately before the deletion is used.

### Payload mapping

By default, all direct entity attributes are sent as payload to the n8n instance. You can customize the sent fields with the `@n8n.process.start.inputs` annotation:

```cds
@n8n.process.start: {
  path: 'shipment-ready',
  on: 'UPDATE',
  inputs: [
    $self.ID,
    $self.total,
    $self.items.ID,
    $self.items.title
  ]
}
entity Shipments as projection on my.Shipments;
```

For a to-many `items` association, the payload has this shape:

```json
{
  "ID": "c0a80121-...",
  "total": 42.5,
  "items": [
    {
      "ID": "c0a80122-...",
      "title": "Shipping box"
    }
  ]
}
```

Mapping rules:

- Omitted `inputs`, `inputs: []`, and `$self` select all root scalar fields.
- Associations are not expanded by default.
- `$self.<association>` expands all direct fields of an association.
- `$self.<association>.<field>` selects individual nested fields.
- Field aliases are not supported; rename fields in the n8n workflow if needed.

### Multiple triggers

Use the array form to register independent triggers on one entity:

```cds
@n8n.process.start: [
  { path: 'wf-created',  on: 'CREATE' },
  { path: 'wf-archived', on: 'DELETE' }
]
entity Books as projection on my.Books;
```

Each element supports the same fields as the record form (`path`, `method`, `on`, `if`, `inputs`).

## Programmatic API

The `n8n` service is available to application code through CAP. It is not exposed as an HTTP endpoint by the plugin.

### Trigger a workflow

```js
const cds = require("@sap/cds")

const n8n = await cds.connect.to("n8n")

await n8n.send("triggerWorkflow", {
  path: "book-created",
  payload: { title: "Moby Dick", quantity: 3 },
})
```

- `path` is required and must be a relative webhook path. Absolute URLs, protocol-relative URLs, newline characters, and `..` path segments are rejected.
- `payload` is optional

Await the call to detect validation or queueing failures. Never use its resolved value as the workflow result.

When commit or rollback coupling is required, call `send` from a CAP request or transaction context.

### Manage workflows and executions

```js
const cds = require("@sap/cds")
const { SELECT, UPDATE } = cds.ql

const n8n = await cds.connect.to("n8n")
const { WorkflowDefinitions, WorkflowExecutions } = n8n.entities

const active = await n8n.run(SELECT.from(WorkflowDefinitions).where({ active: true }).limit(20))

const execution = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: "exec-42" }))

await n8n.run(UPDATE(WorkflowDefinitions, "abc").with({ name: "Renamed" }))

await n8n.send("publishWorkflow", { id: "abc" })
await n8n.send("unpublishWorkflow", { id: "abc" })
await n8n.send("archiveWorkflow", { id: "abc" })
await n8n.send("stopExecution", { id: "exec-42" })
await n8n.send("stopExecutions", { workflowId: "wf-42", status: ["running", "waiting"] })
await n8n.send("retryExecution", { id: "exec-42", loadWorkflow: true })
```

These operations use n8n's `/api/v1` API and normally require a valid API key.

### Supported `cds.ql` operations

The REST profile supports this subset:

| Operation         | `WorkflowDefinitions`                                     | `WorkflowExecutions`                                 |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| READ              | Yes                                                       | Yes                                                  |
| List filters      | `id`, `id in [...]`, `active`, `name`, `limit`            | `id`, `id in [...]`, `workflowId`, `status`, `limit` |
| Column projection | No                                                        | No                                                   |
| CREATE            | Yes; requires `name`, `nodes`, `connections`, `settings`  | No                                                   |
| UPDATE            | Yes; one `id`, partial updates supported                  | No                                                   |
| UPSERT            | No                                                        | No                                                   |
| DELETE            | `id` or `id in [...]`                                     | `id` or `id in [...]`                                |
| Unbound actions   | `publishWorkflow`, `unpublishWorkflow`, `archiveWorkflow` | `retryExecution`, `stopExecution`                    |

Only the listed filters are forwarded to n8n. Additional predicates, ordering, offsets, and column projections are not applied by the REST profile. Apply any additional processing to the returned rows in application code.

## Delivery behavior

Annotation-driven triggers are queued with the CAP business transaction and are delivered asynchronously after it succeeds. A later network or n8n response failure does not roll back the committed business change. Validation and queueing failures can still fail the originating request.

Queue persistence and retries follow the application's CAP queue configuration. Persistent delivery requires a configured database and a deployed CAP outbox model. Do not assume exactly-once or ordered webhook delivery: include a stable business identifier in the payload and make workflows safe to process more than once when duplicates would be harmful.

Non-successful responses from n8n are reported as `502` errors. For queued webhooks, CAP handles these failures according to its queue retry configuration.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/n8n/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found in our [security policy](https://github.com/cap-js/n8n/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and n8n contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/n8n).
