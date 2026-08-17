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
} = require("./n8n/executions")
const { resolveN8nConnection } = require("../lib/api/connection")

const LOG = cds.log("@cap-js/n8n")

// SSRF + log-injection defence on webhook path segments. Absolute URLs,
// protocol-relative paths, CR/LF, and `..` segments are refused.
function assertPathSafe(path) {
  if (!path || String(path).trim() === "") {
    throw cds.error(400, "Missing required parameter path!")
  }
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

class N8nService extends cds.Service {
  async init() {
    const { WorkflowExecutions, WorkflowDefinitions } = this.entities

    this.before("triggerWorkflow", (req) => assertPathSafe(req.data?.path))
    this.on("triggerWorkflow", this._trigger)

    this.on("READ", WorkflowExecutions, readExecutions)
    this.on("DELETE", WorkflowExecutions, deleteExecution)
    this.on("retryExecution", retryExecution)
    this.on("stopExecution", stopExecution)

    this.on("READ", WorkflowDefinitions, readWorkflows)
    this.on("CREATE", WorkflowDefinitions, createWorkflow)
    this.on("UPDATE", WorkflowDefinitions, updateWorkflow)
    this.on("DELETE", WorkflowDefinitions, deleteWorkflow)
    this.on("publishWorkflow", publishWorkflow)
    this.on("unpublishWorkflow", unpublishWorkflow)
    this.on("archiveWorkflow", archiveWorkflow)

    return super.init()
  }

  async _trigger(req) {
    const { baseUrl, apiKey, useTestWebhook, authHeaders } = await resolveN8nConnection()
    const { path, payload } = req.data ?? {}
    const prefix = useTestWebhook ? "/webhook-test" : "/webhook"
    const url = `${baseUrl}${prefix}/${String(path).replace(/^\/+/, "")}`

    // Always POST with a JSON body
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
        ...(authHeaders ?? {}),
      },
      body: JSON.stringify(payload ?? {}),
    }

    LOG.info("Triggering n8n webhook", { method: "POST", url })
    const response = await fetch(url, init)
    return parseResponse(req, response)
  }
}

module.exports = N8nService
