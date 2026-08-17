const cds = require("@sap/cds")
const LOG = cds.log("@cap-js/n8n")

class ConsoleN8nService extends cds.ApplicationService {
  async init() {
    const { WorkflowDefinitions, WorkflowExecutions } = this.entities

    this.before("triggerWorkflow", (req) => {
      if (!req.data?.path || req.data.path.trim() === "") {
        throw cds.error(400, "Missing required parameter path!")
      }
    })

    this.on("triggerWorkflow", async (req) => {
      const { path, payload } = req.data ?? {}

      await INSERT.into(WorkflowExecutions).entries({
        id: cds.utils.uuid(),
        workflowId: path,
        finished: true,
        mode: "webhook",
        status: "success",
        stoppedAt: new Date().toISOString(),
        data: { payload },
      })

      LOG.info("Triggering n8n workflow", {
        method: "POST",
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
