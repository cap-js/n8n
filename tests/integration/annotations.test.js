const cds = require("@sap/cds")
const { waitForExecution, makeWorkflowBody } = require("../utils")

const path = require("path")
const app = path.join(__dirname, "../bookshop")
const { POST, PATCH, DELETE, expect } = cds.test(app)
const isRest = cds.env.requires?.n8n?.kind === "n8n-to-rest"

function executionPayload(execution) {
  const data = typeof execution.data === "string" ? JSON.parse(execution.data) : execution.data
  return data?.payload ?? data?.resultData?.runData?.Webhook?.[0]?.data?.main?.[0]?.[0]?.json?.body
}

describe("@n8n.process.start - annotation-driven flow", () => {
  let n8n
  let WorkflowDefinitions
  let WorkflowExecutions
  const workflowIds = new Map()
  const createdWorkflowIds = new Set()
  const executionIds = new Set()

  async function executionsFor(path) {
    const workflowId = workflowIds.get(path)
    if (!workflowId) return []
    return n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
  }

  beforeAll(async () => {
    n8n = await cds.connect.to("n8n")
    ;({ WorkflowDefinitions, WorkflowExecutions } = n8n.entities)
    const paths = [
      "annotation-test-book-created",
      "annotation-test-order-shipped",
      "annotation-test-order-deleted",
    ]
    const workflows = await Promise.all(
      paths.map(async (path) => {
        const [{ id }] = await n8n.run(
          INSERT.into(WorkflowDefinitions).entries(makeWorkflowBody(`annotation-${path}`, path)),
        )
        if (isRest) await n8n.send("publishWorkflow", { id })
        return { path, id }
      }),
    )
    for (const { path, id } of workflows) {
      createdWorkflowIds.add(id)
      workflowIds.set(path, id)
    }
  })

  afterAll(async () => {
    if (isRest && executionIds.size > 0) {
      await n8n.run(cds.delete(WorkflowExecutions).where({ id: [...executionIds] }))
    }
    if (createdWorkflowIds.size > 0) {
      await n8n.run(cds.delete(WorkflowDefinitions).where({ id: [...createdWorkflowIds] }))
    }
  })

  beforeEach(async () => {
    if (isRest) return
    const rows = await n8n.run(SELECT.from(WorkflowExecutions))
    if (rows.length > 0)
      await n8n.run(cds.delete(WorkflowExecutions).where({ id: rows.map((row) => row.id) }))
  })

  it('fires the "book-created" webhook exactly once for the active CREATE', async () => {
    // Draft creation is separate from active CREATE; only the latter triggers.
    const bookId = Math.floor(Math.random() * 1_000_000_000)
    const { status: draftStatus, data: draft } = await POST("/odata/v4/admin/Books", {
      ID: bookId,
      title: "Moby Dick",
      author_ID: 101,
      stock: 5,
      price: 10.5,
    })
    expect(draftStatus).to.equal(201)
    // No trigger yet - the row is still a draft.
    let created = await executionsFor("annotation-test-book-created")
    const createdBeforeActivation = created.length

    const activateUrl = `/odata/v4/admin/Books(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`
    const { status: actStatus } = await POST(activateUrl)
    expect(actStatus).to.equal(201)

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflowIds.get("annotation-test-book-created") },
      (row) => !created.some((previous) => String(previous.id) === String(row.id)),
      true,
    )
    expect(createdBeforeActivation).to.equal(0)
    // Activation must produce one execution, not one per lifecycle step.
    const createdAfterActivation = await executionsFor("annotation-test-book-created")
    expect(createdAfterActivation).to.have.length(1)
    expect(executionPayload(execution)).to.include({ title: "Moby Dick", author_ID: 101 })
  })

  it('does NOT fire "order-shipped" when status is not "shipped"', async () => {
    const { status, data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 2,
      status: "new",
    })
    expect(status).to.equal(201)
    // The Orders trigger is only for UPDATE + status=shipped, so CREATE fires nothing.
    let shipped = await executionsFor("annotation-test-order-shipped")
    const shippedBeforeUpdate = shipped.length

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "cancelled" })
    shipped = await executionsFor("annotation-test-order-shipped")
    expect(shipped).to.have.length(shippedBeforeUpdate)
  })

  it('fires "order-shipped" only when status transitions to "shipped"', async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 3,
      status: "new",
    })
    const before = await executionsFor("annotation-test-order-shipped")

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "shipped" })

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflowIds.get("annotation-test-order-shipped") },
      (row) => !before.some((previous) => String(previous.id) === String(row.id)),
      true,
    )
    // Payload carries only the mapped columns (ID + quantity + book_ID).
    expect(executionPayload(execution)).to.have.property("ID", order.ID)
    expect(executionPayload(execution)).to.have.property("quantity", 3)
    expect(executionPayload(execution)).to.have.property("book_ID")
  })

  it("sends the full pre-delete row on DELETE via the prefetch stash", async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 7,
      status: "new",
    })
    const before = await executionsFor("annotation-test-order-deleted")

    await DELETE(`/odata/v4/admin/Orders(${order.ID})`)

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflowIds.get("annotation-test-order-deleted") },
      (row) => !before.some((previous) => String(previous.id) === String(row.id)),
      true,
    )
    // Without the before-DELETE prefetch, `quantity` and `status` would be
    // missing here because the after-handler runs against a row that's gone.
    expect(executionPayload(execution)).to.deep.include({
      ID: order.ID,
      quantity: 7,
      status: "new",
    })
  })

  it("does not fire a DELETE trigger when its condition is false", async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 1,
      status: "shipped",
    })
    const before = await executionsFor("annotation-test-order-deleted")

    await DELETE(`/odata/v4/admin/Orders(${order.ID})`)

    const deleted = await executionsFor("annotation-test-order-deleted")
    expect(deleted).to.have.length(before.length)
  })
})

