# Bookshop sample - @cap-js/n8n

Full CAP application demonstrating the `@cap-js/n8n` plugin - includes
the standard `sap.capire.bookshop` model (Books, Authors, Genres) with
seeded data, two Fiori launchpad tiles (`admin-books`, `browse`), and an
additional `Orders` entity used to showcase the plugin.

## What it shows

Three annotation flavors, one workflow per flavor under `workflows/`:

| Flow            | CDS pattern                                                                             | Fires on                                 | Payload                               |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| `book-created`  | String shorthand - `@n8n.process.start: 'book-created'` on `Books`                      | Books CREATE + UPDATE                    | Full row                              |
| `order-shipped` | Record form with `if` + `inputs` on `Orders`                                            | Orders UPDATE where `status = 'shipped'` | `{ ID, quantity, book_ID }`           |
| `order-deleted` | Qualified record form (`#deleted`) on `Orders` - relies on the plugin's DELETE prefetch | Orders DELETE                            | Pre-delete `{ ID, quantity, status }` |

Also demonstrates **profile-driven config**:

- **Default (no profile / `[development]`)** - inherits the plugin's built-in
  `console-n8n-service` kind. Payloads are logged to the CDS log; no network
  calls, no docker, no auth. This is the default `cds watch` experience.
- **`[hybrid]`** - opts into `n8n-to-rest` pointing at a local n8n docker
  container on `http://localhost:5678`. Fires real webhooks. See
  [_Run against a real n8n_](#run-against-a-real-n8n-hybrid-profile) below.

## Run

```bash
npm install
cds watch tests/bookshop
```

CAP starts on `http://localhost:4004` with the console kind active. Triggering
any of the flows below prints the outbound payload to the CDS log instead of
POSTing to n8n - handy for iterating on annotations without a running n8n
instance.

## Trigger the flows via curl

The AdminService is mounted at `/odata/v4/admin`. `Books` keys are integers;
`Orders` keys are UUIDs. OData v4 accepts both unquoted in parentheses.

### Flow 1 - `book-created` (Books CREATE + UPDATE)

Sends the full row as payload.

```bash
# CREATE - fires book-created (author_ID references seeded Authors data)
curl -X POST http://localhost:4004/odata/v4/admin/Books \
  -H 'Content-Type: application/json' \
  -d '{ "ID": 999, "title": "Moby Dick", "author_ID": 101, "stock": 5, "price": 12.50 }'

# UPDATE - also fires book-created (string shorthand → CREATE + UPDATE)
curl -X PATCH "http://localhost:4004/odata/v4/admin/Books(999)" \
  -H 'Content-Type: application/json' \
  -d '{ "stock": 4 }'
```

### Flow 2 - `order-shipped` (Orders UPDATE, gated by `if`)

Sends only `{ ID, quantity, book_ID }` - the `.inputs` mapping selects the
projection; the `.if` clause skips the trigger unless `status = 'shipped'`.

```bash
# 1) Create an order (no trigger - Orders has no CREATE annotation)
curl -X POST http://localhost:4004/odata/v4/admin/Orders \
  -H 'Content-Type: application/json' \
  -d '{ "book_ID": 999, "quantity": 2, "status": "new" }'

# 2) Ship it - fires order-shipped
curl -X PATCH "http://localhost:4004/odata/v4/admin/Orders(<order-uuid>)" \
  -H 'Content-Type: application/json' \
  -d '{ "status": "shipped" }'

# Negative: any other status update is filtered by the if-clause - no trigger.
curl -X PATCH "http://localhost:4004/odata/v4/admin/Orders(<order-uuid>)" \
  -H 'Content-Type: application/json' \
  -d '{ "status": "cancelled" }'
```

### Flow 3 - `order-deleted` (Orders DELETE)

Sends the **pre-delete** snapshot `{ ID, quantity, status }` - the plugin's
before-DELETE handler stashes the row so the webhook still sees its state.

```bash
curl -X DELETE "http://localhost:4004/odata/v4/admin/Orders(<order-uuid>)"
```

### Handy helpers

```bash
# List books
curl 'http://localhost:4004/odata/v4/admin/Books?$select=ID,title,stock'

# List orders (grab a UUID for the PATCH/DELETE commands above)
curl 'http://localhost:4004/odata/v4/admin/Orders?$select=ID,status,quantity,book_ID'
```

## Run against a real n8n (`hybrid` profile)

The sample ships a `[hybrid]` profile that swaps the console kind for
`n8n-to-rest` and points at `http://localhost:5678`.

```bash
# 1) Start local n8n on :5678 (workflows/ is mounted read-only).
docker compose up -d

# 2) Open http://localhost:5678, create an owner account, then import
#    and activate each file under workflows/:
#      - workflows/book-created.json
#      - workflows/order-shipped.json
#      - workflows/order-deleted.json

# 3) Generate an n8n API key (Settings → n8n API → Create API Key) and
#    put it in tests/bookshop/.env as N8N_API_KEY=<key>, or export it.
#    The plugin uses it for both webhook triggers and REST reads.

# 4) Run CAP with the hybrid profile, FROM THE BOOKSHOP DIRECTORY so the
#    local .env is picked up.
cd tests/bookshop
cds watch --profile hybrid
```

Trigger any of the curl commands above and the CAP outbox will dispatch a POST
to `http://localhost:5678/webhook/<path>` with the shaped payload.

### Reading executions & workflows over the entity surface

With the hybrid profile active you can query n8n's REST API through CAP:

```bash
curl 'http://localhost:4004/odata/v4/n8n/WorkflowDefinitions'
curl 'http://localhost:4004/odata/v4/n8n/WorkflowExecutions?$filter=workflowId%20eq%20%27abc%27'
```

Or via `cds repl`:

```bash
cds repl --profile hybrid
```

```js
const n8n = await cds.connect.to("N8nService")
const { WorkflowExecutions, WorkflowDefinitions } = n8n.entities

await n8n.run(SELECT.from(WorkflowDefinitions))
await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId: "<id>" }))
await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: "<execId>" }))
```

### Troubleshooting

**Browser shows an endless Basic-auth login popup when hitting `/odata/v4/n8n/…`.**
That means n8n rejected the read (typically 401 for a missing/wrong API key).
The plugin remaps upstream 4xx/5xx to `502 Bad Gateway` to avoid this loop, but
if you still see a popup:

- Check the CAP log for `N8nService: no n8n API key resolved` — the preflight
  warning printed at startup.
- Verify `N8N_API_KEY` is actually in `process.env`. `.env` files are only
  loaded when `cds watch` runs from the directory containing the `.env`, so
  `cd tests/bookshop && cds watch --profile hybrid` is correct;
  `cds watch tests/bookshop` from the repo root will not pick up
  `tests/bookshop/.env`.
- Alternatively add `apiKey` to the `[hybrid]` credentials in `package.json`
  (see below).

If your n8n instance enforces auth, add an `apiKey` next to `baseUrl` under the
`[hybrid]` block in `package.json`:

```jsonc
"N8nService": {
  "[hybrid]": {
    "kind": "n8n-to-rest",
    "credentials": {
      "baseUrl": "http://localhost:5678",
      "apiKey": "eyJ..."
    }
  }
}
```
