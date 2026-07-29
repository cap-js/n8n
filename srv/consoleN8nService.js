"use strict"

const cds = require("@sap/cds")
const { N8N_LOGGER_PREFIX } = require("../lib/constants")

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Opt-in log-only implementation of `N8nService`. Selected by:
 *
 *     "cds": { "requires": { "N8nService": { "kind": "console-n8n-service" } } }
 *
 * Useful for CI / offline development. Every `trigger` call logs the intended
 * webhook path and payload, then records an in-memory synthetic execution so
 * `getExecution` / `listExecutions` still return meaningful data during tests.
 */
class ConsoleN8nService extends cds.Service {
  async init() {
    /** @type {Array<{id:string,path:string,payload:unknown,startedAt:string,finishedAt:string,status:string}>} */
    this.executions = []
    this._counter = 0

    this.on("trigger", async (req) => {
      const { path, payload } = req.data ?? {}
      if (!path) {
        throw cds.error(400, "Missing required parameter: path")
      }

      this._counter += 1
      const id = `console-exec-${this._counter}`
      const now = new Date().toISOString()
      const record = {
        id,
        executionId: id,
        path,
        payload,
        startedAt: now,
        finishedAt: now,
        status: "success",
      }
      this.executions.push(record)

      LOG.info(`[console] would POST /webhook/${path} - payload: ${safeJson(payload)}`)

      return { ok: true, status: 200, executionId: id, body: { executionId: id } }
    })

    this.on("getExecution", async (req) => {
      const { executionId } = req.data ?? {}
      if (!executionId) {
        throw cds.error(400, "Missing required parameter: executionId")
      }
      const exec = this.executions.find((e) => e.id === executionId)
      if (!exec) {
        throw cds.error(404, `Execution not found: ${executionId}`)
      }
      return exec
    })

    this.on("listExecutions", async (req) => {
      const { workflowId } = req.data ?? {}
      if (!workflowId) {
        throw cds.error(400, "Missing required parameter: workflowId")
      }
      // Console implementation stores no separate n8n workflow ID; treat the
      // webhook path as the identifier for filtering purposes.
      return this.executions.filter((e) => e.path === workflowId)
    })

    return super.init()
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserialisable payload]"
  }
}

module.exports = ConsoleN8nService
