"use strict"

const cds = require("@sap/cds")
const {
  N8N_LOGGER_PREFIX,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  WEBHOOK_PATH_PREFIX,
  WEBHOOK_TEST_PATH_PREFIX,
} = require("../constants")
const { buildWebhookHeaders, buildApiHeaders } = require("./connection")

const LOG = cds.log(N8N_LOGGER_PREFIX)

const API_BASE = "/api/v1"

/**
 * Node's `fetch` does not distinguish connect from read; we surface both keys
 * in configuration but apply their sum as a single abort deadline. When no
 * timeout is provided, the built-in defaults kick in - matching the Java
 * plugin's connect/read pair.
 */
function totalTimeoutMs(timeout) {
  const connect = timeout?.connect ?? DEFAULT_CONNECT_TIMEOUT_MS
  const read = timeout?.read ?? DEFAULT_READ_TIMEOUT_MS
  return connect + read
}

async function fetchWithTimeout(url, options, timeout) {
  const ms = totalTimeoutMs(timeout)
  // AbortSignal.timeout throws a DOMException with name 'TimeoutError' when
  // the deadline elapses; callers can key off that name to decide retryability.
  const signal = AbortSignal.timeout(ms)
  // Everything thrown from fetch itself is a transport-layer failure:
  // DNS misses, connection refused, socket errors, timeouts. All are worth
  // retrying because they generally mean n8n was unreachable rather than
  // that the request itself was rejected on business grounds. We let those
  // errors propagate untagged - the CAP outbox retries all thrown errors
  // unless `err.unrecoverable === true`.
  return await fetch(url, { ...options, signal })
}

/**
 * Marks an error as terminal for the CAP outbox: `err.unrecoverable = true`
 * tells the persistent-queue dispatcher not to reschedule. Returns the same
 * reference for chaining. See `@sap/cds/libx/queue/processing.js`.
 */
function markUnrecoverable(err) {
  if (err && typeof err === "object" && !("unrecoverable" in err)) {
    try {
      err.unrecoverable = true
    } catch {
      // Some frozen/native errors can't be mutated; ignore silently.
    }
  }
  return err
}

/**
 * Validates and normalises a webhook path value into a webhook path fragment.
 *   'my-hook'          → 'my-hook'
 *   '/webhook/my-hook' → 'my-hook'
 *   'webhook-test/foo' → 'webhook-test/foo'   (n8n test URL prefix)
 *
 * Rejects any value that could pivot the request off the resolved n8n
 * `baseUrl` (SSRF hardening): absolute URLs, protocol-relative paths,
 * `..` segments, and CR/LF sequences are refused with a 400 error.
 */
function normalizeWebhookPath(path) {
  if (!path) return ""
  const trimmed = String(path).trim()

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    throw new cds.error(400, `n8n: path must be a relative path, not a URL: ${safeForLog(trimmed)}`)
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new cds.error(400, "n8n: path must not contain newline characters")
  }
  const stripped = trimmed.replace(/^\/+/, "").replace(/^webhook\//, "")
  if (stripped.split("/").some((seg) => seg === "..")) {
    throw new cds.error(400, `n8n: path must not contain ".." segments: ${safeForLog(trimmed)}`)
  }
  return stripped
}

/**
 * Picks the `/webhook` or `/webhook-test` prefix based on the resolved
 * configuration flag. Values starting with `webhook-test/` are treated as
 * n8n test URL paths and preserved by `normalizeWebhookPath`.
 */
function buildWebhookUrl(baseUrl, path, options) {
  const normalized = normalizeWebhookPath(path)
  const prefix = options?.useTestWebhook ? WEBHOOK_TEST_PATH_PREFIX : WEBHOOK_PATH_PREFIX
  return `${trimTrailingSlash(baseUrl)}${prefix}/${normalized}`
}

/**
 * Strips CR/LF/tab and truncates the input so it is safe to interpolate into
 * a log line without enabling log injection.
 */
function safeForLog(value, limit = 256) {
  if (value === undefined || value === null) return ""
  return String(value)
    .replace(/[\r\n\t]/g, " ")
    .slice(0, limit)
}

/**
 * Redacts sensitive header values that may be echoed back in an n8n response
 * body before we include that body in a thrown error message. Handles both
 * plain header shape (`Authorization: Bearer …`) and JSON shape
 * (`{"X-N8N-API-KEY":"…"}`).
 */
const SENSITIVE_HEADERS = ["x-n8n-api-key", "x-webhook-secret", "authorization"]
function redactSecrets(bodyText) {
  if (!bodyText) return ""
  const names = SENSITIVE_HEADERS.join("|")
  const re = new RegExp(`("?)(${names})\\1(\\s*[:=]\\s*)"?[^"\\r\\n,}]+"?`, "gi")
  return String(bodyText).replace(re, (_m, q, name, sep) => `${q}${name}${q}${sep}[REDACTED]`)
}

function trimTrailingSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

