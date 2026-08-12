const cds = require("@sap/cds")
const { resolveN8nConnection } = require("../lib/api/connection")
const { parseResponse, getProperty } = require("../lib/handlers/utils")

const LOG = cds.log("n8n")

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

// Config source for the READ handlers. Trigger uses resolveN8nConnection so
// BTP destinations + useTestWebhook flag propagate; the reads stay on this
// lighter helper because they only need baseUrl + apiKey.
function n8nConfig() {
  const creds = cds.env.requires?.N8nService?.credentials ?? {}
  return {
    baseUrl: creds.url ?? process.env.N8N_BASE_URL,
    apiKey: creds.apiKey ?? process.env.N8N_API_KEY,
  }
}

class N8nService extends cds.Service {
  async init() {
    const { WorkflowExecutions, WorkflowDefinitions } = this.entities

    this.before("trigger", (req) => assertPathSafe(req.data?.path))
    this.on("trigger", this._trigger)
    this.on("READ", WorkflowExecutions, this._readExecutions)
    this.on("READ", WorkflowDefinitions, this._readWorkflows)

    return super.init()
  }

  async _trigger(req) {
    const { baseUrl, apiKey, useTestWebhook } = await resolveN8nConnection()
    const { path, payload } = req.data ?? {}
    const prefix = useTestWebhook ? "/webhook-test" : "/webhook"
    const url = `${baseUrl}${prefix}/${String(path).replace(/^\/+/, "")}`

    LOG.info("Triggering n8n webhook", { url })
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      body: JSON.stringify(payload ?? {}),
    })
    return parseResponse(req, response)
  }

  async _readExecutions(req) {
    const { baseUrl, apiKey } = n8nConfig()
    const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
    const id = getProperty(where, "id")

    let url = `${baseUrl}/api/v1/executions`
    if (id) {
      url += `/${encodeURIComponent(id)}?includeData=true`
    } else {
      const params = new URLSearchParams()
      const workflowId = getProperty(where, "workflowId")
      const status = getProperty(where, "status")
      if (workflowId) params.set("workflowId", workflowId)
      if (status) params.set("status", status)
      if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
    })
    return parseResponse(req, response)
  }

  async _readWorkflows(req) {
    const { baseUrl, apiKey } = n8nConfig()
    const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
    const id = getProperty(where, "id")

    let url = `${baseUrl}/api/v1/workflows`
    if (id) {
      url += `/${encodeURIComponent(id)}`
    } else {
      const params = new URLSearchParams()
      const active = getProperty(where, "active")
      const name = getProperty(where, "name")
      if (active != null) params.set("active", String(active))
      if (name) params.set("name", name)
      if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
    })
    return parseResponse(req, response)
  }
}

module.exports = N8nService
// Exported for unit tests only.
module.exports._internals = { assertPathSafe, n8nConfig }
