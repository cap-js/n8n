const cds = require("@sap/cds")
const N8nRestService = require("./n8n-to-rest")
const { exchangeUserToken, USER_ASSERTION_HEADER } = require("../lib/auth/token-exchange")
const { resolveAgentGatewayCredentials } = require("../lib/auth/agent-gateway-credentials")

const LOG = cds.log("n8n")

/**
 * SAP-managed n8n adapter. Every workflow invocation is gated behind the SAP
 * Agent Gateway. This adapter implements the first gate — the IAS JWT-bearer
 * assertion; the Agent Gateway invocation itself is still a stub. Workflow/
 * execution management is inherited from the REST adapter.
 */
class N8nGatewayService extends N8nRestService {
  async _trigger(req) {
    const { path, payload, method = "POST" } = req.data ?? {}

    const userJwt = readAssertionHeader(req)
    const { token, expiresIn } = await exchangeUserToken(userJwt)
    LOG.info("Agent Gateway assertion succeeded", { path, method, expiresIn })

    // TODO: invoke the workflow behind the gateway with the exchanged token:
    //   POST {gatewayUrl}/v1/mcp/{ordId}/{globalTenantId}, Authorization: Bearer <token>
    const { gatewayUrl, ordId, globalTenantId } = resolveAgentGatewayCredentials()
    LOG.warn(
      "Agent Gateway invocation is not yet implemented; the assertion token was obtained but not used.",
      { gatewayUrl, ordId, globalTenantId },
    )

    return { asserted: true, assertedToken: Boolean(token), payload: payload ?? {} }
  }
}

// Header casing may be normalised depending on the transport.
function readAssertionHeader(req) {
  const headers = req.headers ?? {}
  if (headers[USER_ASSERTION_HEADER]) return headers[USER_ASSERTION_HEADER]
  const match = Object.keys(headers).find((k) => k.toLowerCase() === USER_ASSERTION_HEADER)
  return match ? headers[match] : undefined
}

module.exports = N8nGatewayService
