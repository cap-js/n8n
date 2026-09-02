const cds = require("@sap/cds")
const { resolveAgentGatewayCredentials } = require("./agent-gateway-credentials")

const LOG = cds.log("n8n")

const RESOURCE_PREFIX = "urn:sap:identity:application:provider:name:"

// Carries the user's JWT from the request through the outbox to async delivery.
const USER_ASSERTION_HEADER = "x-agw-user-assertion"

let _cache

let _identityServiceFactory = (credentials) => {
  const { IdentityService } = require("@sap/xssec")
  return new IdentityService(credentials)
}

/**
 * Exchanges the authenticated user's JWT for an Agent Gateway token via the IAS
 * JWT-bearer grant (mTLS), scoped through `resource`.
 * @param {string} userJwt
 * @returns {Promise<{ token: string, idToken?: string, accessToken?: string, expiresIn: number }>}
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
    const response = await service.fetchJwtBearerToken(userJwt, { resource, token_format: "jwt" })
    const { id_token, access_token, expires_in } = response
    LOG.info("Obtained Agent Gateway token via IAS assertion")
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

function getIdentityService() {
  const { clientid, iasUrl, certificate, key, resource } = resolveAgentGatewayCredentials()
  if (_cache?.clientid === clientid && _cache?.iasUrl === iasUrl) {
    return { service: _cache.service, resource: toResourceUrn(resource) }
  }

  const service = _identityServiceFactory({ clientid, url: iasUrl, certificate, key })
  _cache = { clientid, iasUrl, service }
  return { service, resource: toResourceUrn(resource) }
}

function toResourceUrn(resource) {
  if (!resource) return `${RESOURCE_PREFIX}agent-gateway`
  return resource.startsWith(RESOURCE_PREFIX) ? resource : `${RESOURCE_PREFIX}${resource}`
}

function _resetCache() {
  _cache = undefined
}

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
