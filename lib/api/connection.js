const cds = require("@sap/cds")
const { resolveDestination } = require("../auth/destination")

const LOG = cds.log("@cap-js/n8n")

function resolveUseTestWebhook(cfg, destination) {
  const fromDest = destination?.originalProperties?.["URL.useTestWebhook"]
  if (fromDest !== undefined) return Boolean(fromDest)
  const fromCreds = cfg?.credentials?.useTestWebhook
  if (fromCreds !== undefined) return Boolean(fromCreds)
  if (process.env.N8N_USE_TEST_WEBHOOK !== undefined) return Boolean(process.env.N8N_USE_TEST_WEBHOOK)
  return false
}

/**
 * Resolves how to reach n8n. Returns
 *   { baseUrl, apiKey, useTestWebhook, authHeaders }
 *
 * Precedence:
 *   1) BTP destination named in `credentials.destination` (or top-level
 *      `destination`). Wins outright — otherwise a leftover `credentials.url`
 *      would silently shadow a user-configured destination.
 *   2) Inline `credentials.{url, apiKey}`. `apiKey` falls through to
 *      N8N_API_KEY so a URL in package.json plus a key in `.env` compose
 *      naturally.
 *   3) Env vars `N8N_BASE_URL` + `N8N_API_KEY`.
 *
 * Throws when nothing resolves.
 */
async function resolveN8nConnection() {
  const cfg = cds.env.requires?.N8nService
  const creds = cfg.credentials ?? {}

  // 1) Destination — highest priority.
  const destinationName = creds.destination ?? cfg.destination
  if (destinationName) {
    LOG.debug(`Resolving n8n connection via destination: ${destinationName}`)
    const destination = await resolveDestination(destinationName)
    if (!destination) {
      throw new Error(`n8n: destination not found: ${destinationName}`)
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
    }
  }

  // 2) Inline credentials.
  if (creds.url) {
    LOG.debug(`Resolved n8n connection from credentials: ${creds.url}`)
    return {
      baseUrl: creds.url,
      apiKey: creds.apiKey ?? process.env.N8N_API_KEY,
      useTestWebhook: resolveUseTestWebhook(cfg),
      authHeaders: {},
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
    }
  }

  throw new Error(
    "n8n: no credentials, no destination, and N8N_BASE_URL is not set. " +
    "Provide a service key via `cds.requires.N8nService.credentials`, " +
    "a bound user-provided service, a BTP destination, or the " +
    "N8N_BASE_URL / N8N_API_KEY environment variables.",
  )
}

// Consolidates the boilerplate around building requests against the n8n
// Public REST API: base URL, `X-N8N-API-KEY` header, optional destination
// auth headers (Bearer token from a Jupiter/IAS proxy in front of managed
// n8n), and JSON body serialisation. Used by every workflow / execution
// handler.
async function n8nRequest({ method, path, body }) {
  const { baseUrl, apiKey, authHeaders } = await resolveN8nConnection()
  const init = {
    method,
    headers: {
      ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
      ...(authHeaders ?? {}),
    },
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const url = `${baseUrl}${path}`
  LOG.debug("API Request against n8n Instance", { method, url })
  return fetch(url, init)
}

module.exports = { resolveN8nConnection, resolveUseTestWebhook, n8nRequest }
