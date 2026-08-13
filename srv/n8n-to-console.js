const cds = require("@sap/cds")
const { hasPayload } = require("../lib/handlers/utils")
const LOG = cds.log("n8n")

class ConsoleN8nService extends cds.ApplicationService {
  async init() {
    this.before("trigger", (req) => {
      if (!req.data?.path || req.data.path.trim() === "") {
        throw cds.error(400, "Missing required parameter path!")
      }
    })

    this.on("trigger", async (req) => {
      const { path, payload } = req.data ?? {}
      const method = hasPayload(payload) ? "POST" : "GET"

      const ID = cds.utils.uuid()
      const { WorkflowExecutions } = this.entities

      await INSERT.into(WorkflowExecutions).entries({
        id: ID,
        workflowId: path,
        finished: true,
        mode: "webhook",
        status: "success",
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        data: { payload },
      })

      LOG.info("Triggering n8n workflow", {
        method,
        webhookUrl: `/webhook/${path}`,
        executionId: ID,
        payload,
      })

      return { ok: true, status: 200, executionId: ID, body: { executionId: ID } }
    })

    return super.init()
  }
}

module.exports = ConsoleN8nService
