# Bookshop sample — @cap-js/n8n

Minimal CAP application demonstrating the `@cap-js/n8n` plugin.

## What it shows

- **String shorthand** — `@n8n.trigger: 'book-created'` on `Books` fires the
  `book-created` webhook on CREATE and UPDATE.
- **Record form** — `@n8n.trigger: { workflow, on, if, inputs }` on `Orders`
  fires only when an order transitions to `status = 'shipped'`, and sends
  only a subset of fields (with one aliased).
- **Profile-driven config** — `[development]` targets a local n8n docker
  container at `http://localhost:5678` with no auth. Hybrid/production
  profiles resolve credentials from `cds bind`, BTP destinations, or env vars.

## Run

```bash
# 1) Start local n8n on :5678 (workflows/ is mounted read-only).
docker compose up -d

# 2) Open http://localhost:5678, create an owner account, import
#    workflows/book-created.json manually (or via the n8n API), and
#    activate the workflow.

# 3) Start CAP
npm install
npm run watch

# 4) POST a book:
curl -X POST http://localhost:4004/odata/v4/admin/Books \
     -H 'Content-Type: application/json' \
     -d '{ "title": "Moby Dick", "author": "H. Melville" }'
```

The CAP transaction commits, the CAP outbox then dispatches a POST to
`http://localhost:5678/webhook/book-created` with the created row as payload.

## Environment

Copy `.env.example` to `.env` and adjust as needed. Only `N8N_BASE_URL` and
`N8N_API_KEY` are read by the plugin.
