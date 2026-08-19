const cds = require("@sap/cds")
const { writeResult } = require("../lib/handlers/utils")
const { HTTP_METHODS, normalizeHttpMethod } = require("../lib/shared/http-methods")
const LOG = cds.log("@cap-js/n8n")

// REVISIT: could be replaced by a single CQL query with `WHERE nodes LIKE '%"path":"<value>"%'`
async function resolveWorkflowByWebhookPath(WorkflowDefinitions, webhookPath, method) {
  const workflows = await SELECT.from(WorkflowDefinitions).columns("id", "nodes")
  for (const wf of workflows ?? []) {
    const nodes = Array.isArray(wf.nodes) ? wf.nodes : []
    const hit = nodes.some(
      (n) =>
        n?.type === "n8n-nodes-base.webhook" &&
        n?.parameters?.path === webhookPath &&
        (normalizeHttpMethod(n?.parameters?.httpMethod) ?? "POST") === method,
    )
    if (hit) return wf
  }
  return undefined
}

class ConsoleN8nService extends cds.ApplicationService {
  async init() {
    const { WorkflowDefinitions, WorkflowExecutions } = this.entities

    this.before("triggerWorkflow", (req) => {
      if (!req.data?.path || req.data.path.trim() === "") {
        throw cds.error(400, "Missing required parameter path!")
      }
    })

    this.on("CREATE", WorkflowDefinitions, async (req, next) => {
      await next() // run generic CRUD → persists the row
      const id = req.data?.id
      return id ? writeResult([{ id }], 1) : writeResult([], 1)
    })

    // REVISIT: Normalize UPDATE/DELETE return shape across CDS versions
    //   CDS 9's db-service returns a plain number (row count)
    //   CDS 10 returns an array with `.affected`
    // Tests and consumers expect the array-with-`.affected` shape, so we run the query
    // explicitly against the underlying db here and rebuild the shape
    const _runOnDb = async (req) => {
      const db = await cds.connect.to("db")
      const res = await db.run(req.query)
      const affected =
        typeof res === "number"
          ? res
          : Array.isArray(res)
            ? (res.affected ?? res.length)
            : (res?.affected ?? 0)
      return writeResult([], affected)
    }
    this.on("UPDATE", WorkflowDefinitions, _runOnDb)
    this.on("DELETE", WorkflowDefinitions, _runOnDb)
    this.on("UPDATE", WorkflowExecutions, _runOnDb)
    this.on("DELETE", WorkflowExecutions, _runOnDb)

    this.on("triggerWorkflow", async (req) => {
      const { path, payload } = req.data ?? {}
      const method = req.data?.method === undefined ? "POST" : normalizeHttpMethod(req.data.method)
      if (!method) throw cds.error(400, `method must be one of ${HTTP_METHODS.join(", ")}`)

      // Resolve the workflow id by webhook path
      const workflow = await resolveWorkflowByWebhookPath(WorkflowDefinitions, path, method)
      if (!workflow) throw cds.error(404, `No webhook found for ${method} ${path}`)
      const workflowId = workflow?.id ?? path
      const waiting = workflow?.nodes?.some((node) => node?.type === "n8n-nodes-base.wait")

      await INSERT.into(WorkflowExecutions).entries({
        id: cds.utils.uuid(),
        workflowId,
        finished: !waiting,
        mode: "webhook",
        status: waiting ? "waiting" : "success",
        stoppedAt: waiting ? undefined : new Date().toISOString(),
        data: { payload },
      })

      LOG.info("Triggering n8n workflow", {
        method,
        webhookUrl: `/webhook/${path}`,
        payload,
      })

      return payload ?? {}
    })

    this.on(["publishWorkflow", "unpublishWorkflow", "archiveWorkflow"], this._patchWorkflow)

    this.on("retryExecution", async (req) => {
      const { id } = req.data ?? {}
      const original = await SELECT.one.from(WorkflowExecutions).where({ id })
      if (!original) {
        LOG.warn("retryExecution: no execution", id)
        return {}
      }
      const newId = cds.utils.uuid()
      await INSERT.into(WorkflowExecutions).entries({
        ...original,
        id: newId,
        mode: "retry",
        retryOf: original.id,
        status: "success",
        finished: true,
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
      })
      return SELECT.one.from(WorkflowExecutions).where({ id: newId })
    })

    this.on("stopExecution", async (req) => {
      const { id } = req.data ?? {}
      const existing = await SELECT.one.from(WorkflowExecutions).where({ id })
      if (!existing) {
        LOG.warn("stopExecution: no execution", id)
        return {}
      }
      await UPDATE(WorkflowExecutions, id).with({
        status: "canceled",
        finished: true,
        stoppedAt: new Date().toISOString(),
      })
      return SELECT.one.from(WorkflowExecutions).where({ id })
    })

    this.on("stopExecutions", async (req) => {
      const { workflowId, status } = req.data ?? {}
      const executions = await SELECT.from(WorkflowExecutions).where({ workflowId, status })
      if (executions.length === 0) return 0
      await UPDATE(WorkflowExecutions)
        .where({ id: executions.map((execution) => execution.id) })
        .with({
          status: "canceled",
          finished: true,
          stoppedAt: new Date().toISOString(),
        })
      return executions.length
    })

    return super.init()
  }

  async _patchWorkflow(req) {
    const { id, versionId, name, description } = req.data ?? {}
    const { WorkflowDefinitions } = this.entities
    const existing = await SELECT.one.from(WorkflowDefinitions).where({ id })
    if (!existing) {
      LOG.warn(`${req.event}: no workflow`, id)
      return {}
    }

    const statePatch = {
      publishWorkflow: { active: true },
      unpublishWorkflow: { active: false },
      archiveWorkflow: { active: false, isArchived: true },
    }[req.event]

    const fromReq = {}
    if (versionId) fromReq.versionId = versionId
    if (name) fromReq.name = name
    if (description) fromReq.description = description

    const merged = { ...fromReq, ...statePatch }

    await UPDATE(WorkflowDefinitions, id).with(merged)
    LOG.info(`Executed ${req.event} with`, merged)
    return SELECT.one.from(WorkflowDefinitions).where({ id })
  }
}

module.exports = ConsoleN8nService
