"use strict"

const cds = require("@sap/cds")
const {
  N8N_LOGGER_PREFIX,
  N8N_SERVICE,
  DEV_DEFAULT_BASE_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
} = require("../constants")
const { resolveDestination } = require("../auth/destination")

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Reads the current n8n service configuration from `cds.env.requires.<service>`.
 * CAP has already merged the active profile at this point, so no manual
 * profile handling is needed.
 */
function getConfig(serviceName = N8N_SERVICE) {
  return cds.env.requires?.[serviceName] ?? {}
}

/**
 * Resolves `env:VAR_NAME` indirection. Plain values pass through unchanged.
 * Empty/whitespace-only values resolve to undefined.
 */
function resolveEnvRef(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return value
  if (value.startsWith("env:")) {
    const resolved = process.env[value.slice("env:".length)]
    return resolved && resolved.trim() ? resolved : undefined
  }
  return value.trim() ? value : undefined
}

function buildHeaders(apiKey) {
  return apiKey ? { "X-N8N-API-KEY": apiKey } : {}
}

/**
 * Headers for n8n *webhook* calls (i.e. `/webhook/…` POSTs). Sends the api
 * key under two names to interoperate with workflows written for either the
 * Java plugin (`X-Webhook-Secret`) or the Node plugin's historical
 * convention (`X-N8N-API-KEY`). n8n itself doesn't mandate a header name
 * for webhook auth - workflows validate whatever they choose - so sending
 * both is safe.
 */
function buildWebhookHeaders(apiKey) {
  if (!apiKey) return {}
  return {
    "X-N8N-API-KEY": apiKey,
    "X-Webhook-Secret": apiKey,
  }
}

/**
 * Headers for n8n's public REST API (`/api/v1/…`). The executions endpoints
 * expect `X-N8N-API-KEY` specifically and reject unknown auth headers on
 * some deployments, so we send only the canonical header here.
 */
function buildApiHeaders(apiKey) {
  return apiKey ? { "X-N8N-API-KEY": apiKey } : {}
}

/**
 * Coerces a value into a positive integer number of milliseconds, or returns
 * `undefined` when the value cannot be interpreted. Accepts numbers and numeric
 * strings (e.g. env var values).
 */
function toPositiveInt(value) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * Coerces a value into a boolean. Accepts booleans, and the strings
 * `'true' | 'false' | '1' | '0'` (case-insensitive). Returns `undefined`
 * for anything else so precedence chains can fall through cleanly.
 */
function toBool(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (v === "true" || v === "1") return true
    if (v === "false" || v === "0") return false
  }
  return undefined
}

/**
 * Resolves whether webhook calls should hit n8n's `/webhook-test/…` prefix
 * instead of `/webhook/…`. Precedence:
 *   1) `credentials.useTestWebhook` (accepts `env:VAR` refs, bool or string)
 *   2) Env var `N8N_USE_TEST_WEBHOOK`
 *   3) Destination property `URL.useTestWebhook` (when applicable)
 *   4) `false` (production webhooks)
 *
 * The test prefix is a one-shot capture endpoint in n8n: workflows must be
 * armed via the "Listen for Test Event" button in the UI before each call.
 * It is unsuitable for bulk operations - surface this in docs.
 */
function resolveUseTestWebhook(cfg, destination) {
  const creds = cfg?.credentials ?? {}
  return (
    toBool(resolveEnvRef(creds.useTestWebhook)) ??
    toBool(process.env.N8N_USE_TEST_WEBHOOK) ??
    toBool(destination?.originalProperties?.["URL.useTestWebhook"]) ??
    false
  )
}

/**
 * Resolves the HTTP timeouts for calls to n8n. Precedence (per timeout):
 *   1) `credentials.timeout.{connect,read}` (accepts `env:VAR` refs)
 *   2) Env vars N8N_CONNECT_TIMEOUT_MS / N8N_READ_TIMEOUT_MS
 *   3) Built-in defaults (3000 / 5000)
 *
 * Node's `fetch` implementation doesn't split connect from read at the API
 * level - we surface both keys so users can express intent and configure
 * per-phase timeouts in the future, but the client currently applies a single
 * abort at `connect + read` ms.
 */
function resolveTimeouts(cfg) {
  const creds = cfg?.credentials ?? {}
  const t = creds.timeout ?? {}

  const connect =
    toPositiveInt(resolveEnvRef(t.connect)) ??
    toPositiveInt(process.env.N8N_CONNECT_TIMEOUT_MS) ??
    DEFAULT_CONNECT_TIMEOUT_MS
  const read =
    toPositiveInt(resolveEnvRef(t.read)) ??
    toPositiveInt(process.env.N8N_READ_TIMEOUT_MS) ??
    DEFAULT_READ_TIMEOUT_MS

  return { connect, read }
}

