const cds = require("@sap/cds")
const { resolveDestination } = require("../auth/destination")

const LOG = cds.log("@cap-js/n8n")

// REVISIT: called after resolveN8nConnection which already returns the value of useTestWebhook, why do we need to return it again 
function resolveUseTestWebhook(cfg, destination) {
  const fromDest = destination?.originalProperties?.["URL.useTestWebhook"]
  if (fromDest !== undefined) return Boolean(fromDest)
  const fromCreds = cfg?.credentials?.useTestWebhook
  if (fromCreds !== undefined) return Boolean(fromCreds)
  if (process.env.N8N_USE_TEST_WEBHOOK !== undefined)
    return Boolean(process.env.N8N_USE_TEST_WEBHOOK)
  return false
}

/**
 * Builds HTTP headers to authenticate against an n8n Webhook node. Reads
 * `credentials.webhookAuth`, which mirrors the Authentication options on the
 * Webhook node itself:
 *
 *   { type: "basic",  username, password }   -> Authorization: Basic base64(u:p)
 *   { type: "header", name,     value    }   -> <name>: <value>
 *   { type: "bearer", token                } -> Authorization: Bearer <token>
 *
 * Returns `{}` when no `webhookAuth` is configured (unauthenticated webhook).
 * Public API auth (`X-N8N-API-KEY`) is intentionally separate: it protects
 * `/api/v1/...`, not webhooks.
 */
function resolveWebhookAuthHeaders(cfg) {
  const auth = cfg?.credentials?.webhookAuth
  if (!auth) return {}
  const type = String(auth.type).toLowerCase()
  switch (type) {
    case "basic": {
      const { username, password } = auth
      if (!username || !password) {
        cds.error({
          code: "INVALID_WEBHOOK_AUTH",
          message: "n8n: webhookAuth type 'basic' requires username and password",
        })
      }
      const encoded = Buffer.from(`${username}:${password}`).toString("base64")
      return { Authorization: `Basic ${encoded}` }
    }
    case "header": {
      const { name, value } = auth
      if (!name || !value) {
        cds.error({
          code: "INVALID_WEBHOOK_AUTH",
          message: "n8n: webhookAuth type 'header' requires name and value",
        })
      }
      return { [name]: value }
    }
    case "bearer": {
      const { token } = auth
      if (!token) {
        cds.error({
          code: "INVALID_WEBHOOK_AUTH",
          message: "n8n: webhookAuth type 'bearer' requires token",
        })
      }
      return { Authorization: `Bearer ${token}` }
    }
    default:
      cds.error({
        code: "INVALID_WEBHOOK_AUTH",
        message: `n8n: unsupported webhookAuth type '${auth.type}'. Expected 'basic', 'header', or 'bearer'.`,
      })
  }
}

/**
 * Resolves how to reach n8n. Returns
 *   { baseUrl, apiKey, useTestWebhook, authHeaders, webhookAuthHeaders }
 *
 * Precedence:
 *   1) BTP destination named in `credentials.destination` (or top-level
 *      `destination`). Wins outright — otherwise a leftover `credentials.url`
 *      would silently shadow a user-configured destination.
 *   2) Inline `credentials.{url, apiKey, webhookAuth}`. `apiKey` falls
 *      through to N8N_API_KEY so a URL in package.json plus a key in `.env`
 *      compose naturally.
 *   3) Env vars `N8N_BASE_URL` + `N8N_API_KEY`.
 *
 * Throws when nothing resolves.
 */
async function resolveN8nConnection() {
  const cfg = cds.env.requires?.n8n
  const creds = cfg.credentials ?? {}
  const webhookAuthHeaders = resolveWebhookAuthHeaders(cfg)

  // 1) Destination — highest priority.
  const destinationName = creds.destination ?? cfg.destination
  if (destinationName) {
    LOG.debug(`Resolving n8n connection via destination: ${destinationName}`)
    const destination = await resolveDestination(destinationName)
    if (!destination) {
      cds.error({
        code: "N8N_DESTINATION_NOT_FOUND",
        message: `n8n: destination not found: ${destinationName}`,
      })
    }
    const apiKey =
      creds.apiKey ||
      destination.originalProperties?.["URL.headers.X-N8N-API-KEY"] ||
      destination.originalProperties?.destinationConfiguration?.["URL.headers.X-N8N-API-KEY"] ||
      process.env.N8N_API_KEY
    return {
      baseUrl: destination.url,
      apiKey,
      useTestWebhook: resolveUseTestWebhook(cfg, destination),
      authHeaders: destination.authHeaders ?? {},
      webhookAuthHeaders,
    }
  }

  // 2) Inline credentials.
  if (creds.url) {
    LOG.debug(`Resolved n8n connection from credentials: ${creds.url}`)
    return {
      baseUrl: creds.url,
      apiKey: creds.apiKey ?? process.env.N8N_API_KEY,
      useTestWebhook: !!cfg?.credentials?.useTestWebhook,
      authHeaders: {},
      webhookAuthHeaders,
    }
  }

  // 3) Env vars.
  if (process.env.N8N_BASE_URL) {
    LOG.debug(`Resolved n8n connection from env vars: ${process.env.N8N_BASE_URL}`)
    return {
      baseUrl: process.env.N8N_BASE_URL,
      apiKey: process.env.N8N_API_KEY,
      useTestWebhook: resolveUseTestWebhook(cfg),
      authHeaders: {},
      webhookAuthHeaders,
    }
  }

  cds.error({
    code: "N8N_NO_CONNECTION_CONFIG",
    message:
      "n8n: no credentials, no destination, and N8N_BASE_URL is not set. " +
      "Provide a service key via `cds.requires.n8n.credentials`, " +
      "a bound user-provided service, a BTP destination, or the " +
      "N8N_BASE_URL / N8N_API_KEY environment variables.",
  })
}

// Consolidates the boilerplate around building requests against the n8n
// Public REST API: base URL, `X-N8N-API-KEY` header, optional destination
// auth headers (Bearer token from a Jupiter/IAS proxy in front of managed
// n8n), and JSON body serialisation. Used by every workflow / execution
// handler. Does NOT apply webhookAuth — that is per Webhook node, not per
// Public API endpoint.
async function n8nRequest({ method, path, body }) {
  const { baseUrl, apiKey, authHeaders } = await resolveN8nConnection()
  const init = {
    method,
    headers: {
      ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
      ...(authHeaders ?? {}),
    },
  }
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const url = `${baseUrl}${path}`
  LOG.debug("API Request against n8n Instance", { method, url })
  return fetch(url, init)
}

// Webhook counterpart to `n8nRequest`. Applies `webhookAuthHeaders` (from
// `credentials.webhookAuth`) and destination auth headers, but omits
// `X-N8N-API-KEY` since Webhook nodes have their own authentication config.
async function n8nWebhookRequest({ method, path, body }) {
  const { baseUrl, authHeaders, webhookAuthHeaders } = await resolveN8nConnection()
  const init = {
    method,
    headers: {
      ...(authHeaders ?? {}),
      ...(webhookAuthHeaders ?? {}),
    },
  }
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const url = `${baseUrl}${path}`
  LOG.debug("Webhook request against n8n instance", { method, url })
  return fetch(url, init)
}

module.exports = {
  resolveN8nConnection,
  resolveUseTestWebhook,
  resolveWebhookAuthHeaders,
  n8nRequest,
  n8nWebhookRequest,
}
