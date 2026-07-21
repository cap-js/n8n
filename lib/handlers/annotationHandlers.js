'use strict'

const cds = require('@sap/cds')
const {
  N8N_LOGGER_PREFIX,
  N8N_SERVICE,
  CUD_EVENTS,
} = require('../constants')
const { buildTriggerCache } = require('../shared/annotations-helper')
const { handleTrigger } = require('./triggerHandler')

const LOG = cds.log(N8N_LOGGER_PREFIX)

/**
 * Registers @n8n.trigger annotation handlers on a given CAP service. Only
 * ApplicationServices carry entities/actions we care about; other services
 * (like the built-in outboxed n8n itself) are skipped.
 */
function registerAnnotationHandlers(service) {
  if (!(service instanceof cds.ApplicationService)) return
  if (service.name === N8N_SERVICE) return

  const cache = buildTriggerCache(Object.values(service.entities ?? {}), CUD_EVENTS)
  if (cache.size === 0) return

  LOG.debug(
    `Registering @n8n.trigger handlers for service ${service.name} (${cache.size} entity:event bindings)`,
  )

  service.after('*', async (results, req) => {
    if (!req.target) return
    const cacheKey = `${req.target.name}:${req.event}`
    const cached = cache.get(cacheKey)
    if (!cached || cached.triggerAnnotations.length === 0) return

    const rows = Array.isArray(results) ? results : results ? [results] : []
    if (rows.length > 0) {
      await Promise.all(
        rows.map((row) => dispatchTriggers(cached.triggerAnnotations, req, row)),
      )
    } else {
      await dispatchTriggers(cached.triggerAnnotations, req, req.data)
    }
  })

  registerEventTriggerHandlers(service)
}

/**
 * Custom events annotated with @n8n.trigger fire when emitted on the service.
 * Register handlers for these events specifically.
 */
function registerEventTriggerHandlers(service) {
  // service.definition?.events holds the event definitions in modern CAP.
  const eventDefs = service.definition?.events ?? {}
  const {
    findTriggerAnnotations,
  } = require('../shared/annotations-helper')

  for (const eventName in eventDefs) {
    const evDef = eventDefs[eventName]
    if (!evDef || typeof evDef !== 'object') continue
    const anns = findTriggerAnnotations(evDef)
    if (anns.length === 0) continue

    // Event names may be namespaced; register on the local name.
    const shortName = eventName.split('.').pop() ?? eventName
    service.on(shortName, async (req) => {
      await dispatchTriggers(anns, req, req.data)
    })
  }
}

async function dispatchTriggers(annotations, req, data) {
  await Promise.all(annotations.map((ann) => handleTrigger(req, data, ann)))
}

module.exports = { registerAnnotationHandlers }
