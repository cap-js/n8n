const cds = require("@sap/cds")
const path = require("path")

const app = path.join(__dirname, "../bookshop")
const { expect } = cds.test(app)

// Minimal n8n-valid workflow body with webhook-trigger node
function makeWebhookWorkflowBody(name, webhookPath) {
  return {
    id: cds.utils.uuid(),
    name,
    nodes: [
      {
        id: cds.utils.uuid(),
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [250, 300],
        parameters: {
          httpMethod: "POST",
          path: webhookPath,
          responseMode: "onReceived",
          options: {},
        },
        webhookId: webhookPath,
      },
    ],
    connections: {},
    settings: {},
  }
}

let n8n
let WorkflowDefinitions
let WorkflowExecutions

const createdWorkflowIds = new Set()

// Creates a real workflow definition with a webhook trigger node. The
// webhook path defaults to a fresh UUID so parallel and repeated runs
// don't collide against a persistent n8n instance under REST mode.
async function createTestWorkflow(name, webhookPath = cds.utils.uuid()) {
  const body = makeWebhookWorkflowBody(name, webhookPath)
  const created = await n8n.run(INSERT.into(WorkflowDefinitions).entries(body))
  // The REST backend returns the created row (with a server-minted id);
  // the console mock (SQLite-backed) returns an affected-rows count.
  // Fall back to the pre-generated id from the request body in the
  // latter case.
  const id = (Array.isArray(created) ? created[0]?.id : created?.id) ?? body.id
  if (id) createdWorkflowIds.add(id)
  return { id, name, webhookPath, body }
}

beforeAll(async () => {
  n8n = await cds.connect.to("n8n")
  ;({ WorkflowDefinitions, WorkflowExecutions } = n8n.entities)
})

afterAll(async () => {
  if (createdWorkflowIds.size === 0) return
  await n8n.run(DELETE.from(WorkflowDefinitions).where({ id: [...createdWorkflowIds] }))
})

