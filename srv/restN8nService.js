'use strict'

const cds = require('@sap/cds')
const { N8N_LOGGER_PREFIX } = require('../lib/constants')
const { createN8nClient } = require('../lib/api/n8n-client')
const { resolveN8nConnection } = require('../lib/api/connection')

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * REST implementation of `N8nService`.
 *
 * Handlers registered here run for both:
 *   - Direct calls  (`n8n.emit('trigger', …)` / `n8n.send('…')`)
 *   - Outbox replays (persistent outbox delivers via `service.handle(msg)`,
 *     which flows through registered `on()` handlers)
 *
 * The service is registered with `outbox: true` in package.json, so the
 * connect proxy returned by `cds.connect.to('N8nService')` persists emitted
 * events transactionally and dispatches them after commit.
 */
class N8nService extends cds.Service {
  async init() {
    this.client = createN8nClient(() => resolveN8nConnection(this.name))

    this.on('trigger', async (req) => {
      const { workflow, payload } = req.data ?? {}
      if (!workflow) {
        throw cds.error(400, 'Missing required parameter: workflow')
      }
      LOG.info(`Triggering n8n workflow: ${workflow}`)
      try {
        return await this.client.trigger(workflow, payload)
      } catch (err) {
        LOG.error(`Failed to trigger n8n workflow ${workflow}:`, err.message ?? err)
        throw err
      }
    })

    this.on('getExecution', async (req) => {
      const { executionId } = req.data ?? {}
      if (!executionId) {
        throw cds.error(400, 'Missing required parameter: executionId')
      }
      return this.client.getExecution(executionId)
    })

    this.on('listExecutions', async (req) => {
      const { workflowId } = req.data ?? {}
      if (!workflowId) {
        throw cds.error(400, 'Missing required parameter: workflowId')
      }
      return this.client.listExecutions(workflowId)
    })

    return super.init()
  }
}

module.exports = N8nService
