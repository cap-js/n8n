const cds = require("@sap/cds")
const fs = require("fs")
const path = require("path")

const LOG = cds.log("n8n")

/**
 * Resolves the credentials needed to perform the IAS JWT-bearer assertion
 * (Agent Gateway step "Exchange Access Token") and, for later steps, to reach
 * the Agent Gateway itself.
 *
 * Configuration lives under `cds.requires.n8n.credentials.agentGateway`. It can
 * be supplied inline, via file references (handy for local development, mirroring
 * the Bruno collection which points at on-disk PEM files), or as a single
 * consumed-resource-definition JSON file (`crdFile`) that carries the same shape
 * as a bound identity/agent-gateway service.
 *
 * Recognised inputs (all optional unless noted):
 *   {
 *     // --- IAS mTLS client (required for the assertion) ---
 *     clientid,                       // IAS OAuth client id
 *     iasUrl | uri | tokenServiceUrl, // IAS base URL (token endpoint is discovered)
 *     certificate | certificateFile,  // PEM client certificate (mTLS)
 *     privateKey  | key | privateKeyFile, // PEM client key (mTLS)
 *
 *     // --- Agent Gateway target (used by later, not-yet-implemented steps) ---
 *     gatewayUrl,
 *     ordId, globalTenantId,          // or integrationDependencies: [{ ordId, globalTenantId }]
 *     resource,                       // dependency name; defaults to 'agent-gateway'
 *
 *     // --- convenience ---
 *     crdFile                         // path to a JSON file holding any of the above
 *   }
 *
 * @returns {{
 *   clientid: string,
 *   iasUrl: string,
 *   certificate: string,
 *   key: string,
 *   resource: string,
 *   gatewayUrl?: string,
 *   ordId?: string,
 *   globalTenantId?: string
 * }}
 */
function resolveAgentGatewayCredentials() {
  const creds = cds.env.requires?.n8n?.credentials
  const raw = creds?.agentGateway
  if (!raw) {
    cds.error({
      code: "N8N_NO_AGENT_GATEWAY_CONFIG",
      message:
        "n8n: no Agent Gateway configuration. Set `cds.requires.n8n.credentials.agentGateway` " +
        "with the IAS client id, mTLS certificate/key and IAS url (inline, via " +
        "`certificateFile`/`privateKeyFile`, or a `crdFile`).",
    })
  }

  // A `crdFile` provides a base layer; inline values take precedence over it.
  const merged = raw.crdFile ? { ...readJsonFile(raw.crdFile), ...raw } : { ...raw }

  const clientid = merged.clientid
  const iasUrl = normalizeIasUrl(merged.iasUrl ?? merged.uri ?? merged.tokenServiceUrl)
  const certificate = merged.certificate ?? readTextFile(merged.certificateFile)
  const key = merged.privateKey ?? merged.key ?? readTextFile(merged.privateKeyFile)

  const dependency = firstIntegrationDependency(merged.integrationDependencies)
  const ordId = merged.ordId ?? dependency?.ordId
  const globalTenantId = merged.globalTenantId ?? dependency?.globalTenantId
  const resource = merged.resource ?? "agent-gateway"

  const missing = []
  if (!clientid) missing.push("clientid")
  if (!iasUrl) missing.push("iasUrl (or uri/tokenServiceUrl)")
  if (!certificate) missing.push("certificate (or certificateFile)")
  if (!key) missing.push("privateKey (or key/privateKeyFile)")
  if (missing.length > 0) {
    cds.error({
      code: "N8N_INVALID_AGENT_GATEWAY_CONFIG",
      message: `n8n: Agent Gateway configuration is missing required field(s): ${missing.join(", ")}.`,
    })
  }

  LOG.debug(`Resolved Agent Gateway IAS credentials for client '${clientid}' at ${iasUrl}`)
  return {
    clientid,
    iasUrl,
    certificate,
    key,
    resource,
    gatewayUrl: merged.gatewayUrl,
    ordId,
    globalTenantId,
  }
}

function firstIntegrationDependency(dependencies) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) return undefined
  return dependencies[0]
}

/**
 * IAS credentials may carry either the bare instance URL (`uri`) or a full token
 * endpoint (`tokenServiceUrl`, e.g. `https://<tenant>/oauth2/token`). @sap/xssec's
 * IdentityService discovers the token endpoint from the instance's
 * openid-configuration, so we always hand it the origin.
 */
function normalizeIasUrl(url) {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function readTextFile(filePath) {
  if (!filePath) return undefined
  return fs.readFileSync(resolvePath(filePath), "utf8")
}

function readJsonFile(filePath) {
  return JSON.parse(readTextFile(filePath))
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cds.root ?? process.cwd(), filePath)
}

module.exports = { resolveAgentGatewayCredentials }