describe("@n8n.process.start - array form", () => {
  let n8n
  let WorkflowDefinitions
  let WorkflowExecutions
  const workflowIds = new Map()
  const createdWorkflowIds = new Set()
  const executionIds = new Set()

  async function executionsFor(path) {
    const workflowId = workflowIds.get(path)
    if (!workflowId) return []
    return n8n.run(SELECT.from(WorkflowExecutions).where({ workflowId }))
  }

  beforeAll(async () => {
    n8n = await cds.connect.to("n8n")
    ;({ WorkflowDefinitions, WorkflowExecutions } = n8n.entities)
    const paths = ["annotation-test-shelf-created", "annotation-test-shelf-deleted"]
    const workflows = await Promise.all(
      paths.map(async (path) => {
        const [{ id }] = await n8n.run(
          INSERT.into(WorkflowDefinitions).entries(makeWorkflowBody(`annotation-${path}`, path)),
        )
        if (isRest) await n8n.send("publishWorkflow", { id })
        return { path, id }
      }),
    )
    for (const { path, id } of workflows) {
      createdWorkflowIds.add(id)
      workflowIds.set(path, id)
    }
  })

  afterAll(async () => {
    if (isRest && executionIds.size > 0) {
      await n8n.run(cds.delete(WorkflowExecutions).where({ id: [...executionIds] }))
    }
    if (createdWorkflowIds.size > 0) {
      await n8n.run(cds.delete(WorkflowDefinitions).where({ id: [...createdWorkflowIds] }))
    }
  })

  beforeEach(async () => {
    if (isRest) return
    const rows = await n8n.run(SELECT.from(WorkflowExecutions))
    if (rows.length > 0)
      await n8n.run(cds.delete(WorkflowExecutions).where({ id: rows.map((row) => row.id) }))
  })

  it('fires "shelf-created" on CREATE via array annotation', async () => {
    const before = await executionsFor("annotation-test-shelf-created")
    const { status, data: shelf } = await POST("/odata/v4/admin/Shelves", { label: "Fiction" })
    expect(status).to.equal(201)
    expect(shelf).to.have.property("ID")

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflowIds.get("annotation-test-shelf-created") },
      (row) => !before.some((previous) => String(previous.id) === String(row.id)),
      true,
    )
    executionIds.add(execution.id)
    expect(executionPayload(execution)).to.include({ ID: shelf.ID, label: "Fiction" })
  })

  it('fires "shelf-deleted" on DELETE via array annotation', async () => {
    const { data: shelf } = await POST("/odata/v4/admin/Shelves", { label: "Science" })
    const before = await executionsFor("annotation-test-shelf-deleted")

    await DELETE(`/odata/v4/admin/Shelves(${shelf.ID})`)

    const execution = await waitForExecution(
      n8n,
      WorkflowExecutions,
      { workflowId: workflowIds.get("annotation-test-shelf-deleted") },
      (row) => !before.some((previous) => String(previous.id) === String(row.id)),
      true,
    )
    executionIds.add(execution.id)
    expect(executionPayload(execution)).to.include({ ID: shelf.ID })
  })

  it("does not register or fire an array trigger without on", async () => {
    const before = await executionsFor("annotation-test-shelf-no-on")
    const { status } = await POST("/odata/v4/admin/Shelves", { label: "No trigger" })
    expect(status).to.equal(201)

    const executions = await executionsFor("annotation-test-shelf-no-on")
    expect(executions).to.have.length(before.length)
  })
})
