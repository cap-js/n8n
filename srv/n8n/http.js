const cds = require("@sap/cds")

const LOG = cds.log("n8n")

// Config source for the REST handlers. Reads from `cds.env.requires.N8nService.credentials`
// with a fallback to `N8N_BASE_URL` / `N8N_API_KEY` env vars for local dev.
function n8nConfig() {
  const creds = cds.env.requires?.N8nService?.credentials ?? {}
  return {
    baseUrl: creds.url ?? process.env.N8N_BASE_URL,
    apiKey: creds.apiKey ?? process.env.N8N_API_KEY,
  }
}

// Consolidates the boilerplate around building requests against the n8n
// Public REST API: base URL, `X-N8N-API-KEY` header, JSON body
// serialisation. Used by every workflow / execution handler.
async function n8nRequest({ method, path, body }) {
  const { baseUrl, apiKey } = n8nConfig()
  const init = {
    method,
    headers: { "X-N8N-API-KEY": apiKey },
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const url = `${baseUrl}${path}`
  LOG.info("n8n API request", { method, url })
  return fetch(url, init)
}

module.exports = { n8nConfig, n8nRequest }
