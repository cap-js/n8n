const cds = require("@sap/cds")
const fs = require("fs")
const path = require("path")

const LOG = cds.log("n8n")

/**
 * Resolves credentials for the IAS JWT-bearer assertion and Agent Gateway target
 * from `cds.requires.n8n.credentials.agentGateway`. Values can be inline, via
 * file references (`certificateFile`/`privateKeyFile`), or a `crdFile` JSON base.
 * @returns {{ clientid: string, iasUrl: string, certificate: string, key: string,
 *   resource: string, gatewayUrl?: string, ordId?: string, globalTenantId?: string }}
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

  // Inline values take precedence over a crdFile base layer.
  const merged = raw.crdFile ? { ...JSON.parse(readTextFile(raw.crdFile)), ...raw } : { ...raw }

  const clientid = merged.clientid
  const iasUrl = normalizeIasUrl(merged.iasUrl ?? merged.uri ?? merged.tokenServiceUrl)
  const certificate = merged.certificate ?? readTextFile(merged.certificateFile)
  const key = merged.privateKey ?? merged.key ?? readTextFile(merged.privateKeyFile)

  const deps = merged.integrationDependencies
  const dependency = Array.isArray(deps) ? deps[0] : undefined
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

/**
 * IAS credentials may carry the bare instance URL or a full token endpoint.
 * @sap/xssec discovers the token endpoint from openid-configuration, so we hand
 * it the origin.
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
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cds.root ?? process.cwd(), filePath)
  return fs.readFileSync(resolved, "utf8")
}

module.exports = { resolveAgentGatewayCredentials }
