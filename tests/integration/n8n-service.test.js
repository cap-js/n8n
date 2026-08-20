const cds = require("@sap/cds")
const path = require("path")
const { waitForExecution, makeWorkflowBody } = require("../utils")

const app = path.join(__dirname, "../bookshop")
const { expect } = cds.test(app)
const isRest = cds.env.requires?.n8n?.kind === "n8n-to-rest"

function makeTestWorkflowBody(name, webhookPath, executionKind, method = "POST") {
  const nodes = []
  const connections = {}
  if (executionKind === "waiting") {
    nodes.push({
      id: cds.utils.uuid(),
      name: "Wait",
      type: "n8n-nodes-base.wait",
      typeVersion: 1.1,
      position: [450, 300],
      parameters: { resume: "timeInterval", amount: 1, unit: "minutes" },
    })
    connections.Webhook = { main: [[{ node: "Wait", type: "main", index: 0 }]] }
  }
  if (executionKind === "failed") {
    nodes.push({
      id: cds.utils.uuid(),
      name: "Fail",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [450, 300],
      parameters: { jsCode: 'throw new Error("intentional test failure")' },
    })
    connections.Webhook = { main: [[{ node: "Fail", type: "main", index: 0 }]] }
  }
  if (executionKind === "echo") {
    nodes.push({
      id: cds.utils.uuid(),
      name: "Respond",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.4,
      position: [450, 300],
      parameters: { respondWith: "json", responseBody: "={{ $json.body }}" },
    })
    connections.Webhook = { main: [[{ node: "Respond", type: "main", index: 0 }]] }
  }
  const body = makeWorkflowBody(name, webhookPath, nodes, connections, method)
  if (executionKind === "echo") body.nodes[0].parameters.responseMode = "responseNode"
  return body
}

let n8n
let WorkflowDefinitions
let WorkflowExecutions

const createdWorkflowIds = new Set()

// Creates a real workflow definition with a webhook trigger node. The
// webhook path defaults to a fresh UUID so parallel and repeated runs
// don't collide against a persistent n8n instance under REST mode.
async function createTestWorkflow(
  name,
  webhookPath = cds.utils.uuid(),
  executionKind,
  method = "POST",
) {
  const body = makeTestWorkflowBody(name, webhookPath, executionKind, method)
  const [{ id }] = await n8n.run(INSERT.into(WorkflowDefinitions).entries(body))
  createdWorkflowIds.add(id)
  return { id, name, webhookPath, body }
}

async function createPublishedWebhookWorkflow(name, executionKind, method = "POST") {
  const workflow = await createTestWorkflow(name, cds.utils.uuid(), executionKind, method)
  await n8n.send("publishWorkflow", { id: workflow.id })
  return workflow
}

