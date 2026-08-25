const cds = require("@sap/cds")
const destination = require("../auth/destination")

const LOG = cds.log("@cap-js/n8n")

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
 * Configuration always flows through `cds.env.requires.n8n.credentials`,
 * which CAP populates from package.json, .cdsrc-private.json, bound
 * services (VCAP_SERVICES), or `cds_requires_n8n_credentials_*` env vars.
 *
 * Precedence within that config:
 *   1) `credentials.destination` — BTP destination wins outright, so a
 *      leftover `credentials.url` cannot silently shadow it.
 *   2) `credentials.{url, apiKey, useTestWebhook, webhookAuth}`.
 *
 * Throws when neither is set.
 */
async function resolveN8nConnection() {
  const cfg = cds.env.requires?.n8n
  const creds = cfg?.credentials ?? {}
  const webhookAuthHeaders = resolveWebhookAuthHeaders(cfg)

  // 1) Destination (highest priority)
  if (creds.destination) {
    LOG.debug(`Resolving n8n connection via destination: ${creds.destination}`)
    const resolved = await destination.resolveDestination(creds.destination)
    if (!resolved) {
      cds.error({
        code: "N8N_DESTINATION_NOT_FOUND",
        message: `n8n: destination not found: ${creds.destination}`,
      })
    }

    return {
      baseUrl: resolved.url,
      apiKey: resolved.originalProperties?.["URL.headers.X-N8N-API-KEY"] || creds.apiKey,
      useTestWebhook: Boolean(creds.useTestWebhook),
      authHeaders: resolved.authHeaders ?? {},
      webhookAuthHeaders,
    }
  }

  // 2) Resolve service credentials
  if (creds.url) {
    LOG.debug(`Resolved n8n connection from service credentials: ${creds.url}`)
    return {
      baseUrl: creds.url,
      apiKey: creds.apiKey,
      useTestWebhook: Boolean(creds.useTestWebhook),
      authHeaders: {},
      webhookAuthHeaders,
    }
  }

  cds.error({
    code: "N8N_NO_CONNECTION_CONFIG",
    message:
      "n8n: no connection configured. Set `cds.requires.n8n.credentials.url` " +
      "or `.destination` in package.json, .cdsrc-private.json, via a bound " +
      "service, or through `cds_requires_n8n_credentials_*` environment variables.",
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
  resolveWebhookAuthHeaders,
  n8nRequest,
  n8nWebhookRequest,
}
