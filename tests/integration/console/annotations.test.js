'use strict'

const path = require('path')

// Force the console kind BEFORE cds is required so that env is snapshot with
// the desired impl selected. We can't rely on a `[test]` profile alone because
// CAP loads the plugin's `[development]` credentials block eagerly.
process.env.CDS_CONFIG = JSON.stringify({
  requires: {
    N8nService: {
      kind: 'console-n8n-service',
      outbox: false,
    },
  },
})

const cds = require('@sap/cds')

const app = path.join(__dirname, '../../sample/bookshop')
const { POST, PATCH, expect } = cds.test(app)

describe('@n8n.trigger — annotation-driven flow (console kind)', () => {
  let n8n

  beforeAll(async () => {
    // Reach through to the actual service instance (not the outbox proxy) so
    // we can read the console kind's in-memory `executions` array.
    await cds.connect.to('N8nService')
    n8n = cds.services.N8nService
    expect(n8n, 'N8nService instance').to.be.ok
    expect(n8n.executions, 'console kind should expose in-memory executions').to.be.an('array')
  })

  beforeEach(() => {
    if (n8n?.executions) n8n.executions.length = 0
  })

  it('fires the "book-created" webhook on CREATE (string shorthand)', async () => {
    const { status } = await POST('/odata/v4/admin/Books', {
      title: 'Moby Dick',
      author: 'Herman Melville',
      stock: 5,
      price: 10.5,
    })
    expect(status).to.equal(201)
    // Console service records executions synchronously (outbox: false).
    const created = n8n.executions.filter((e) => e.workflow === 'book-created')
    expect(created).to.have.length(1)
    expect(created[0].payload).to.include({ title: 'Moby Dick', author: 'Herman Melville' })
  })

  it('does NOT fire "order-shipped" when status is not "shipped"', async () => {
    const { status, data: order } = await POST('/odata/v4/admin/Orders', {
      quantity: 2,
      status: 'new',
    })
    expect(status).to.equal(201)
    // The Orders trigger is only for UPDATE + status=shipped, so CREATE fires nothing.
    expect(n8n.executions.filter((e) => e.workflow === 'order-shipped')).to.have.length(0)

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: 'cancelled' })
    expect(n8n.executions.filter((e) => e.workflow === 'order-shipped')).to.have.length(0)
  })

  it('fires "order-shipped" only when status transitions to "shipped"', async () => {
    const { data: order } = await POST('/odata/v4/admin/Orders', {
      quantity: 3,
      status: 'new',
    })
    n8n.executions.length = 0

    await PATCH(`/odata/v4/admin/Orders(${order.ID})`, { status: 'shipped' })

    const shipped = n8n.executions.filter((e) => e.workflow === 'order-shipped')
    expect(shipped).to.have.length(1)
    // Payload should carry only the mapped columns (ID + quantity + bookId alias).
    expect(shipped[0].payload).to.have.property('ID', order.ID)
    expect(shipped[0].payload).to.have.property('quantity', 3)
    // Alias applied.
    expect(shipped[0].payload).to.have.property('bookId')
  })
})
