'use strict'

const cds = require('@sap/cds')
const {
  N8N_LOGGER_PREFIX,
  N8N_SERVICE,
  DEV_DEFAULT_BASE_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
} = require('../constants')
const { resolveDestination } = require('../auth/destination')

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
  if (typeof value !== 'string') return value
  if (value.startsWith('env:')) {
    const resolved = process.env[value.slice('env:'.length)]
    return resolved && resolved.trim() ? resolved : undefined
  }
  return value.trim() ? value : undefined
}

function buildHeaders(apiKey) {
  return apiKey ? { 'X-N8N-API-KEY': apiKey } : {}
}

/**
 * Coerces a value into a positive integer number of milliseconds, or returns
 * `undefined` when the value cannot be interpreted. Accepts numbers and numeric
 * strings (e.g. env var values).
 */
function toPositiveInt(value) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * Resolves the HTTP timeouts for calls to n8n. Precedence (per timeout):
 *   1) `credentials.timeout.{connect,read}` (accepts `env:VAR` refs)
 *   2) Env vars N8N_CONNECT_TIMEOUT_MS / N8N_READ_TIMEOUT_MS
 *   3) Built-in defaults (3000 / 5000)
 *
 * Node's `fetch` implementation doesn't split connect from read at the API
 * level — we surface both keys so users can express intent and configure
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
 *   1) Bound / inline `credentials.{baseUrl,apiKey}` — supports `env:VAR` refs.
 *      Also honours `url` as an alias for `baseUrl` (destination shape).
 *   2) BTP destination named in `credentials.destination` or the top-level
 *      `destination` field.
 *   3) Environment variables `N8N_BASE_URL` + `N8N_API_KEY`.
 *   4) Dev default `http://localhost:5678` — only in the `development` profile.
 *
 * Throws when nothing resolves (any non-development profile).
 */
async function resolveN8nConnection(serviceName = N8N_SERVICE) {
  const cfg = getConfig(serviceName)
  const timeout = resolveTimeouts(cfg)

  // 1) Bound / inline credentials.
  const creds = cfg.credentials ?? {}
  const credBaseUrl = resolveEnvRef(creds.baseUrl ?? creds.url)
  const credApiKey = resolveEnvRef(creds.apiKey)
  if (credBaseUrl) {
    LOG.debug(`Resolved n8n connection from credentials: ${credBaseUrl}`)
    return { baseUrl: credBaseUrl, headers: buildHeaders(credApiKey), timeout }
  }

  // 2) BTP destination.
  const destinationName = creds.destination ?? cfg.destination
  if (destinationName) {
    LOG.debug(`Resolving n8n connection via destination: ${destinationName}`)
    const destination = await resolveDestination(destinationName)
    if (!destination) {
      throw new Error(`n8n: destination not found: ${destinationName}`)
    }
    const apiKey =
      resolveEnvRef(creds.apiKey) ??
      destination.originalProperties?.['URL.headers.X-N8N-API-KEY'] ??
      process.env.N8N_API_KEY
    return { baseUrl: destination.url, headers: buildHeaders(apiKey), timeout }
  }

  // 3) Plain env vars.
  const envBaseUrl = process.env.N8N_BASE_URL
  const envApiKey = process.env.N8N_API_KEY
  if (envBaseUrl) {
    LOG.debug(`Resolved n8n connection from env vars: ${envBaseUrl}`)
    return { baseUrl: envBaseUrl, headers: buildHeaders(envApiKey), timeout }
  }

  // 4) Dev-only default.
  const isDev = isDevelopmentProfile()
  if (isDev) {
    LOG.warn(
      `No n8n credentials configured — falling back to development default ${DEV_DEFAULT_BASE_URL}`,
    )
    return { baseUrl: DEV_DEFAULT_BASE_URL, headers: {}, timeout }
  }

  throw new Error(
    'n8n: no credentials, no destination, and N8N_BASE_URL is not set. ' +
      'Provide a service key via `cds.requires.N8nService.credentials`, ' +
      'a bound user-provided service, a BTP destination, or the ' +
      'N8N_BASE_URL / N8N_API_KEY environment variables.',
  )
}

function isDevelopmentProfile() {
  const profiles = cds.env?.profiles ?? []
  if (Array.isArray(profiles) && profiles.includes('development')) return true
  const nodeEnv = process.env.NODE_ENV
  if (!nodeEnv || nodeEnv === 'development') return true
  return false
}

module.exports = {
  getConfig,
  resolveEnvRef,
  resolveN8nConnection,
  resolveTimeouts,
  buildHeaders,
  isDevelopmentProfile,
}
