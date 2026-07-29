"use strict"

const cds = require("@sap/cds")
const { N8N_LOGGER_PREFIX } = require("../constants")

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Resolves a BTP destination and returns a shape usable by our connection
 * resolver. Wrapped in a try/catch so tests / dev machines without the SDK
 * don't hard-fail; a warning is logged and `undefined` is returned.
 *
 * Returns:
 *   {
 *     url: string,
 *     originalProperties: Record<string,unknown>,
 *     authHeaders: Record<string,string>,   // e.g. { Authorization: 'Bearer …' }
 *     raw: <full destination>,
 *   }
 *
 * `authHeaders` is populated when the destination's auth type yields any
 * (OAuth2ClientCredentials, OAuth2UserTokenExchange, BasicAuthentication,
 * mTLS, etc.). For NoAuthentication destinations it is an empty object.
 * When token acquisition fails (misconfigured client, expired secret, …)
 * we log the error and return `authHeaders: {}` so the caller can still
 * proceed with any custom headers from `URL.headers.*` on the destination -
 * that pattern is common with managed backends that layer their own API
 * key inside an outer OAuth-protected proxy.
 */
async function resolveDestination(destinationName) {
  if (!destinationName) return undefined

  let getDestination, buildHeadersForDestination
  try {
    ;({ getDestination, buildHeadersForDestination } = require("@sap-cloud-sdk/connectivity"))
  } catch (err) {
    LOG.warn(
      `@sap-cloud-sdk/connectivity is not installed; cannot resolve destination "${destinationName}".`,
    )
    return undefined
  }

  const destination = await getDestination({ destinationName, useCache: true })
  if (!destination) return undefined

  const authHeaders = await buildAuthHeaders(destination, buildHeadersForDestination)

  return {
    url: destination.url,
    originalProperties: destination.originalProperties,
    authHeaders,
    // Retain the full object so callers that want to hand it to
    // @sap-cloud-sdk/http-client's executeHttpRequest can do so if desired.
    raw: destination,
  }
}

/**
 * Attempts to obtain the auth headers for the destination. Returns an object
 * (possibly empty) - never throws. The SDK returns lowercased header names;
 * we normalise 'authorization' to 'Authorization' because n8n / any proxy in
 * front of it is case-sensitive in some edge configurations.
 */
async function buildAuthHeaders(destination, buildHeadersForDestination) {
  try {
    const raw = await buildHeadersForDestination(destination)
    return normaliseHeaderCasing(raw)
  } catch (err) {
    // Typical when the destination's OAuth client is misconfigured. Do NOT
    // fail the whole resolution - the caller may still be able to send the
    // request with only the destination's `URL.headers.*` custom headers,
    // which is enough for backends that don't enforce OAuth themselves.
    LOG.warn(
      `Could not build auth headers for destination "${destination.name}": ${err.message ?? err}`,
    )
    return {}
  }
}

function normaliseHeaderCasing(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[toTitleCase(k)] = v
  }
  return out
}

function toTitleCase(headerName) {
  return String(headerName).replace(/(^|-)(.)/g, (_, sep, c) => sep + c.toUpperCase())
}

module.exports = { resolveDestination, buildAuthHeaders, normaliseHeaderCasing }