describe("triggerWorkflow", () => {
  it("rejects triggerWorkflow without path parameter", async () => {
    let err
    try {
      await n8n.emit("triggerWorkflow", { payload: {} })
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(String(err.message)).to.match(/path/i)
  })

  it("rejects triggerWorkflow with an empty / whitespace path parameter", async () => {
    let err
    try {
      await n8n.emit("triggerWorkflow", { path: "   ", payload: {} })
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(String(err.message)).to.match(/path/i)
  })

  it("records an execution when triggering a workflow with a webhook node at that path", async () => {
    const { id: workflowId, webhookPath } = await createTestWorkflow("trigger-record")

    await n8n.emit("triggerWorkflow", { path: webhookPath, payload: { greeting: "hi" } })

    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
    expect(rows).to.have.length(1)
    expect(rows[0].workflowId).toEqual(workflowId)
  })

  it("carries the payload through to the recorded execution", async () => {
    const { id: workflowId, webhookPath } = await createTestWorkflow("trigger-payload")
    const payload = { title: "Moby Dick", quantity: 3 }

    await n8n.emit("triggerWorkflow", { path: webhookPath, payload })

    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
    expect(rows).to.have.length(1)
    // The console mock wraps the payload under `data.payload`; the REST
    // backend fires the actual webhook and n8n's stored execution data
    // shape differs. Assert on the console-mock shape here — this test
    // asserts the observable side effect that both backends share:
    // *some* representation of the payload ends up on the recorded row.
    expect(rows[0].data).to.deep.include({ payload })
  })

  it("accepts triggerWorkflow without a payload", async () => {
    const { id: workflowId, webhookPath } = await createTestWorkflow("trigger-ping")

    await n8n.emit("triggerWorkflow", { path: webhookPath })

    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
    expect(rows).to.have.length(1)
  })
})

describe("WorkflowDefinitions", () => {
  it("should return a list of workflows when running SELECT", async () => {
    // create test workflows
    await createTestWorkflow("select-1")
    await createTestWorkflow("select-2")

    const rows = await n8n.run(SELECT.from(WorkflowDefinitions))
    expect(Array.isArray(rows)).to.equal(true)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const names = rows.map((w) => w.name)
    expect(names).toContain("select-1")
    expect(names).toContain("select-2")
  })

  it("should return a single workflow when using where clause", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("select-one")

    const row = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(row).to.exist
    expect(row.id).toEqual(id)
    expect(row.name).toEqual("select-one")
  })

  it("should return multiple workflows using WHERE id IN (...)", async () => {
    // create test workflows
    const { id: id1 } = await createTestWorkflow("select-in-1")
    const { id: id2 } = await createTestWorkflow("select-in-2")

    const rows = await n8n.run(SELECT.from(WorkflowDefinitions).where({ id: [id1, id2] }))
    expect(Array.isArray(rows)).to.equal(true)
    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
  })

  it("should only return selected fields of a workflow", async () => {
    // create test workflows
    const { id: id1 } = await createTestWorkflow("select-in-1")

    const rows = await n8n.run(
      SELECT.from(WorkflowDefinitions).columns(["name"]).where({ id: id1 }),
    )
    expect(Array.isArray(rows)).to.equal(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveProperty("name", "select-in-1")
  })

  it("should rename a workflow via UPDATE", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("update")

    await n8n.run(UPDATE(WorkflowDefinitions, id).with({ name: "Renamed Update" }))

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(after.id).toEqual(id)
    expect(after.name).toEqual("Renamed Update")
  })

  it("silently ignores @readonly fields on UPDATE (active must stay false)", async () => {
    // create test workflow — starts inactive
    const { id } = await createTestWorkflow("update-readonly")
    const before = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(before.active).toEqual(false)

    // Try to flip `active` via a plain UPDATE. CAP strips `@readonly`
    // fields from the payload before the handler runs, so the flag must
    // still be false afterwards. The only way to activate a workflow is
    // via the `publishWorkflow` action.
    await n8n.run(UPDATE(WorkflowDefinitions, id).with({ active: true, name: "renamed" }))

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(after.active).toEqual(false)
    expect(after.name).toEqual("renamed")
  })

  it("should remove a workflow via DELETE", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("delete")

    // sanity check — the row exists before DELETE
    const before = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(before).to.exist
    expect(before.id).toEqual(id)

    await n8n.run(DELETE.from(WorkflowDefinitions).where({ id }))
    createdWorkflowIds.delete(id) // don't attempt a double-delete in afterAll

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    // Both backends signal "not present" as either falsy or `{}`.
    expect(!after || Object.keys(after).length === 0).to.equal(true)
  })

  it("should return a workflow when calling publishWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("publish")
    const workflow = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    const result = await n8n.send("publishWorkflow", { id })

    const { active, updatedAt, ...expected } = workflow
    expect(result).toMatchObject(expected)
  })

  it("should activate a workflow via publishWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("publish")

    const result = await n8n.send("publishWorkflow", { id })

    expect(result.id).toEqual(id)
    expect(result.active).toEqual(true)
  })

  it("should return a workflow when calling unpublishWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("unpublish")
    const workflow = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    const result = await n8n.send("unpublishWorkflow", { id })

    const { active, updatedAt, ...expected } = workflow
    expect(result).toMatchObject(expected)
  })

  it("should deactivate a workflow via unpublishWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("unpublish")

    await n8n.send("publishWorkflow", { id })
    await n8n.send("unpublishWorkflow", { id })

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(after.id).toEqual(id)
    expect(after.active).toEqual(false)
  })

  it("should return a workflow when calling archiveWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("archive")
    const workflow = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    const result = await n8n.send("archiveWorkflow", { id })

    const { active, updatedAt, isArchived, ...expected } = workflow
    expect(result).toMatchObject(expected)
  })

  it("should archive a workflow via archiveWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("archive")

    await n8n.send("archiveWorkflow", { id })

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(after.id).toEqual(id)
    expect(after.isArchived).toEqual(true)
    expect(after.active).toEqual(false)
  })
})