async function waitForStoppedExecutions(workflowId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    // Retrying is intentional until n8n has made the execution stoppable.
    // eslint-disable-next-line no-await-in-loop
    const stopped = await n8n.send("stopExecutions", {
      workflowId,
      status: ["waiting", "running"],
    })
    if (stopped > 0) return stopped
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out stopping executions of workflow ${workflowId}`)
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
  async function expectTriggerError(data, pattern) {
    let error
    try {
      await n8n.emit("triggerWorkflow", data)
    } catch (err) {
      error = err
    }
    expect(error).toBeDefined
    expect(String(error.message)).toMatch(pattern)
  }

  it("uses the webhook method configured on the workflow", async () => {
    const workflow = await createPublishedWebhookWorkflow("trigger-method", "echo", "GET")

    await n8n.send("triggerWorkflow", {
      path: workflow.webhookPath,
      method: "GET",
    })

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflow.id },
      (e) => e.workflowId === workflow.id,
    )
    expect(execution).toBeDefined

    // A matching method succeeds; the same path with a different method must fail.
    await expectTriggerError(
      {
        path: workflow.webhookPath,
        method: "POST",
        payload: { greeting: "wrong-method" },
      },
      /404|405|No webhook found/i,
    )
  })

  it("rejects unsupported runtime webhook methods", async () => {
    await expectTriggerError(
      { path: "method-invalid", method: "TRACE", payload: {} },
      /method must be one of/i,
    )
  })

  it("rejects triggerWorkflow without path parameter", async () => {
    let err
    try {
      await n8n.emit("triggerWorkflow", { payload: {} })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined
    expect(String(err.message)).to.match(/path/i)
  })

  it("rejects triggerWorkflow with an empty / whitespace path parameter", async () => {
    let err
    try {
      await n8n.emit("triggerWorkflow", { path: "   ", payload: {} })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined
    expect(String(err.message)).to.match(/path/i)
  })

  it("records an execution when triggering a workflow with a webhook node at that path", async () => {
    const { webhookPath } = await createPublishedWebhookWorkflow("trigger-record", "echo")

    const result = await n8n.send("triggerWorkflow", {
      path: webhookPath,
      payload: { greeting: "hi" },
    })

    expect(result).toEqual({ greeting: "hi" })
  })

  it("carries the payload through to the recorded execution", async () => {
    const { webhookPath } = await createPublishedWebhookWorkflow("trigger-payload", "echo")
    const payload = { title: "Moby Dick", quantity: 3 }

    const result = await n8n.send("triggerWorkflow", { path: webhookPath, payload })

    expect(result).toEqual(payload)
  })

  it("accepts triggerWorkflow without a payload", async () => {
    const { id: workflowId, webhookPath } = await createPublishedWebhookWorkflow(
      "trigger-ping",
      "echo",
    )

    await n8n.send("triggerWorkflow", { path: webhookPath })

    const execution = await waitForExecution(n8n, WorkflowExecutions, { workflowId })
    expect(execution).toBeDefined
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
    expect(row).toBeDefined
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
    expect(before).toBeDefined
    expect(before.id).toEqual(id)

    await n8n.run(DELETE.from(WorkflowDefinitions).where({ id }))
    createdWorkflowIds.delete(id) // don't attempt a double-delete in afterAll

    const after = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    expect(!after || Object.keys(after).length === 0).to.equal(true)
  })

  it("INSERT returns an array of generated keys with .affected = 1", async () => {
    const body = makeWorkflowBody("shape-insert", cds.utils.uuid())
    const result = await n8n.run(INSERT.into(WorkflowDefinitions).entries(body))
    createdWorkflowIds.add(result[0].id)

    expect(Array.isArray(result)).to.equal(true)
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveProperty("id")
    expect(result.affected).toEqual(1)
  })

  it("UPDATE returns an empty array with .affected = 1", async () => {
    const { id } = await createTestWorkflow("shape-update")

    const result = await n8n.run(UPDATE(WorkflowDefinitions, id).with({ name: "renamed" }))

    expect(Array.isArray(result)).to.equal(true)
    expect(result).toHaveLength(0)
    expect(result.affected).toEqual(1)
  })

  it("DELETE returns an empty array with .affected = 1", async () => {
    const { id } = await createTestWorkflow("shape-delete")

    const result = await n8n.run(DELETE.from(WorkflowDefinitions).where({ id }))
    createdWorkflowIds.delete(id) // don't double-delete in afterAll

    expect(Array.isArray(result)).to.equal(true)
    expect(result).toHaveLength(0)
    expect(result.affected).toEqual(1)
  })

  it("stops waiting executions for a workflow", async () => {
    const { id: workflowId, webhookPath } = await createPublishedWebhookWorkflow(
      "stop-executions",
      "waiting",
    )

    await n8n.emit("triggerWorkflow", { path: webhookPath, payload: {} })

    const stopped = await waitForStoppedExecutions(workflowId)
    expect(stopped).toEqual(1)
  })

  it("should return a workflow when calling publishWorkflow action", async () => {
    // create test workflow
    const { id } = await createTestWorkflow("publish")
    const workflow = await n8n.run(SELECT.one.from(WorkflowDefinitions).where({ id }))
    const result = await n8n.send("publishWorkflow", { id })

    expect(result.id).toEqual(workflow.id)
    expect(result.active).toEqual(true)
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

    expect(result.id).toEqual(workflow.id)
    expect(result.active).toEqual(false)
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

    expect(result.id).toEqual(workflow.id)
    expect(result.isArchived).toEqual(true)
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
  async function seedExecution(name, executionKind) {
    const { id: workflowId, webhookPath } = await createPublishedWebhookWorkflow(
      `exec-${name}`,
      executionKind,
    )
    await n8n.emit("triggerWorkflow", { path: webhookPath, payload: { hello: "world" } })
    const status = executionKind === "failed" ? "error" : undefined
    const { id } = await waitForExecution(
      n8n,
      WorkflowExecutions,
      isRest && status === "waiting" ? { status } : { workflowId },
      (execution) => execution.workflowId === workflowId,
    )
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
    expect(hit).toBeDefined
  })

  it("should return a single execution when using where clause", async () => {
    // create test execution
    const execId = await seedExecution("select-one-exec")

    const row = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(row).toBeDefined
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

  it("DELETE returns an empty array with .affected = 1", async () => {
    // create test execution
    const execId = await seedExecution("delete-exec-shape")

    const result = await n8n.run(DELETE.from(WorkflowExecutions).where({ id: execId }))
    executionIds.delete(execId) // don't attempt a double-delete in afterAll

    expect(Array.isArray(result)).to.equal(true)
    expect(result).toHaveLength(0)
    expect(result.affected).toEqual(1)
  })

  it("should return an execution when calling retryExecution action", async () => {
    // create test execution
    const execId = await seedExecution("retry-exec-return", isRest ? "failed" : undefined)
    const execution = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    const result = await n8n.send("retryExecution", {
      id: execId,
      loadWorkflow: true,
    })

    expect(result.workflowId).toEqual(execution.workflowId)
    expect(result.mode).toEqual("retry")
    expect(String(result.retryOf)).toEqual(String(execId))
    expect(result.id).toBeDefined
    expect(result.id).not.toEqual(execId)
  })

  it("should insert a linked new execution when calling retryExecution", async () => {
    // create test execution
    const execId = await seedExecution("retry-exec-behaviour", isRest ? "failed" : undefined)
    const original = await n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execId }))
    expect(original).toBeDefined

    const retried = await n8n.send("retryExecution", {
      id: execId,
      loadWorkflow: true,
    })
    expect(retried?.id).toBeDefined
    expect(retried.id).not.toEqual(execId)
    executionIds.add(retried.id)

    const retriedFromDb = await n8n.run(
      SELECT.one.from(WorkflowExecutions).where({ id: retried.id }),
    )
    expect(retriedFromDb).toBeDefined
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
