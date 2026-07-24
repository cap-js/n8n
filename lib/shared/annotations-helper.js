'use strict'

const {
  N8N_PROCESS_START,
  N8N_PROCESS_START_PATH,
  N8N_PROCESS_START_ON,
  N8N_PROCESS_START_IF,
  N8N_PROCESS_START_INPUTS,
  DEFAULT_STRING_SHORTHAND_EVENTS,
} = require('../constants')

/**
 * Extracts the qualifier from an annotation prefix.
 *   extractQualifier('@n8n.process.start#one', '@n8n.process.start') → 'one'
 *   extractQualifier('@n8n.process.start',      '@n8n.process.start') → undefined
 */
function extractQualifier(prefix, base) {
  if (prefix.length <= base.length) return undefined
  const remainder = prefix.substring(base.length)
  return remainder.startsWith('#') ? remainder.substring(1) : undefined
}

/**
 * Returns the set of unique annotation prefixes on an entity that match a base
 * annotation. A prefix is the annotation up to (but not including) the first
 * '.' after the base.
 *
 *   getAnnotationPrefixes(entity, '@n8n.process.start')
 *     → Set { '@n8n.process.start', '@n8n.process.start#one' }
 *
 * NOTE: Only prefixes that have at least one sub-key (`.path`, `.on`, …)
 * are returned; the pure string-shorthand form (`@n8n.process.start: 'foo'`)
 * is handled separately via `extractStringShorthand`.
 */
function getAnnotationPrefixes(entity, base) {
  const prefixes = new Set()
  for (const key of Object.keys(entity)) {
    if (!key.startsWith(base)) continue
    const dotIdx = key.indexOf('.', base.length)
    if (dotIdx === -1) continue
    prefixes.add(key.substring(0, dotIdx))
  }
  return prefixes
}

/**
 * Detects the string-shorthand form of `@n8n.process.start`. When users write:
 *   @n8n.process.start: 'my-webhook'
 * the CDS compiler stores the value on the base annotation key directly
 * (without a `.path` sub-key). Returns the string or undefined.
 *
 * Also handles qualified string shorthands like `@n8n.process.start#one: 'foo'`.
 */
function extractStringShorthand(entity, prefixKey) {
  const val = entity[prefixKey]
  return typeof val === 'string' ? val : undefined
}

/**
 * Collects `@n8n.process.start[.…]` annotation descriptors from an entity or
 * event definition. Handles both:
 *   - Record form: @n8n.process.start: { path, on, if, inputs }
 *   - String shorthand: @n8n.process.start: 'my-webhook'      (fires on CREATE + UPDATE)
 * Qualified variants (`@n8n.process.start#foo: …`) are handled the same way.
 *
 * Returns an array of descriptors:
 *   {
 *     qualifier: string|undefined,
 *     path: string,
 *     on: string[],                // list of event names (CREATE, UPDATE, DELETE, bound-action-name, …)
 *     conditionExpr: expr|undefined,
 *     inputs: InputCSN[]|undefined
 *   }
 */
function findTriggerAnnotations(entity) {
  const results = []
  const seenPrefixes = new Set()

  // Record form (has sub-keys like `.path`, `.on`, `.if`, `.inputs`)
  const prefixes = getAnnotationPrefixes(entity, N8N_PROCESS_START)
  for (const prefix of prefixes) {
    seenPrefixes.add(prefix)

    const pathKey = `${prefix}.path`
    const onKey = `${prefix}.on`
    const ifKey = `${prefix}.if`
    const inputsKey = `${prefix}.inputs`

    const path = entity[pathKey]
    if (!path || typeof path !== 'string') continue

    const onRaw = entity[onKey]
    const on = normalizeOnValue(onRaw)
    if (!on || on.length === 0) continue

    const qualifier = extractQualifier(prefix, N8N_PROCESS_START)
    const ifAnnotation = entity[ifKey]
    const inputs = entity[inputsKey]

    results.push({
      qualifier,
      path,
      on,
      conditionExpr: ifAnnotation?.xpr,
      inputs,
    })
  }

  // String shorthand form: base or qualified base holds a plain string value.
  // Iterate all top-level keys again to catch qualifiers.
  for (const key of Object.keys(entity)) {
    // Must start with base and NOT already be captured as a record-form prefix.
    if (!key.startsWith(N8N_PROCESS_START)) continue
    if (seenPrefixes.has(key)) continue
    // Skip sub-keys of a record-form prefix (e.g. '@n8n.process.start.path')
    if (key.includes('.', N8N_PROCESS_START.length)) continue

    const shorthand = extractStringShorthand(entity, key)
    if (!shorthand) continue

    results.push({
      qualifier: extractQualifier(key, N8N_PROCESS_START),
      path: shorthand,
      on: [...DEFAULT_STRING_SHORTHAND_EVENTS],
      conditionExpr: undefined,
      inputs: undefined,
    })
  }

  return results
}

/**
 * Normalises `on:` into an array of strings.
 *   - undefined → undefined
 *   - 'CREATE'  → ['CREATE']
 *   - ['CREATE', 'UPDATE'] → ['CREATE', 'UPDATE']
 */
function normalizeOnValue(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string')
  return undefined
}

/**
 * Expands a single "on" event value against an entity's bound actions.
 * Returns [] for unknown/empty inputs. '*' means "all CRUD + all bound actions".
 */
function expandEvent(event, entity, cudEvents) {
  if (!event) return []
  if (event === '*') {
    const boundActions = entity.actions ? Object.keys(entity.actions) : []
    return [...cudEvents, ...boundActions]
  }
  return [event]
}

/**
 * Scans the entire CDS model (via a `services` iterable) and returns a flat
 * map { entityFullName:eventName → matching annotation descriptors }.
 * Used at runtime to install after-commit hooks efficiently.
 *
 * @param {Iterable<any>} entities  Iterable of cds.entity objects
 * @param {string[]} cudEvents      CRUD event names (typically CUD_EVENTS constant)
 */
function buildTriggerCache(entities, cudEvents) {
  const cache = new Map()

  for (const entity of entities) {
    const triggerAnnotations = findTriggerAnnotations(entity)
    if (triggerAnnotations.length === 0) continue

    const events = new Set()
    for (const ann of triggerAnnotations) {
      for (const ev of ann.on) {
        for (const expanded of expandEvent(ev, entity, cudEvents)) events.add(expanded)
      }
    }

    for (const event of events) {
      const matching = triggerAnnotations.filter((ann) =>
        ann.on.some((v) => v === event || v === '*'),
      )
      const cacheKey = `${entity.name}:${event}`
      cache.set(cacheKey, { triggerAnnotations: matching })
    }
  }

  return cache
}

module.exports = {
  extractQualifier,
  getAnnotationPrefixes,
  extractStringShorthand,
  findTriggerAnnotations,
  normalizeOnValue,
  expandEvent,
  buildTriggerCache,
}
