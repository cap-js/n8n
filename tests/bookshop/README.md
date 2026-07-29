# Bookshop sample — @cap-js/n8n

Full CAP application demonstrating the `@cap-js/n8n` plugin — includes
the standard `sap.capire.bookshop` model (Books, Authors, Genres) with
seeded data, two Fiori launchpad tiles (`admin-books`, `browse`), and an
additional `Orders` entity used to showcase the plugin.

## What it shows

Three annotation flavors, one workflow per flavor under `workflows/`:

| Flow            | CDS pattern                                                                             | Fires on                                 | Payload                               |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| `book-created`  | String shorthand — `@n8n.process.start: 'book-created'` on `Books`                      | Books CREATE + UPDATE                    | Full row                              |
| `order-shipped` | Record form with `if` + `inputs` on `Orders`                                            | Orders UPDATE where `status = 'shipped'` | `{ ID, quantity, book_ID }`           |
| `order-deleted` | Qualified record form (`#deleted`) on `Orders` — relies on the plugin's DELETE prefetch | Orders DELETE                            | Pre-delete `{ ID, quantity, status }` |

Also demonstrates **profile-driven config**: `[development]` targets a local
n8n docker container at `http://localhost:5678` with no auth. Hybrid/production
profiles resolve credentials from `cds bind`, BTP destinations, or env vars.

## Run

```bash
# 1) Start local n8n on :5678 (workflows/ is mounted read-only).
docker compose up -d

# 2) Open http://localhost:5678, create an owner account, then import
#    each file under workflows/ manually (or via the n8n API) and
#    activate the workflows:
#      - workflows/book-created.json
#      - workflows/order-shipped.json
#      - workflows/order-deleted.json

# 3) Start CAP (from the repo root)
npm install
cds watch tests/bookshop
```

The CAP transaction commits, the CAP outbox then dispatches a POST to
`http://localhost:5678/webhook/<path>` with the shaped payload.

## Trigger the flows via curl

The AdminService is mounted at `/odata/v4/admin`. `Books` keys are integers;
`Orders` keys are UUIDs. OData v4 accepts both unquoted in parentheses.

### Flow 1 — `book-created` (Books CREATE + UPDATE)

Sends the full row as payload.

```bash
# CREATE — fires book-created (author_ID references seeded Authors data)
curl -X POST http://localhost:4004/odata/v4/admin/Books \
  -H 'Content-Type: application/json' \
  -d '{ "ID": 999, "title": "Moby Dick", "author_ID": 101, "stock": 5, "price": 12.50 }'

# UPDATE — also fires book-created (string shorthand → CREATE + UPDATE)
curl -X PATCH "http://localhost:4004/odata/v4/admin/Books(999)" \
  -H 'Content-Type: application/json' \
  -d '{ "stock": 4 }'
```

### Flow 2 — `order-shipped` (Orders UPDATE, gated by `if`)

Sends only `{ ID, quantity, book_ID }` — the `.inputs` mapping selects the
projection; the `.if` clause skips the trigger unless `status = 'shipped'`.

```bash
# 1) Create an order (no trigger — Orders has no CREATE annotation)
curl -X POST http://localhost:4004/odata/v4/admin/Orders \
  -H 'Content-Type: application/json' \
  -d '{ "book_ID": 999, "quantity": 2, "status": "new" }'

# 2) Ship it — fires order-shipped
curl -X PATCH "http://localhost:4004/odata/v4/admin/Orders(<order-uuid>)" \
  -H 'Content-Type: application/json' \
  -d '{ "status": "shipped" }'

# Negative: any other status update is filtered by the if-clause — no trigger.
curl -X PATCH "http://localhost:4004/odata/v4/admin/Orders(<order-uuid>)" \
  -H 'Content-Type: application/json' \
  -d '{ "status": "cancelled" }'
```

### Flow 3 — `order-deleted` (Orders DELETE)

Sends the **pre-delete** snapshot `{ ID, quantity, status }` — the plugin's
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

## Environment

Copy `.env.example` to `.env` and adjust as needed. Only `N8N_BASE_URL` and
`N8N_API_KEY` are read by the plugin.
