"use strict"

const path = require("path")

// Force the REST kind (not console) so we exercise the branching logic in
// `srv/restN8nService.js`. The stub client injected below spares us any real
// network traffic.
process.env.CDS_CONFIG = JSON.stringify({
  requires: {
    N8nService: {
      kind: "rest-n8n-service",
      // Disable the outbox so `emit('trigger')` runs synchronously against
      // the REST service's on-handler — that's where the branching lives.
      outboxed: false,
      credentials: { baseUrl: "http://unused.invalid" },
    },
  },
})

const cds = require("@sap/cds")
const { markUnrecoverable } = require("../../../lib/api/n8n-client")

const app = path.join(__dirname, "../../bookshop")
const { expect } = cds.test(app)

describe("restN8nService — retry branching", () => {
  let n8n
  let impl
  let originalClient

  beforeAll(async () => {
    n8n = await cds.connect.to("N8nService")
    impl = cds.services.N8nService
    originalClient = impl.client
  })

  afterEach(() => {
    // Restore the real client after every test so we never leak stubs across
    // test files.
    impl.client = originalClient
  })

  it("surfaces retryable (transport) errors from the client back to the caller", async () => {
    impl.client = {
      async trigger() {
        // Unmarked error — outbox treats as retryable.
        throw new Error("ECONNREFUSED")
      },
    }

    let caught
    try {
      await n8n.send("trigger", { path: "wf", payload: {} })
    } catch (err) {
      caught = err
    }
    expect(caught, "retryable errors must bubble so the outbox retries").to.exist
    expect(String(caught.message)).to.match(/ECONNREFUSED/)
  })

  it("swallows unrecoverable HTTP errors and returns { ok: false }", async () => {
    impl.client = {
      async trigger() {
        const err = new Error("404 Not Found")
        err.code = 404
        throw markUnrecoverable(err)
      },
    }

    const result = await n8n.send("trigger", { path: "missing", payload: {} })
    // The outbox would treat a resolved promise as "message done" — no retry.
    expect(result).to.deep.include({ ok: false, status: 404 })
  })

  it("passes through successful responses from the client", async () => {
    impl.client = {
      async trigger() {
        return { ok: true, status: 200, executionId: "exec-42", body: {} }
      },
    }

    const result = await n8n.send("trigger", { path: "wf", payload: {} })
    expect(result).to.deep.include({ ok: true, status: 200, executionId: "exec-42" })
  })
})
