const cds = require("@sap/cds")
const N8nRestService = require("./n8n-to-rest")
const { exchangeUserToken, USER_ASSERTION_HEADER } = require("../lib/auth/token-exchange")
const { resolveAgentGatewayCredentials } = require("../lib/auth/agent-gateway-credentials")

const LOG = cds.log("n8n")

/**
 * SAP-managed n8n adapter. Unlike the REST adapter it never talks to n8n
 * directly: every workflow invocation is gated behind the SAP Agent Gateway.
 *
 * Reaching the gateway is a multi-step, gated flow. This adapter currently
 * implements the FIRST gate — the IAS JWT-bearer assertion ("Exchange Access
 * Token"): the authenticated user's JWT is exchanged (via mTLS) for a token
 * scoped for the Agent Gateway. The subsequent Agent Gateway invocation is left
 * as a clearly marked stub.
 *
 * Workflow/execution management (`/api/v1`) is inherited from the REST adapter
 * for now and is out of scope for the gateway routing.
 */
class N8nGatewayService extends N8nRestService {
  async _trigger(req) {
    const { path, payload, method = "POST" } = req.data ?? {}

    // --- Gate 1: IAS assertion (implemented) ---
    // The user JWT was captured synchronously in the originating request and
    // forwarded as a header so it survives the (async) outbox delivery.
    const userJwt = readAssertionHeader(req)
    const { token, expiresIn } = await exchangeUserToken(userJwt)
    LOG.info("Agent Gateway assertion succeeded", { path, method, expiresIn })

    // --- Gate 2+: call the Agent Gateway (NOT YET IMPLEMENTED) ---
    // TODO: Use the exchanged token to invoke the workflow behind the gateway, e.g.
    //   POST {gatewayUrl}/v1/mcp/{ordId}/{globalTenantId}
    //   Authorization: Bearer <token>
    //   Content-Type: application/json
    // See https://pages.github.tools.sap/AI/agent-gateway-documentation/ (MCP endpoint).
    const { gatewayUrl, ordId, globalTenantId } = resolveAgentGatewayCredentials()
    LOG.warn(
      "Agent Gateway invocation is not yet implemented; the assertion token was obtained but not used.",
      { gatewayUrl, ordId, globalTenantId },
    )

    return { asserted: true, assertedToken: Boolean(token), payload: payload ?? {} }
  }
}

/**
 * Reads the forwarded user assertion header case-insensitively (CAP/Node header
 * maps may normalise casing depending on the transport).
 */
function readAssertionHeader(req) {
  const headers = req.headers ?? {}
  if (headers[USER_ASSERTION_HEADER]) return headers[USER_ASSERTION_HEADER]
  const match = Object.keys(headers).find((k) => k.toLowerCase() === USER_ASSERTION_HEADER)
  return match ? headers[match] : undefined
}

module.exports = N8nGatewayService
