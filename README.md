# SAP Cloud Application Programming Model, n8n plugin for Node.js

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/n8n)](https://api.reuse.software/info/github.com/cap-js/n8n)

Trigger [n8n](https://n8n.io/) workflows from CAP applications with `@n8n.process.start` annotations or through the programmatic `n8n` service.

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Connect to n8n](#connect-to-n8n)
  - [Local n8n](#local-n8n)
  - [Configuration](#configuration)
  - [Cloud Foundry binding](#cloud-foundry-binding)
  - [BTP destination](#btp-destination)
  - [Credential resolution](#credential-resolution)
- [Webhook requests](#webhook-requests)
  - [Webhook authentication](#webhook-authentication)
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

We use the [@capire/bookshop](https://github.com/capire/bookshop) as a running sample hereinafter. Clone it and open it in VSCode as follows:

```bash
git clone https://github.com/capire/bookshop
code bookshop
```

Within your project root run this to add the plugin:

```bash
npm add @cap-js/n8n
```

Annotate `AdminService.Authors` with `@n8n.process.start`:

```cds
// srv/admin-service.cds
annotate AdminService.Authors with @n8n.process.start: {
  path: 'author-created',
  on: 'CREATE'
};
```

Start your application with `cds watch` and create a new Author to trigger a workflow:

```bash
curl -X POST http://localhost:4004/admin/Authors \
  -H "Content-Type: application/json" \
  -u alice: \
  -d '{
    "ID": 999,
    "name": "Jane Doe",
    "dateOfBirth": "1970-01-15",
    "placeOfBirth": "London"
  }'
```

During local development, the plugin simply logs the webhook path and payload instead of sending actual requests to n8n:

```sh
[odata] - POST /admin/Authors
[n8n] - Triggering n8n workflow {
  method: 'POST',
  webhookUrl: '/webhook/author-created',
  payload: {
    createdAt: '2026-08-25T13:46:45.768Z',
    createdBy: 'alice',
    modifiedAt: '2026-08-25T13:46:45.768Z',
    modifiedBy: 'alice',
    ID: 999,
    name: 'Jane Doe',
    dateOfBirth: '1970-01-15',
    dateOfDeath: null,
    placeOfBirth: 'London',
    placeOfDeath: null
  }
}
```

This allows you to develop and test without running an n8n instance. To connect to an actual n8n instance, check [Connect to n8n](#connect-to-n8n).

## Connect to n8n

The plugin uses these profiles by default:

| Profile       | Behavior                                                 |
| ------------- | -------------------------------------------------------- |
| `development` | Logs triggers without making network requests            |
| `hybrid`      | Sends requests to a local n8n at `http://localhost:5678` |
| `production`  | Sends requests using the configured connection           |

An API key is optional for webhook delivery if the target webhook accepts the request without it. n8n's `/api/v1` workflow and execution APIs normally require an API key. When configured, the plugin sends it as `X-N8N-API-KEY` on `/api/v1` requests only. Webhook nodes are authenticated separately (see [Webhook authentication](#webhook-authentication)).

### Local n8n

Start n8n locally with `npx n8n`, Docker, or the [bookshop sample](tests/bookshop/README.md), then run CAP with the hybrid profile:

```bash
cds watch --profile hybrid
```

The hybrid profile already supplies `http://localhost:5678` as the URL. If you also want to use the `/api/v1` workflow or execution APIs, add an `apiKey` to the `[hybrid]` credentials in `package.json` or `.cdsrc-private.json`.

### Configuration

All connection settings live under `cds.requires.n8n.credentials`. CAP populates them from `package.json`, `.cdsrc-private.json`, bound services (`VCAP_SERVICES`), or `cds_requires_n8n_credentials_*` environment variables.

For a remote n8n via env vars:

```bash
export cds_requires_n8n_credentials_url=https://your.n8n.cloud
export cds_requires_n8n_credentials_apiKey=eyJ...
cds watch --profile production
```

### Cloud Foundry binding

Create and bind a user-provided service:

```bash
cf create-user-provided-service n8n \
  -p '{"url":"https://your.n8n.cloud","apiKey":"eyJ..."}'

cds bind n8n --to n8n
cds watch --profile hybrid
```

### BTP destination

Select a destination explicitly in the profile where it is used:

<!-- prettier-ignore -->
```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[production]": {
          "credentials": {
            "destination": "n8n"
          }
        }
      }
    }
  }
}
```

Authentication headers resolved from the destination are sent on every request. On `/api/v1` requests they are combined with `X-N8N-API-KEY` when an API key is configured. On webhook requests they are combined with any [`webhookAuth`](#webhook-authentication). This supports destinations that authenticate an outer proxy in front of n8n.

### Credential resolution

Within `credentials`, the plugin resolves the connection target in this order:

1. `credentials.destination` — a BTP destination wins outright.
2. `credentials.{url, apiKey}` — inline connection details.

An operation fails when neither is set. `credentials.webhookAuth` (see [Webhook authentication](#webhook-authentication)) is independent of this resolution and is applied to webhook requests regardless of which connection target is used.

To use real webhooks in the development profile, override its service kind:

<!-- prettier-ignore -->
```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[development]": {
          "kind": "n8n-to-rest",
          "credentials": {
            "url": "http://localhost:5678"
          }
        }
      }
    }
  }
}
```

## Webhook requests

Every trigger sends a JSON request to n8n:

```http
{method} {url}/webhook/<path>
Content-Type: application/json
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

### Webhook authentication

The n8n Webhook node supports several authentication options (see [Supported Authentication Methods](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook#supported-authentication-methods)). Configure the matching credential under `cds.requires.n8n.credentials.webhookAuth`:

| Webhook node auth | `webhookAuth` config                                    | Header sent                          |
| ----------------- | ------------------------------------------------------- | ------------------------------------ |
| None              | omit `webhookAuth`                                      | —                                    |
| Basic Auth        | `{ "type": "basic", "username": "u", "password": "p" }` | `Authorization: Basic <base64(u:p)>` |
| Header Auth       | `{ "type": "header", "name": "X-Token", "value": "…" }` | `X-Token: …`                         |
| JWT Auth          | `{ "type": "bearer", "token": "<jwt>" }`                | `Authorization: Bearer <jwt>`        |

Example:

<!-- prettier-ignore -->
```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[production]": {
          "credentials": {
            "url": "https://your.n8n.cloud",
            "webhookAuth": {
              "type": "basic",
              "username": "u",
              "password": "p"
            }
          }
        }
      }
    }
  }
}
```

`webhookAuth` only applies to webhook requests (`/webhook/*` and `/webhook-test/*`). The `apiKey` credential is sent as `X-N8N-API-KEY` on `/api/v1` requests only and is never attached to webhook triggers. Both can be configured side by side.

### Test webhooks

n8n provides two webhook modes:

| Prefix          | Use                                                             |
| --------------- | --------------------------------------------------------------- |
| `/webhook`      | Published workflows; this is the default                        |
| `/webhook-test` | One test event after selecting **Listen for Test Event** in n8n |

Enable test webhooks in the profile-specific plugin config:

<!-- prettier-ignore -->
```jsonc
{
  "cds": {
    "requires": {
      "n8n": {
        "[hybrid]": {
          "useTestWebhook": true,
          "credentials": {
            "url": "http://localhost:5678"
          }
        }
      }
    }
  }
}
```

The feature flag `cds.requires.n8n.useTestWebhook` only specifies on which URL the webhook should be triggered. The queries for workflow and execution operations continue to use `/api/v1`.

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

await n8n.trigger({
  path: "book-created",
  payload: { title: "Moby Dick", quantity: 3 },
})
```

- `path` is required and must be a relative webhook path. Absolute URLs, protocol-relative URLs, newline characters, and `..` path segments are rejected.
- `payload` is optional

Await the call to detect validation or queueing failures. Never use its resolved value as the workflow result.

When commit or rollback coupling is required, call `trigger` from a CAP request or transaction context.

### Manage workflows and executions

```js
const cds = require("@sap/cds")

const n8n = await cds.connect.to("n8n")
const { WorkflowDefinitions, WorkflowExecutions } = n8n.entities

const active = await n8n.run(SELECT.from(WorkflowDefinitions).where({ active: true }).limit(20))

const execution = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: "exec-42" }))

await n8n.run(UPDATE(WorkflowDefinitions, "abc").with({ name: "Renamed" }))

await n8n.publishWorkflow({ id: "abc" })
await n8n.unpublishWorkflow({ id: "abc" })
await n8n.archiveWorkflow({ id: "abc" })
await n8n.stopExecution({ id: "exec-42" })
await n8n.stopExecutions({ workflowId: "wf-42", status: ["running", "waiting"] })
await n8n.retryExecution({ id: "exec-42", loadWorkflow: true })
```

These operations use n8n's `/api/v1` API and normally require a valid API key.

### Supported `cds.ql` operations

The REST profile supports this subset:

| Operation         | `WorkflowDefinitions`                                     | `WorkflowExecutions`                                 |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| READ              | Yes                                                       | Yes                                                  |
| List filters      | `id`, `id in [...]`, `active`, `name`, `limit`            | `id`, `id in [...]`, `workflowId`, `status`, `limit` |
| Column projection | No                                                        | No                                                   |
| CREATE            | Yes (requires `name`, `nodes`, `connections`, `settings`) | No                                                   |
| UPDATE            | Yes; one `id`, partial updates supported                  | No                                                   |
| UPSERT            | No                                                        | No                                                   |
| DELETE            | `id` or `id in [...]`                                     | `id` or `id in [...]`                                |

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

Copyright 2026 SAP SE or an SAP affiliate company and cap-js/n8n contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/n8n).
