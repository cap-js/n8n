'use strict'

const cds = require('@sap/cds')

/**
 * Example programmatic usage of the N8nService.
 * Uncomment and adapt as needed — this file exists mainly to demonstrate the
 * intended integration points for developers exploring the sample.
 */
module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const n8n = await cds.connect.to('N8nService')

    // Example: emit a custom event on the outboxed n8n service.
    // this.after('CREATE', 'Orders', async (order) => {
    //   await n8n.emit('trigger', {
    //     workflow: 'custom-order-webhook',
    //     payload: { orderId: order.ID, quantity: order.quantity }
    //   })
    // })

    // Suppress unused variable warning while the samples remain commented out.
    void n8n

    return super.init()
  }
}
