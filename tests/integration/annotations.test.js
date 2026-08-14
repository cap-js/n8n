const cds = require("@sap/cds")

const path = require("path")
const app = path.join(__dirname, "../bookshop")
const { POST, PATCH, DELETE, expect } = cds.test(app)
// `DELETE` above is the HTTP helper from cds.test. For CQL wipes we reach
// through cds.ql to avoid the name clash.
const { DELETE: cql_DELETE } = cds.ql

describe("@n8n.process.start - annotation-driven flow", () => {
  let n8n
  let WorkflowExecutions

  beforeAll(async () => {
    n8n = await cds.connect.to("n8n")
    ;({ WorkflowExecutions } = n8n.entities)
  })

  beforeEach(async () => {
    await cds.run(cql_DELETE.from(WorkflowExecutions))
  })

  it('fires the "book-created" webhook on CREATE', async () => {
    // AdminService.Books is @odata.draft.enabled via the Fiori app, so
    // creation is a two-step flow: POST creates a draft, then draftActivate
    // creates the active row (which is what triggers the CREATE handler).
    const { status: draftStatus, data: draft } = await POST("/odata/v4/admin/Books", {
      ID: 9001,
      title: "Moby Dick",
      author_ID: 101,
      stock: 5,
      price: 10.5,
    })
    expect(draftStatus).to.equal(201)
    // No trigger yet - the row is still a draft.
    let created = await SELECT.from(WorkflowExecutions).where({ workflowId: "book-created" })
    expect(created).to.have.length(0)

    const activateUrl = `/odata/v4/admin/Books(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`
    const { status: actStatus } = await POST(activateUrl)
    expect(actStatus).to.equal(201)

    created = await SELECT.from(WorkflowExecutions).where({ workflowId: "book-created" })
    expect(created).to.have.length(1)
    expect(created[0].data?.payload).to.include({ title: "Moby Dick", author_ID: 101 })
  })

  it('does NOT fire "order-shipped" when status is not "shipped"', async () => {
    const { status, data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 2,
      status: "new",
    })
    expect(status).to.equal(201)
    // The Orders trigger is only for UPDATE + status=shipped, so CREATE fires nothing.
    let shipped = await SELECT.from(WorkflowExecutions).where({ workflowId: "order-shipped" })
    expect(shipped).to.have.length(0)

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "cancelled" })
    shipped = await SELECT.from(WorkflowExecutions).where({ workflowId: "order-shipped" })
    expect(shipped).to.have.length(0)
  })

  it('fires "order-shipped" only when status transitions to "shipped"', async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 3,
      status: "new",
    })
    await cds.run(cql_DELETE.from(WorkflowExecutions))

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "shipped" })

    const shipped = await SELECT.from(WorkflowExecutions).where({ workflowId: "order-shipped" })
    expect(shipped).to.have.length(1)
    // Payload carries only the mapped columns (ID + quantity + book_ID).
    expect(shipped[0].data?.payload).to.have.property("ID", order.ID)
    expect(shipped[0].data?.payload).to.have.property("quantity", 3)
    expect(shipped[0].data?.payload).to.have.property("book_ID")
  })

  it("sends the full pre-delete row on DELETE via the prefetch stash", async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 7,
      status: "new",
    })
    await cds.run(cql_DELETE.from(WorkflowExecutions))

    await DELETE(`/odata/v4/admin/Orders(${order.ID})`)

    const deleted = await SELECT.from(WorkflowExecutions).where({ workflowId: "order-deleted" })
    expect(deleted, "DELETE trigger should fire exactly once").to.have.length(1)
    // Without the before-DELETE prefetch, `quantity` and `status` would be
    // missing here because the after-handler runs against a row that's gone.
    expect(deleted[0].data?.payload).to.deep.include({
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
    await cds.run(cql_DELETE.from(WorkflowExecutions))

    await DELETE(`/odata/v4/admin/Orders(${order.ID})`)

    const deleted = await SELECT.from(WorkflowExecutions).where({ workflowId: "order-deleted" })
    expect(deleted).to.have.length(0)
  })
})

describe("@n8n.process.start - array form", () => {
  let n8n
  let WorkflowExecutions

  beforeAll(async () => {
    n8n = await cds.connect.to("n8n")
    ;({ WorkflowExecutions } = n8n.entities)
  })

  beforeEach(async () => {
    await cds.run(cql_DELETE.from(WorkflowExecutions))
  })

  it('fires "shelf-created" on CREATE via array annotation', async () => {
    const { status, data: shelf } = await POST("/odata/v4/admin/Shelves", { label: "Fiction" })
    expect(status).to.equal(201)
    expect(shelf).to.have.property("ID")

    const created = await SELECT.from(WorkflowExecutions).where({ workflowId: "shelf-created" })
    expect(created).to.have.length(1)
  })

  it('fires "shelf-deleted" on DELETE via array annotation', async () => {
    const { data: shelf } = await POST("/odata/v4/admin/Shelves", { label: "Science" })
    await cds.run(cql_DELETE.from(WorkflowExecutions))

    await DELETE(`/odata/v4/admin/Shelves(${shelf.ID})`)

    const deleted = await SELECT.from(WorkflowExecutions).where({ workflowId: "shelf-deleted" })
    expect(deleted).to.have.length(1)
  })
})
