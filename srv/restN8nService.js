const cds = require("@sap/cds")
const { N8N_LOGGER_PREFIX } = require("../lib/constants")
const { createN8nClient, safeForLog } = require("../lib/api/n8n-client")
const { resolveN8nConnection } = require("../lib/api/connection")

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Rejects path values that could pivot the request off the resolved n8n
 * base URL. The path is re-normalised inside the client, but validating here
 * short-circuits misuse before touching the network.
 */
function assertRelativePath(path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw cds.error(400, "Missing required parameter: path")
  }
  const trimmed = path.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    throw cds.error(400, `path must be a relative path, not a URL: ${safeForLog(trimmed)}`)
  }
  if (/[\r\n]/.test(trimmed)) {
    throw cds.error(400, "path must not contain newline characters")
  }
}

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

    this.on("trigger", async (req) => {
      const { path, payload } = req.data ?? {}
      assertRelativePath(path)
      LOG.info(`Triggering n8n webhook path: ${safeForLog(path)}`)
      try {
        return await this.client.trigger(path, payload)
      } catch (err) {
        return handleTriggerError(path, err)
      }
    })

    this.on("getExecution", async (req) => {
      const { executionId } = req.data ?? {}
      if (!executionId) {
        throw cds.error(400, "Missing required parameter: executionId")
      }
      return this.client.getExecution(executionId)
    })

    this.on("listExecutions", async (req) => {
      const { workflowId } = req.data ?? {}
      if (!workflowId) {
        throw cds.error(400, "Missing required parameter: workflowId")
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
 * The CAP outbox uses `err.unrecoverable === true` as its terminal signal -
 * see `@sap/cds/libx/queue/processing.js`. HTTP 4xx/5xx failures mean n8n
 * received the call on its own terms; another attempt would produce the
 * same rejection and only waste the queue, so they are surfaced as a
 * resolved `{ ok:false }` result. Network errors, timeouts, and anything
 * else transport-layer is left to propagate - the outbox retries them with
 * backoff.
 */
function handleTriggerError(path, err) {
  const p = safeForLog(path)
  if (err?.unrecoverable === true) {
    LOG.error(
      `n8n webhook for path ${p} rejected by n8n (no retry): ${safeForLog(err?.message ?? err)}`,
    )
    // Return a synthetic "not ok" result so callers awaiting the emit see a
    // deterministic value instead of a swallowed rejection.
    return { ok: false, status: err?.code ?? err?.status ?? 0, error: err?.message ?? String(err) }
  }
  LOG.error(`n8n webhook for path ${p} failed (will retry): ${safeForLog(err?.message ?? err)}`)
  throw err
}

module.exports = N8nService
