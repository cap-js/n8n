const cds = require("@sap/cds")
const destination = require("./destination")
const { exchangeUserToken } = require("../auth/token-exchange")
const {
  resolveAgentGatewayCredentials,
  hasAgentGatewayCredentials,
} = require("../auth/agent-gateway-credentials")

const LOG = cds.log("n8n")

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
 */
function resolveWebhookAuthHeaders() {
  const credentials = cds.env.requires?.n8n?.credentials
  const auth = credentials?.webhookAuth
  if (!auth) {
    LOG.debug(
      `No webhook credentials via 'webhookAuth' configured. Proceed with unauthenticated webhook request.`,
    )
    return {}
  }
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
 * Resolves connection details for the n8n instance
 * BTP destination has higher priority
 * @returns { baseUrl, apiKey, authHeaders, webhookAuthHeaders }
 */
async function resolveN8nConnection() {
  const creds = cds.env.requires?.n8n?.credentials
  const webhookAuthHeaders = resolveWebhookAuthHeaders()

  // 1) Destination (highest priority)
  if (creds?.destination) {
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
      authHeaders: resolved.authHeaders ?? {},
      webhookAuthHeaders,
    }
  }

  // 2) Resolve service credentials
  if (creds?.url) {
    LOG.debug(`Resolved n8n connection from service credentials: ${creds.url}`)
    return {
      baseUrl: creds.url,
      apiKey: creds.apiKey,
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

/**
 * Extracts the authenticated user's JWT from the ambient request context. Used
 * for synchronous calls (Workflows/Executions handlers) where the request runs
 * under a live user. Prefers the token parsed by the @sap/xssec ias/jwt
 * strategies; falls back to the raw `Authorization: Bearer <jwt>` header (handy
 * for local testing).
 *
 * Note: this cannot recover the user JWT during async outbox delivery (e.g. the
 * `trigger` event) — only `x-correlation-id` propagates through the outbox. In
 * that case the caller must forward the JWT explicitly (see `n8nWebhookRequest`
 * `userJwt`).
 * @returns {string | undefined}
 */
function resolveUserJwt() {
  const authorization = cds.context?.http?.req?.headers?.authorization
  return (
    cds.context?.user?.authInfo?.token?.jwt ??
    (typeof authorization === "string" && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, "").trim()
      : undefined)
  )
}

/**
 * Builds the SAP Agent Gateway (AGW) proxy URL. The gateway forwards `*path`
 * verbatim to the target instance, so the n8n path is appended after the
 * `/api/{ordId}/{globalTenantId}` route prefix — e.g. `/api/v1/workflows`
 * becomes `.../api/{ordId}/{globalTenantId}/api/v1/workflows`.
 */
function buildGatewayUrl(gatewayUrl, ordId, globalTenantId, path) {
  const base = String(gatewayUrl).replace(/\/+$/, "")
  const forwarded = String(path).replace(/^\/+/, "")
  return `${base}/api/${encodeURIComponent(ordId)}/${encodeURIComponent(globalTenantId)}/${forwarded}`
}

/**
 * Performs a request against the SAP Agent Gateway proxy for a SAP-managed n8n
 * instance. Exchanges the user's JWT for a gateway-scoped named-user token via
 * the IAS JWT-bearer grant and sends it as `Authorization: Bearer`.
 *
 * Instance-level auth headers (`X-N8N-API-KEY` for the REST API, `webhookAuth`
 * for webhooks) are passed through via `extraHeaders`. Caveat: the gateway
 * Bearer occupies the `Authorization` header, so `webhookAuth` of type
 * `basic`/`bearer` is overridden — only `X-N8N-API-KEY` and `header`-type
 * webhook auth reach the instance intact.
 *
 * @param {object} options
 * @param {string} options.method - HTTP method.
 * @param {string} options.path - n8n instance path, e.g. "/api/v1/workflows" or "/webhook/foo".
 * @param {*} [options.body] - Optional request payload (JSON-serialised for non-GET/HEAD).
 * @param {string} [options.userJwt] - User JWT to exchange. Falls back to the ambient context.
 * @param {object} [options.extraHeaders] - Instance-level auth headers to forward.
 * @returns {Promise<Response>} The raw `fetch` response.
 */
async function gatewayRequest({ method, path, body, userJwt, extraHeaders }) {
  const { gatewayUrl, ordId, globalTenantId } = resolveAgentGatewayCredentials()
  const missing = []
  if (!gatewayUrl) missing.push("gatewayUrl")
  if (!ordId) missing.push("ordId")
  if (!globalTenantId) missing.push("globalTenantId")
  if (missing.length > 0) {
    cds.error({
      code: "N8N_INVALID_AGENT_GATEWAY_CONFIG",
      message: `n8n: Agent Gateway invocation is missing required field(s): ${missing.join(", ")}.`,
    })
  }

  const jwt = userJwt ?? resolveUserJwt()
  const { token } = await exchangeUserToken(jwt)

  const init = {
    method,
    headers: {
      ...(extraHeaders ?? {}),
      Authorization: `Bearer ${token}`,
    },
  }
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const url = buildGatewayUrl(gatewayUrl, ordId, globalTenantId, path)
  LOG.debug("Request against n8n via Agent Gateway", { method, url })
  return fetch(url, init)
}

/**
 * Performs the request against n8n REST API with `X-N8N-API-KEY` header and JSON body serialisation.
 * Used by every Workflows and Executions handler. When the Agent Gateway is
 * configured (SAP-managed n8n), the request is transparently proxied through it.
 *
 * @param {object} options
 * @param {string} options.method - HTTP method, e.g. "GET", "POST", "PATCH", "DELETE"
 * @param {string} options.path - Path appended to the resolved base URL, e.g. "/api/v1/workflows".
 * @param {*} [options.body] - Optional request payload. Serialised as JSON for non-GET/HEAD methods.
 * @returns {Promise<Response>} The raw `fetch` response.
 */
async function n8nAPIRequest({ method, path, body }) {
  if (hasAgentGatewayCredentials()) {
    const apiKey = cds.env.requires?.n8n?.credentials?.apiKey
    const extraHeaders = apiKey ? { "X-N8N-API-KEY": apiKey } : {}
    return gatewayRequest({ method, path, body, extraHeaders })
  }

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

/**
 * Performs the request against a webhook URL and applies `webhookAuthHeaders`.
 * Used by the trigger action handler. When the Agent Gateway is configured
 * (SAP-managed n8n), the request is transparently proxied through it; the
 * `userJwt` must then be supplied by the caller because async outbox delivery
 * has no live user context.
 *
 * @param {object} options
 * @param {string} options.method - HTTP method, e.g. "GET", "POST"
 * @param {string} options.path - Path appended to the resolved base URL, e.g. "/webhook/my-hook"
 * @param {*} [options.body] - Optional request payload. Serialised as JSON for non-GET/HEAD methods.
 * @param {string} [options.userJwt] - User JWT forwarded for the Agent Gateway assertion.
 * @returns {Promise<Response>} The raw `fetch` response.
 */
async function n8nWebhookRequest({ method, path, body, userJwt }) {
  if (hasAgentGatewayCredentials()) {
    const extraHeaders = resolveWebhookAuthHeaders()
    return gatewayRequest({ method, path, body, userJwt, extraHeaders })
  }

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
  resolveUserJwt,
  n8nAPIRequest,
  n8nWebhookRequest,
  gatewayRequest,
  buildGatewayUrl,
}
