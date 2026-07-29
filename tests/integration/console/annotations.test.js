"use strict"

const path = require("path")

// Force the console kind BEFORE cds is required so that env is snapshot with
// the desired impl selected. We can't rely on a `[test]` profile alone because
// CAP loads the plugin's `[development]` credentials block eagerly.
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
const { POST, PATCH, DELETE, expect } = cds.test(app)

describe("@n8n.process.start - annotation-driven flow (console kind)", () => {
  let n8n

  beforeAll(async () => {
    // Reach through to the actual service instance (not the outbox proxy) so
    // we can read the console kind's in-memory `executions` array.
    await cds.connect.to("N8nService")
    n8n = cds.services.N8nService
    expect(n8n, "N8nService instance").to.be.ok
    expect(n8n.executions, "console kind should expose in-memory executions").to.be.an("array")
  })

  beforeEach(() => {
    if (n8n?.executions) n8n.executions.length = 0
  })

  it('fires the "book-created" webhook on CREATE (string shorthand)', async () => {
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
    expect(n8n.executions.filter((e) => e.path === "book-created")).to.have.length(0)

    const activateUrl = `/odata/v4/admin/Books(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`
    const { status: actStatus } = await POST(activateUrl)
    expect(actStatus).to.equal(201)

    // Console service records executions synchronously (outboxed: false).
    const created = n8n.executions.filter((e) => e.path === "book-created")
    expect(created).to.have.length(1)
    expect(created[0].payload).to.include({ title: "Moby Dick", author_ID: 101 })
  })

  it('does NOT fire "order-shipped" when status is not "shipped"', async () => {
    const { status, data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 2,
      status: "new",
    })
    expect(status).to.equal(201)
    // The Orders trigger is only for UPDATE + status=shipped, so CREATE fires nothing.
    expect(n8n.executions.filter((e) => e.path === "order-shipped")).to.have.length(0)

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "cancelled" })
    expect(n8n.executions.filter((e) => e.path === "order-shipped")).to.have.length(0)
  })

  it('fires "order-shipped" only when status transitions to "shipped"', async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 3,
      status: "new",
    })
    n8n.executions.length = 0

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: "shipped" })

    const shipped = n8n.executions.filter((e) => e.path === "order-shipped")
    expect(shipped).to.have.length(1)
    // Payload carries only the mapped columns (ID + quantity + book_ID).
    expect(shipped[0].payload).to.have.property("ID", order.ID)
    expect(shipped[0].payload).to.have.property("quantity", 3)
    expect(shipped[0].payload).to.have.property("book_ID")
  })

  it("sends the full pre-delete row on DELETE via the prefetch stash", async () => {
    const { data: order } = await POST("/odata/v4/admin/Orders", {
      quantity: 7,
      status: "new",
    })
    n8n.executions.length = 0

    await DELETE(`/odata/v4/admin/Orders(${order.ID})`)

    const deleted = n8n.executions.filter((e) => e.path === "order-deleted")
    expect(deleted, "DELETE trigger should fire exactly once").to.have.length(1)
    // Without the before-DELETE prefetch, `quantity` and `status` would be
    // missing here because the after-handler runs against a row that's gone.
    expect(deleted[0].payload).to.deep.include({
      ID: order.ID,
      quantity: 7,
      status: "new",
    })
  })
})
