'use strict'

const cds = require('@sap/cds')
const { N8N_LOGGER_PREFIX } = require('../constants')

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Resolves a BTP destination and returns a shape usable by our connection
 * resolver. Wrapped in a try/catch so tests / dev machines without the SDK
 * don't hard-fail; a warning is logged and `undefined` is returned.
 */
async function resolveDestination(destinationName) {
  if (!destinationName) return undefined

  let getDestination
  try {
    ;({ getDestination } = require('@sap-cloud-sdk/connectivity'))
  } catch (err) {
    LOG.warn(
      `@sap-cloud-sdk/connectivity is not installed; cannot resolve destination "${destinationName}".`,
    )
    return undefined
  }

  const destination = await getDestination({ destinationName, useCache: true })
  if (!destination) return undefined

  return {
    url: destination.url,
    originalProperties: destination.originalProperties,
    // Retain the full object so callers that want to hand it to
    // @sap-cloud-sdk/http-client's executeHttpRequest can do so if desired.
    raw: destination,
  }
}

module.exports = { resolveDestination }
