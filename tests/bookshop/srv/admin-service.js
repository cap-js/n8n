"use strict"

const cds = require("@sap/cds")

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { Books } = this.entities

    /**
     * Generate IDs for new Books drafts.
     */
    this.before("NEW", Books.drafts, async (req) => {
      if (req.data.ID) return
      const { ID: id1 } = await SELECT.one.from(Books).columns("max(ID) as ID")
      const { ID: id2 } = await SELECT.one.from(Books.drafts).columns("max(ID) as ID")
      req.data.ID = Math.max(id1 || 0, id2 || 0) + 1
    })

    // Warm the outbox-backed n8n connection so the plugin can register
    // its handlers. Also serves as an example integration point for programmatic
    // triggering - see README.md for details.
    const n8n = await cds.connect.to("n8n")
    void n8n

    return super.init()
  }
}
