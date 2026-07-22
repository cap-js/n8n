'use strict'

const cds = require('@sap/cds')
const {
  N8N_LOGGER_PREFIX,
  N8N_SERVICE,
  CUD_EVENTS,
} = require('../constants')
const { buildTriggerCache } = require('../shared/annotations-helper')
const {
  handleTrigger,
  buildColumnsFromInputs,
  prefetchStashKey,
  PREFETCH_KEY,
} = require('./triggerHandler')

const LOG = cds.log(N8N_LOGGER_PREFIX)

const { SELECT } = cds.ql

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

  // DELETE payloads must be captured *before* the row is gone. Register a
  // before-handler for each entity that has any DELETE-firing trigger so the
  // after-handler can consult the stash.
  registerDeletePrefetchers(service, cache)

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
 * Installs `before('DELETE', entity)` handlers that SELECT the row from the
 * database and stash it on the request context. The after-handler picks the
 * stashed row up so the DELETE webhook receives a full payload rather than
 * just the keys the caller sent.
 *
 * A single before-handler per entity fetches the *union* of columns required
 * by every DELETE trigger on that entity; we stash the row once and the
 * dispatch loop projects it as needed. That keeps DB round-trips at 1 even
 * when an entity carries multiple qualified triggers.
 */
function registerDeletePrefetchers(service, cache) {
  const perEntity = new Map()
  for (const [cacheKey, cached] of cache.entries()) {
    if (!cacheKey.endsWith(':DELETE')) continue
    const entityName = cacheKey.slice(0, -':DELETE'.length)
    perEntity.set(entityName, cached.triggerAnnotations)
  }

  for (const [entityName, annotations] of perEntity.entries()) {
    const entity = service.entities?.[localName(service, entityName)]
    if (!entity) continue

    service.before('DELETE', entity, async (req) => {
      await prefetchForDelete(req, entity, annotations)
    })
  }
}

/**
 * Strips the service prefix from a fully-qualified entity name so the entity
 * can be looked up on `service.entities`, which is keyed by the local name.
 */
function localName(service, fqn) {
  const prefix = `${service.name}.`
  return fqn.startsWith(prefix) ? fqn.slice(prefix.length) : fqn
}

async function prefetchForDelete(req, entity, annotations) {
  const keyFields = Object.keys(entity.keys ?? {}).filter((k) => !entity.keys[k].virtual)
  if (keyFields.length === 0) return

  // Collect the union of columns across every DELETE annotation on this
  // entity so a single SELECT satisfies them all.
  const columns = unionColumns(
    annotations.map((ann) => buildColumnsFromInputs(ann.inputs, entity)),
  )

  const where = buildKeyWhere(keyFields, req.data)
  if (!where) return

  let row
  try {
    row = await req.tx.run(SELECT.one.from(entity.name).columns(columns).where(where))
  } catch (err) {
    LOG.error(
      `Failed to prefetch row for DELETE trigger on ${entity.name}:`,
      err.message ?? err,
    )
    return
  }
  if (!row) return

  const stash = (req.context[PREFETCH_KEY] ??= new Map())
  stash.set(prefetchStashKey(entity.name, req.data), row)
}

/**
 * Merges two column lists into one, deduplicating by textual identity. The
 * expected inputs are the arrays produced by `buildColumnsFromInputs`, i.e.
 * either the string wildcard `'*'` or `{ ref, as?, expand? }` shapes. If any
 * list is the pure wildcard we shortcut to that, since fetching every scalar
 * covers all sub-projections.
 */
function unionColumns(columnLists) {
  if (columnLists.length === 0) return ['*']
  if (columnLists.some((cols) => cols.length === 1 && cols[0] === '*')) return ['*']

  const seen = new Map()
  for (const cols of columnLists) {
    for (const col of cols) {
      const key = JSON.stringify(col)
      if (!seen.has(key)) seen.set(key, col)
    }
  }
  return [...seen.values()]
}

function buildKeyWhere(keyFields, data) {
  const parts = []
  for (const key of keyFields) {
    if (data?.[key] === undefined) return undefined
    if (parts.length) parts.push('and')
    parts.push({ ref: [key] }, '=', { val: data[key] })
  }
  return parts.length ? { xpr: parts } : undefined
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