/**
 * Firing an n8n production webhook.
 * Returns { ok, status, executionId?, body }.
 *
 * Header layering (outer → inner):
 *   1. `authHeaders` - e.g. `Authorization: Bearer …` from a BTP destination,
 *      needed by any IAS/Jupiter/managed-service proxy in front of n8n.
 *   2. `X-N8N-API-KEY` + `X-Webhook-Secret` - the n8n instance's own auth so
 *      workflows written for either sister plugin authenticate identically.
 */
async function trigger(baseUrl, apiKey, path, payload, timeout, options) {
  const url = buildWebhookUrl(baseUrl, path, options)
  LOG.debug(`POST ${safeForLog(url)}`)

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.authHeaders ?? {}),
        ...buildWebhookHeaders(apiKey),
      },
      body: JSON.stringify(payload ?? {}),
    },
    timeout,
  )

  const bodyText = await res.text()
  let body
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    body = bodyText
  }

  if (!res.ok) {
    const safeBody = redactSecrets(bodyText).slice(0, 500)
    const msg = `n8n webhook call to ${safeForLog(url)} failed: ${res.status} ${res.statusText || ""}${safeBody ? ` – ${safeBody}` : ""}`
    // HTTP status errors mean n8n *received* the call but the workflow (or
    // routing) rejected it. Retrying will not fix a workflow bug or a bad
    // secret, so flag as unrecoverable to keep the outbox queue clean.
    // `cds.error(...)` throws directly; `new cds.error(...)` returns the
    // error object so we can decorate it before rethrowing.
    throw markUnrecoverable(new cds.error(res.status, msg))
  }

  return {
    ok: true,
    status: res.status,
    executionId: extractExecutionId(body),
    body,
  }
}

function extractExecutionId(body) {
  if (!body || typeof body !== "object") return undefined
  return body.executionId ?? body.id ?? undefined
}

/**
 * GET /api/v1/executions/{id}?includeData=true
 *
 * Uses the executions-API header set (only `X-N8N-API-KEY`) because n8n's
 * public REST API validates that specific name. Any outer proxy auth is
 * layered on via `authHeaders`.
 */
async function getExecution(baseUrl, apiKey, executionId, timeout, options) {
  const url = `${trimTrailingSlash(baseUrl)}${API_BASE}/executions/${encodeURIComponent(executionId)}?includeData=true`
  LOG.debug(`GET ${safeForLog(url)}`)

  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { ...(options?.authHeaders ?? {}), ...buildApiHeaders(apiKey) },
    },
    timeout,
  )
  if (!res.ok) {
    const body = redactSecrets(await res.text().catch(() => "")).slice(0, 500)
    throw markUnrecoverable(
      new cds.error(
        res.status,
        `Failed to fetch execution ${safeForLog(executionId)}: ${res.status} ${res.statusText || ""}${body ? ` – ${body}` : ""}`,
      ),
    )
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

/**
 * GET /api/v1/executions?workflowId={id}&includeData=true
 * Returns the `data` array from n8n's paged response.
 */
async function listExecutions(baseUrl, apiKey, workflowId, timeout, options) {
  const url = `${trimTrailingSlash(baseUrl)}${API_BASE}/executions?workflowId=${encodeURIComponent(workflowId)}&includeData=true`
  LOG.debug(`GET ${safeForLog(url)}`)

  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { ...(options?.authHeaders ?? {}), ...buildApiHeaders(apiKey) },
    },
    timeout,
  )
  if (!res.ok) {
    const body = redactSecrets(await res.text().catch(() => "")).slice(0, 500)
    throw markUnrecoverable(
      new cds.error(
        res.status,
        `Failed to list executions for workflow ${safeForLog(workflowId)}: ${res.status} ${res.statusText || ""}${body ? ` – ${body}` : ""}`,
      ),
    )
  }
  const text = await res.text()
  if (!text) return []
  const parsed = JSON.parse(text)
  // n8n returns `{ data: [...], nextCursor: … }` - surface just the array to callers.
  return Array.isArray(parsed) ? parsed : (parsed?.data ?? [])
}

/**
 * Factory returning a bound client. The client caches nothing; each call
 * consults the passed-in connection resolver (async), so token/destination
 * refreshes propagate naturally.
 */
function createN8nClient(resolveConnection) {
  return {
    async trigger(path, payload) {
      const { baseUrl, apiKey, timeout, useTestWebhook, authHeaders } = await resolveConnection()
      return trigger(baseUrl, apiKey, path, payload, timeout, { useTestWebhook, authHeaders })
    },
    async getExecution(executionId) {
      const { baseUrl, apiKey, timeout, authHeaders } = await resolveConnection()
      return getExecution(baseUrl, apiKey, executionId, timeout, { authHeaders })
    },
    async listExecutions(workflowId) {
      const { baseUrl, apiKey, timeout, authHeaders } = await resolveConnection()
      return listExecutions(baseUrl, apiKey, workflowId, timeout, { authHeaders })
    },
  }
}

module.exports = {
  trigger,
  getExecution,
  listExecutions,
  createN8nClient,
  normalizeWebhookPath,
  buildWebhookUrl,
  markUnrecoverable,
  safeForLog,
  redactSecrets,
}
