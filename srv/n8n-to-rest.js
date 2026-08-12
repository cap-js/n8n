const cds = require("@sap/cds")
const { createN8nClient, safeForLog } = require("../lib/api/n8n-client")
const { resolveN8nConnection } = require("../lib/api/connection")
const { parseResponse, getProperty } = require("../lib/handlers/utils")

const LOG = cds.log("n8n")

function n8nConfig() {
  const creds = cds.env.requires?.N8nService?.credentials ?? {}
  return {
    baseUrl: creds.url ?? process.env.N8N_BASE_URL,
    apiKey: creds.apiKey ?? process.env.N8N_API_KEY,
  }
}

class N8nService extends cds.Service {
  async init() {
    this.client = createN8nClient(() => resolveN8nConnection(this.name))

    const { WorkflowExecutions, WorkflowDefinitions } = this.entities

    this.before("trigger", (req) => {
      if (!req.data?.path) throw cds.error(400, "Missing required parameter path!")
    })

    this.on("trigger", async (req) => {
      const { path, payload } = req.data ?? {}
      LOG.info("Triggering n8n webhook", { path: safeForLog(path) })
      try {
        return await this.client.trigger(path, payload)
      } catch (err) {
        return handleTriggerError(path, err)
      }
    })

    this.on("READ", WorkflowExecutions, this._readExecutions)
    this.on("READ", WorkflowDefinitions, this._readWorkflows)

    return super.init()
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
      method: "GET", headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey
      }
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
      method: "GET", headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": apiKey
      }
    })
    return parseResponse(req, response)
  }
}

// See `@sap/cds/libx/queue/processing.js` — `err.unrecoverable === true`
// tells the outbox not to retry.
function handleTriggerError(path, err) {
  const p = safeForLog(path)
  if (err?.unrecoverable === true) {
    LOG.error(
      `n8n webhook for path ${p} rejected by n8n (no retry): ${safeForLog(err?.message ?? err)}`,
    )
    return { ok: false, status: err?.code ?? err?.status ?? 0, error: err?.message ?? String(err) }
  }
  LOG.error(`n8n webhook for path ${p} failed (will retry): ${safeForLog(err?.message ?? err)}`)
  throw err
}

module.exports = N8nService
