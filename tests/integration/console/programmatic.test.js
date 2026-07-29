"use strict"

const path = require("path")

process.env.CDS_CONFIG = JSON.stringify({
  requires: {
    N8nService: {
      kind: "console-n8n-service",
      outboxed: false,
    },
  },
})

const cds = require("@sap/cds")

const app = path.join(__dirname, "../../bookshop")
const { expect } = cds.test(app)

describe("N8nService - programmatic API (console kind)", () => {
  let n8n
  let impl

  beforeAll(async () => {
    n8n = await cds.connect.to("N8nService")
    impl = cds.services.N8nService
  })

  beforeEach(() => {
    if (impl?.executions) impl.executions.length = 0
  })

  it('emit("trigger") records a synthetic execution', async () => {
    await n8n.emit("trigger", {
      path: "manual-hook",
      payload: { greeting: "hi" },
    })
    expect(impl.executions).to.have.length(1)
    expect(impl.executions[0]).to.include({ path: "manual-hook" })
    expect(impl.executions[0].payload).to.deep.equal({ greeting: "hi" })
  })

  it('send("getExecution") returns a stored execution', async () => {
    await n8n.emit("trigger", { path: "wf-a", payload: { x: 1 } })
    const id = impl.executions[0].id
    const exec = await n8n.send("getExecution", { executionId: id })
    expect(exec.id).to.equal(id)
    expect(exec.path).to.equal("wf-a")
  })

  it('send("listExecutions") filters by webhook path', async () => {
    await n8n.emit("trigger", { path: "wf-x", payload: {} })
    await n8n.emit("trigger", { path: "wf-y", payload: {} })
    await n8n.emit("trigger", { path: "wf-x", payload: {} })
    const list = await n8n.send("listExecutions", { workflowId: "wf-x" })
    expect(list).to.have.length(2)
    for (const e of list) expect(e.path).to.equal("wf-x")
  })

  it("rejects trigger without path parameter", async () => {
    let err
    try {
      await n8n.emit("trigger", { payload: {} })
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(String(err.message)).to.match(/path/i)
  })
})
