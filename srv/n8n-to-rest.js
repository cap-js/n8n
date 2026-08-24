const cds = require("@sap/cds")
const { parseResponse } = require("../lib/handlers/utils")

const {
  readWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  unpublishWorkflow,
  archiveWorkflow,
} = require("./n8n/workflows")

const {
  readExecutions,
  deleteExecution,
  retryExecution,
  stopExecution,
  stopExecutions,
} = require("./n8n/executions")
const { resolveN8nConnection, n8nRequest } = require("../lib/api/connection")

const LOG = cds.log("@cap-js/n8n")

class N8nService extends cds.ApplicationService {
  async init() {
    const { WorkflowExecutions, WorkflowDefinitions } = this.entities

    this.before("trigger", (req) => this.checkPathParam(req.data?.path))
    this.on("trigger", this._trigger)

    this.on("READ", WorkflowExecutions, readExecutions)
    this.on("DELETE", WorkflowExecutions, deleteExecution)
    this.on("retryExecution", retryExecution)
    this.on("stopExecution", stopExecution)
    this.on("stopExecutions", stopExecutions)

    this.on("READ", WorkflowDefinitions, readWorkflows)
    this.on("CREATE", WorkflowDefinitions, createWorkflow)
    this.on("UPDATE", WorkflowDefinitions, updateWorkflow)
    this.on("DELETE", WorkflowDefinitions, deleteWorkflow)
    this.on("publishWorkflow", publishWorkflow)
    this.on("unpublishWorkflow", unpublishWorkflow)
    this.on("archiveWorkflow", archiveWorkflow)

    return super.init()
  }

  checkPathParam(path) {
    const t = String(path).trim()
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) {
      throw cds.error(400, `path must be a relative path, not a URL: ${t}`)
    }
    if (/[\r\n]/.test(t)) {
      throw cds.error(400, "path must not contain newline characters")
    }
    if (t.split("/").some((s) => s === "..")) {
      throw cds.error(400, `path must not contain ".." segments`)
    }
  }

  async _trigger(req) {
    const { useTestWebhook } = await resolveN8nConnection()
    const { path, payload, method = "POST" } = req.data ?? {}
    const prefix = useTestWebhook ? "/webhook-test" : "/webhook"
    const webhookPath = `${prefix}/${String(path).replace(/^\/+/, "")}`

    LOG.info("Triggering n8n webhook", { path: webhookPath })
    const bodyless = method === "GET" || method === "HEAD"
    const response = await n8nRequest({
      method,
      path: webhookPath,
      ...(bodyless || payload === undefined ? {} : { body: payload }),
    })
    return parseResponse(req, response)
  }
}

module.exports = N8nService
