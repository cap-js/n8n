const cds = require("@sap/cds")
const { resolveAgentGatewayCredentials } = require("./agent-gateway-credentials")

const LOG = cds.log("n8n")

// Prefix mandated by IAS for naming a consumed application (app2app) dependency.
const RESOURCE_PREFIX = "urn:sap:identity:application:provider:name:"

// Header used to carry the authenticated user's JWT from the (synchronous)
// originating request through the outbox to the (asynchronous) trigger delivery,
// where the assertion is performed. The outbox persists message headers.
const USER_ASSERTION_HEADER = "x-agw-user-assertion"

// Cached @sap/xssec IdentityService instance, keyed by the resolved client id so
// a configuration change (e.g. in tests) rebuilds it.
let _cache

// Factory for the @sap/xssec IdentityService. Overridable for tests so they need
// not perform a real mTLS/IAS round-trip. `@sap/xssec` is required lazily so that
// other service kinds and tests without credentials do not need to load it.
let _identityServiceFactory = (credentials) => {
  const { IdentityService } = require("@sap/xssec")
  return new IdentityService(credentials)
}

/**
 * Performs the IAS JWT-bearer assertion (Agent Gateway "Exchange Access Token"
 * step). Takes the authenticated end user's JWT and exchanges it, via mTLS and
 * the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant, for a new token that
 * is scoped for the Agent Gateway (`resource=urn:sap:identity:application:provider:name:agent-gateway`).
 *
 * This mirrors request 2 of the Bruno collection:
 *   POST {IAS}/oauth2/token
 *     grant_type = urn:ietf:params:oauth:grant-type:jwt-bearer
 *     resource   = urn:sap:identity:application:provider:name:agent-gateway
 *     assertion  = <user JWT>
 *     client_id  = <clientid>            (mTLS client certificate authentication)
 *
 * @param {string} userJwt The authenticated user's JWT to use as assertion.
 * @returns {Promise<{ token: string, expiresIn: number }>} Exchanged Agent Gateway token.
 */
async function exchangeUserToken(userJwt) {
  if (!userJwt || typeof userJwt !== "string") {
    cds.error({
      code: "N8N_MISSING_USER_ASSERTION",
      message:
        "n8n: cannot perform Agent Gateway assertion without an authenticated user JWT. " +
        "Ensure the request is authenticated (IAS) and the token is forwarded to the trigger.",
    })
  }

  const { service, resource } = getIdentityService()
  try {
    // token_format=jwt is required so IAS returns a JWT (its server-side default
    // may otherwise yield an opaque token). This mirrors the Bruno collection.
    const response = await service.fetchJwtBearerToken(userJwt, {
      resource,
      token_format: "jwt",
    })
    // The access_token (scoped for the Agent Gateway via `resource`) is the
    // token the gateway expects. id_token is also exposed for debugging.
    const { id_token, access_token, expires_in } = response
    LOG.info("Obtained Agent Gateway token via IAS assertion", {
      tokenType: access_token ? "access_token" : "id_token",
    })
    return {
      token: access_token ?? id_token,
      idToken: id_token,
      accessToken: access_token,
      expiresIn: expires_in,
    }
  } catch (err) {
    LOG.error(`IAS JWT-bearer assertion failed: ${err.message ?? err}`)
    cds.error({
      code: "N8N_ASSERTION_FAILED",
      message: `n8n: IAS JWT-bearer assertion for the Agent Gateway failed: ${err.message ?? err}`,
    })
  }
}

/**
 * Lazily builds (and caches) an @sap/xssec IdentityService from the resolved
 * Agent Gateway credentials.
 */
function getIdentityService() {
  const { clientid, iasUrl, certificate, key, resource } = resolveAgentGatewayCredentials()
  if (_cache?.clientid === clientid && _cache?.iasUrl === iasUrl) {
    return { service: _cache.service, resource: toResourceUrn(resource) }
  }

  const service = _identityServiceFactory({ clientid, url: iasUrl, certificate, key })
  _cache = { clientid, iasUrl, service }
  return { service, resource: toResourceUrn(resource) }
}

/**
 * Accepts either a plain dependency name (`agent-gateway`) or an already-qualified
 * `urn:sap:identity:application:provider:name:...` value and returns the URN form.
 */
function toResourceUrn(resource) {
  if (!resource) return `${RESOURCE_PREFIX}agent-gateway`
  return resource.startsWith(RESOURCE_PREFIX) ? resource : `${RESOURCE_PREFIX}${resource}`
}

// Exposed for tests to reset the cached IdentityService between cases.
function _resetCache() {
  _cache = undefined
}

// Exposed for tests to inject a fake IdentityService factory.
function _setIdentityServiceFactory(fn) {
  _identityServiceFactory = fn
  _cache = undefined
}

module.exports = {
  exchangeUserToken,
  toResourceUrn,
  USER_ASSERTION_HEADER,
  _resetCache,
  _setIdentityServiceFactory,
}
