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
const { n8nWebhookRequest } = require("../lib/api/connection")
const { USER_ASSERTION_HEADER } = require("../lib/auth/token-exchange")

const LOG = cds.log("n8n")

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
      cds.error(400, `'path' must be a relative, not absolute: ${t}`)
    }
    if (/[\r\n]/.test(t)) {
      cds.error(400, "'path' must not contain newline characters")
    }
    if (t.split("/").some((s) => s === "..")) {
      cds.error(400, `'path' must not contain '..' segments`)
    }
  }

  /**
   * Triggers an n8n webhook. When the SAP Agent Gateway is configured
   * (SAP-managed n8n) the connection layer transparently proxies the call
   * through the gateway and performs the IAS JWT-bearer assertion — hence the
   * user's JWT is always forwarded via `userJwt`. It is read from the assertion
   * header because async outbox delivery has no live user context; the direct
   * (non-gateway) path simply ignores it.
   */
  async _trigger(req) {
    const useTestWebhook = Boolean(cds.env.requires?.n8n?.useTestWebhook)
    const { path, payload, method = "POST" } = req.data ?? {}
    const prefix = useTestWebhook ? "/webhook-test" : "/webhook"
    const webhookPath = `${prefix}/${String(path).replace(/^\/+/, "")}`

    LOG.info("Triggering n8n webhook", { path: webhookPath })
    const bodyless = method === "GET" || method === "HEAD"
    const response = await n8nWebhookRequest({
      method,
      path: webhookPath,
      userJwt: readAssertionHeader(req),
      ...(bodyless || payload === undefined ? {} : { body: payload }),
    })
    return parseResponse(req, response)
  }
}

// Header casing may be normalised depending on the transport.
function readAssertionHeader(req) {
  const headers = req.headers ?? {}
  if (headers[USER_ASSERTION_HEADER]) return headers[USER_ASSERTION_HEADER]
  const match = Object.keys(headers).find((k) => k.toLowerCase() === USER_ASSERTION_HEADER)
  return match ? headers[match] : undefined
}

module.exports = N8nService
