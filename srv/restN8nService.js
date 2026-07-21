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
 * The service is registered with `outboxed: { kind: 'persistent-queue' }` in
 * package.json, so the connect proxy returned by `cds.connect.to('N8nService')`
 * persists emitted events transactionally in the CAP outbox table and
 * dispatches them after commit. Failed deliveries are retried by the outbox
 * with backoff.
 */
class N8nService extends cds.Service {
  async init() {
    // `client` is exposed as an instance field so tests can swap in a stub.
    // Runtime consumers should never reach past `this.on(...)`.
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
        return handleTriggerError(workflow, err)
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

/**
 * Decides whether an error from the n8n client should propagate (so the CAP
 * outbox schedules a retry) or be swallowed (so the message is marked done).
 *
 * Non-retryable failures (HTTP 4xx/5xx) mean n8n rejected the call on its own
 * terms; another attempt would produce the same rejection and only waste the
 * queue. Retryable failures (network errors, timeouts) mean n8n never got a
 * chance to see the request, and are worth retrying with backoff.
 */
function handleTriggerError(workflow, err) {
  const retryable = err?.retryable !== false
  if (retryable) {
    LOG.error(
      `n8n webhook for workflow ${workflow} failed (will retry): ${err?.message ?? err}`,
    )
    throw err
  }
  LOG.error(
    `n8n webhook for workflow ${workflow} rejected by n8n (no retry): ${err?.message ?? err}`,
  )
  // Return a synthetic "not ok" result so callers awaiting the emit see a
  // deterministic value instead of a swallowed rejection.
  return { ok: false, status: err?.code ?? err?.status ?? 0, error: err?.message ?? String(err) }
}

module.exports = N8nService
