const cds = require("@sap/cds")
const path = require("path")

const app = path.join(__dirname, "../../bookshop")
const { expect } = cds.test(app)

describe("N8nService - programmatic API (console kind)", () => {
  let n8n
  let WorkflowExecutions

  beforeAll(async () => {
    n8n = await cds.connect.to("N8nService")
    ;({ WorkflowExecutions } = n8n.entities)
  })

  beforeEach(async () => {
    // Wipe the in-memory table between tests. `DELETE.from(entity)` is a
    // no-op if the table hasn't been touched yet.
    await DELETE.from(WorkflowExecutions)
  })

  it('emit("trigger") records a synthetic execution in WorkflowExecutions', async () => {
    await n8n.emit("trigger", {
      path: "manual-hook",
      payload: { greeting: "hi" },
    })
    const rows = await SELECT.from(WorkflowExecutions).where({ workflowId: "manual-hook" })
    expect(rows).to.have.length(1)
    expect(rows[0]).to.include({ workflowId: "manual-hook", status: "success", mode: "webhook" })
    expect(rows[0].data).to.deep.equal({ payload: { greeting: "hi" } })
  })

  it("SELECT.one by id returns a stored execution", async () => {
    await n8n.emit("trigger", { path: "wf-a", payload: { x: 1 } })
    const [{ id }] = await SELECT.from(WorkflowExecutions).where({ workflowId: "wf-a" })
    const exec = await SELECT.one.from(WorkflowExecutions).where({ id })
    expect(exec).to.exist
    expect(exec.id).to.equal(id)
    expect(exec.workflowId).to.equal("wf-a")
  })

  it("SELECT with WHERE workflowId returns matching rows only", async () => {
    await n8n.emit("trigger", { path: "wf-x", payload: {} })
    await n8n.emit("trigger", { path: "wf-y", payload: {} })
    await n8n.emit("trigger", { path: "wf-x", payload: {} })
    const list = await SELECT.from(WorkflowExecutions).where({ workflowId: "wf-x" })
    expect(list).to.have.length(2)
    for (const e of list) expect(e.workflowId).to.equal("wf-x")
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

  it("n8n.run(SELECT.from(entity)) goes through the service handler chain", async () => {
    await n8n.emit("trigger", { path: "wf-via-run", payload: {} })
    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId: "wf-via-run" }))
    expect(rows).to.have.length(1)
    expect(rows[0].workflowId).to.equal("wf-via-run")
  })
})