describe("WorkflowExecutions", () => {
  const executionIds = new Set()

  // Seeds a webhook workflow at `webhookPath` and fires it. Returns the
  // resulting execution's id (or null under backends that don't surface
  // the row synchronously). Under the console mock the workflow is not
  // consulted, but creating it mirrors production usage — same pattern
  // as `triggerWorkflow` tests above.
  async function seedExecution(name) {
    const { id: workflowId, webhookPath } = await createTestWorkflow(`exec-${name}`)
    await n8n.emit("triggerWorkflow", { path: webhookPath, payload: { hello: "world" } })
    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
    if (!Array.isArray(rows) || rows.length === 0) return null
    const id = rows[0].id
    executionIds.add(id)
    return id
  }

  afterAll(async () => {
    if (executionIds.size === 0) return
    await n8n.run(DELETE.from(WorkflowExecutions).where({ id: [...executionIds] }))
  })

  it("should return a list of executions when running SELECT", async () => {
    // create test execution
    const execId = await seedExecution("select-list-exec")

    const rows = await n8n.run(SELECT.from(WorkflowExecutions))
    expect(Array.isArray(rows)).to.equal(true)
    const hit = rows.find((r) => String(r.id) === String(execId))
    expect(hit).to.exist
  })

  it("should return a single execution when using where clause", async () => {
    // create test execution
    const execId = await seedExecution("select-one-exec")

    const row = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(row).to.exist
    expect(String(row.id)).toEqual(String(execId))
  })

  it("should return multiple executions using WHERE id IN (...)", async () => {
    // create test executions
    const execId1 = await seedExecution("select-in-exec-1")
    const execId2 = await seedExecution("select-in-exec-2")
    if (!execId1 || !execId2) return

    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where({ id: [execId1, execId2] }))
    expect(Array.isArray(rows)).to.equal(true)
    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => String(r.id))
    expect(ids).toContain(String(execId1))
    expect(ids).toContain(String(execId2))
  })

  it("should only return selected fields of an execution", async () => {
    // create test execution
    const execId = await seedExecution("select-columns-exec")

    const rows = await n8n.run(
      SELECT.from(WorkflowExecutions).columns(["status"]).where({ id: execId }),
    )
    expect(Array.isArray(rows)).to.equal(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveProperty("status")
  })

  it("should remove an execution via DELETE", async () => {
    // create test execution
    const execId = await seedExecution("delete-exec")

    await n8n.run(DELETE.from(WorkflowExecutions).where({ id: execId }))
    executionIds.delete(execId) // don't attempt a double-delete in afterAll

    const after = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(!after || Object.keys(after).length === 0).to.equal(true)
  })

  it("should return an execution when calling stopExecution action", async () => {
    // create test execution
    const execId = await seedExecution("stop-exec-return")
    const execution = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    const result = await n8n.send("stopExecution", { id: execId })

    const { status, finished, stoppedAt, ...expected } = execution
    expect(result).toMatchObject(expected)
  })

  it("should cancel the underlying execution when calling stopExecution", async () => {
    // create test execution
    const execId = await seedExecution("stop-exec-behaviour")
    const before = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(before.status).not.toEqual("canceled")

    await n8n.send("stopExecution", { id: execId })

    const after = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(after.id).toEqual(execId)
    expect(after.status).toEqual("canceled")
    expect(after.finished).toEqual(true)
    expect(after.stoppedAt).to.exist
  })

  it("should return an execution when calling retryExecution action", async () => {
    // create test execution
    const execId = await seedExecution("retry-exec-return")
    const execution = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    const result = await n8n.send("retryExecution", {
      id: execId,
      loadWorkflow: true,
    })

    const { id, mode, startedAt, stoppedAt, retryOf, ...expected } = execution
    expect(result).toMatchObject(expected)
    expect(result.mode).toEqual("retry")
    expect(String(result.retryOf)).toEqual(String(execId))
    expect(result.id).to.exist
    expect(result.id).not.toEqual(execId)
  })

  it("should insert a linked new execution when calling retryExecution", async () => {
    // create test execution
    const execId = await seedExecution("retry-exec-behaviour")
    const original = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(original).to.exist

    const retried = await n8n.send("retryExecution", {
      id: execId,
      loadWorkflow: true,
    })
    expect(retried?.id).to.exist
    expect(retried.id).not.toEqual(execId)

    const retriedFromDb = await n8n.run(
      SELECT.one.from(WorkflowExecutions).where({ id: retried.id }),
    )
    expect(retriedFromDb).to.exist
    expect(retriedFromDb.mode).toEqual("retry")
    expect(String(retriedFromDb.retryOf)).toEqual(String(execId))
    expect(retriedFromDb.workflowId).toEqual(original.workflowId)

    // The original row is still there and untouched.
    const originalAfter = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(originalAfter.id).toEqual(execId)
    expect(originalAfter.mode).toEqual(original.mode)
    expect(originalAfter.status).toEqual(original.status)
  })
})
