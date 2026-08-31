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
const { exchangeUserToken, USER_ASSERTION_HEADER } = require("../lib/auth/token-exchange")
const {
  resolveAgentGatewayCredentials,
  hasAgentGatewayCredentials,
} = require("../lib/auth/agent-gateway-credentials")

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

  async _trigger(req) {
    // SAP-managed n8n: when the Agent Gateway business connector is configured,
    // every invocation is gated behind the gateway. Branch to the IAS assertion
    // path instead of calling the n8n webhook directly.
    if (hasAgentGatewayCredentials()) {
      return this._triggerViaGateway(req)
    }
    return this._triggerViaWebhook(req)
  }

  async _triggerViaWebhook(req) {
    const useTestWebhook = Boolean(cds.env.requires?.n8n?.useTestWebhook)
    const { path, payload, method = "POST" } = req.data ?? {}
    const prefix = useTestWebhook ? "/webhook-test" : "/webhook"
    const webhookPath = `${prefix}/${String(path).replace(/^\/+/, "")}`

    LOG.info("Triggering n8n webhook", { path: webhookPath })
    const bodyless = method === "GET" || method === "HEAD"
    const response = await n8nWebhookRequest({
      method,
      path: webhookPath,
      ...(bodyless || payload === undefined ? {} : { body: payload }),
    })
    return parseResponse(req, response)
  }

  /**
   * SAP-managed n8n adapter path. Every workflow invocation is gated behind the
   * SAP Agent Gateway. This implements the first gate — the IAS JWT-bearer
   * assertion; the Agent Gateway invocation itself is still a stub.
   */
  async _triggerViaGateway(req) {
    const { path, payload, method = "POST" } = req.data ?? {}

    const userJwt = readAssertionHeader(req)
    const { token, expiresIn } = await exchangeUserToken(userJwt)
    LOG.info("Agent Gateway assertion succeeded", { path, method, expiresIn })

    // TODO: invoke the workflow behind the gateway with the exchanged token:
    //   POST {gatewayUrl}/v1/mcp/{ordId}/{globalTenantId}, Authorization: Bearer <token>
    const { gatewayUrl, ordId, globalTenantId } = resolveAgentGatewayCredentials()
    LOG.warn(
      "Agent Gateway invocation is not yet implemented; the assertion token was obtained but not used.",
      { gatewayUrl, ordId, globalTenantId },
    )

    return { asserted: true, assertedToken: Boolean(token), payload: payload ?? {} }
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