/**
 * Resolves how to reach n8n. Precedence:
 *
 *   1) BTP destination named in `credentials.destination` or the top-level
 *      `destination` field. When set, this always wins - otherwise the
 *      plugin's own `[development]` default `baseUrl` would silently
 *      shadow a user-configured destination in hybrid runs.
 *   2) Bound / inline `credentials.{baseUrl,apiKey}` - supports `env:VAR` refs.
 *      Also honours `url` as an alias for `baseUrl` (destination shape).
 *   3) Environment variables `N8N_BASE_URL` + `N8N_API_KEY`.
 *   4) Dev default `http://localhost:5678` - only in the `development` profile.
 *
 * Throws when nothing resolves (any non-development profile).
 */
async function resolveN8nConnection(serviceName = N8N_SERVICE) {
  const cfg = getConfig(serviceName)
  const timeout = resolveTimeouts(cfg)
  const creds = cfg.credentials ?? {}

  // 1) BTP destination - highest priority so a hybrid run doesn't fall back
  //    to the plugin's built-in `[development]` `baseUrl`.
  const destinationName = creds.destination ?? cfg.destination
  if (destinationName) {
    LOG.debug(`Resolving n8n connection via destination: ${destinationName}`)
    const destination = await resolveDestination(destinationName)
    if (!destination) {
      throw new Error(`n8n: destination not found: ${destinationName}`)
    }
    const apiKey =
      resolveEnvRef(creds.apiKey) ??
      destination.originalProperties?.["URL.headers.X-N8N-API-KEY"] ??
      // Cloud SDK exposes destination custom headers on `destinationConfiguration`
      // when the raw destination service response is unwrapped by the SDK.
      destination.originalProperties?.destinationConfiguration?.["URL.headers.X-N8N-API-KEY"] ??
      process.env.N8N_API_KEY
    return buildConnection(
      destination.url,
      apiKey,
      timeout,
      resolveUseTestWebhook(cfg, destination),
      destination.authHeaders ?? {},
    )
  }

  // 2) Bound / inline credentials.
  const credBaseUrl = resolveEnvRef(creds.baseUrl ?? creds.url)
  const credApiKey = resolveEnvRef(creds.apiKey)
  if (credBaseUrl) {
    LOG.debug(`Resolved n8n connection from credentials: ${credBaseUrl}`)
    return buildConnection(credBaseUrl, credApiKey, timeout, resolveUseTestWebhook(cfg))
  }

  // 3) Plain env vars.
  const envBaseUrl = process.env.N8N_BASE_URL
  const envApiKey = process.env.N8N_API_KEY
  if (envBaseUrl) {
    LOG.debug(`Resolved n8n connection from env vars: ${envBaseUrl}`)
    return buildConnection(envBaseUrl, envApiKey, timeout, resolveUseTestWebhook(cfg))
  }

  // 4) Dev-only default.
  const isDev = isDevelopmentProfile()
  if (isDev) {
    LOG.warn(
      `No n8n credentials configured - falling back to development default ${DEV_DEFAULT_BASE_URL}`,
    )
    return buildConnection(DEV_DEFAULT_BASE_URL, undefined, timeout, resolveUseTestWebhook(cfg))
  }

  throw new Error(
    "n8n: no credentials, no destination, and N8N_BASE_URL is not set. " +
      "Provide a service key via `cds.requires.N8nService.credentials`, " +
      "a bound user-provided service, a BTP destination, or the " +
      "N8N_BASE_URL / N8N_API_KEY environment variables.",
  )
}

/**
 * Uniform connection shape passed to the client.
 *
 * - `apiKey`: the n8n API key (JWT). Sent as `X-N8N-API-KEY` and, on webhook
 *   endpoints, additionally as `X-Webhook-Secret` for interoperability.
 * - `authHeaders`: headers obtained from the SAP Cloud SDK for a resolved BTP
 *   destination - typically `Authorization: Bearer …` when the destination
 *   uses OAuth2. Empty `{}` for local / API-key-only setups. These are
 *   merged on top of every outbound request so a Jupiter/IAS proxy in front
 *   of managed n8n instances can authorise the call before it reaches n8n.
 * - `headers`: legacy field kept for backwards compatibility (older callers
 *   may destructure it); mirrors the `X-N8N-API-KEY`-only set.
 */
function buildConnection(baseUrl, apiKey, timeout, useTestWebhook, authHeaders = {}) {
  return {
    baseUrl,
    apiKey,
    authHeaders,
    headers: buildHeaders(apiKey),
    timeout,
    useTestWebhook: Boolean(useTestWebhook),
  }
}

function isDevelopmentProfile() {
  const profiles = cds.env?.profiles ?? []
  if (Array.isArray(profiles) && profiles.includes("development")) return true
  const nodeEnv = process.env.NODE_ENV
  if (!nodeEnv || nodeEnv === "development") return true
  return false
}

module.exports = {
  getConfig,
  resolveEnvRef,
  resolveN8nConnection,
  resolveTimeouts,
  resolveUseTestWebhook,
  buildHeaders,
  buildWebhookHeaders,
  buildApiHeaders,
  isDevelopmentProfile,
}
