'use strict'

const cds = require('@sap/cds')
const { N8N_LOGGER_PREFIX, N8N_SERVICE } = require('../constants')
const {
  parseInputsArray,
  buildInputTree,
  WILDCARD,
} = require('../shared/input-parser')

const LOG = cds.log(N8N_LOGGER_PREFIX)

const { SELECT } = cds.ql

/**
 * Symbol used to stash prefetched DELETE rows on the request context. Not a
 * plain string to avoid clashing with any application-level bookkeeping.
 */
const PREFETCH_KEY = Symbol.for('@cap-js/n8n:delete-prefetch')

/**
 * Executes a single @n8n.trigger annotation for a given request + row.
 *  1. Merge request data with action params (for bound actions).
 *  2. Evaluate the `.if` condition — skip if false.
 *  3. Resolve which columns to project (based on `.inputs` mapping).
 *  4. Fetch the row (except on DELETE, where we only have the keys).
 *  5. Emit `trigger` on the outboxed N8nService.
 */
async function handleTrigger(req, data, annotation) {
  const entityData = mergeParams(data, req.params)

  const columns = buildColumnsFromInputs(annotation.inputs, req.target)

  const row = await resolveEntityRow(req, entityData, annotation.conditionExpr, columns)
  if (row === undefined) return

  const payload = shapePayload(row, annotation.inputs)

  await emitTrigger(req, annotation.workflow, payload)
}

/**
 * Merges CAP `req.data` with any additional action params (bound actions expose
 * the target row's keys via req.params; unbound actions carry inputs in data).
 */
function mergeParams(data, params) {
  if (!params || !Array.isArray(params) || params.length === 0) return data ?? {}
  const merged = params.reduce((acc, p) => {
    if (p && typeof p === 'object') return { ...acc, ...p }
    return acc
  }, {})
  return { ...(data ?? {}), ...merged }
}

/**
 * Builds a SELECT column list from the parsed inputs. When no inputs are
 * specified, returns ['*'] (all scalar attributes).
 */
function buildColumnsFromInputs(inputsCSN, target) {
  const parsed = parseInputsArray(inputsCSN)
  if (parsed.length === 0) return [WILDCARD]
  const ctx = createRuntimeEntityContext(target)
  const tree = buildInputTree(parsed, ctx)
  return convertTreeToColumns(tree)
}

function createRuntimeEntityContext(entity) {
  return {
    getElement(name) {
      const element = entity?.elements?.[name]
      if (!element) return undefined
      const isAssocOrComp =
        element.type === 'cds.Association' || element.type === 'cds.Composition'
      const targetEntity = element._target
        ? createRuntimeEntityContext(element._target)
        : createRuntimeEntityContext(entity)
      return { isAssocOrComp, targetEntity }
    },
  }
}

function convertTreeToColumns(tree) {
  const columns = []
  for (const node of tree) {
    if (node.sourceElement === WILDCARD) {
      columns.push(WILDCARD)
      continue
    }
    const col = { ref: [node.sourceElement] }
    if (node.associatedInputElements !== undefined) {
      col.expand =
        node.associatedInputElements.length > 0
          ? convertTreeToColumns(node.associatedInputElements)
          : [WILDCARD]
    }
    columns.push(col)
  }
  return columns
}

/**
 * Fetches the entity row using the key values from the request data. For
 * DELETE events, we return the prefetched row (stashed by the before-DELETE
 * handler) — falling back to the incoming keys if no prefetch happened.
 *
 * When a conditional `.if` expression is present, it's ANDed onto the WHERE
 * clause — no row → skip trigger.
 */
async function resolveEntityRow(req, data, conditionExpr, columns) {
  if (req.event === 'DELETE') {
    return readPrefetchedRow(req, data) ?? data
  }

  if (!req.target || !req.target.keys) {
    // Actions / events with no entity context: just return the data.
    return data
  }

  const keyFields = Object.keys(req.target.keys).filter(
    (k) => !req.target.keys[k].virtual,
  )
  if (keyFields.length === 0) return data

  const where = buildWhereClause(keyFields, data, conditionExpr)
  if (!where) return data

  try {
    return await SELECT.one.from(req.target.name).columns(columns).where(where)
  } catch (err) {
    LOG.error(`Failed to fetch row for @n8n.trigger on ${req.target.name}:`, err.message ?? err)
    return undefined
  }
}

/**
 * Reads a row previously stashed by the DELETE prefetch handler. Keyed by the
 * annotation qualifier because the same entity may carry multiple triggers
 * with different `inputs` / `if` clauses, each needing its own projection.
 */
function readPrefetchedRow(req, data) {
  const stash = req.context?.[PREFETCH_KEY]
  if (!stash) return undefined
  return stash.get(prefetchStashKey(req.target?.name, data)) ?? undefined
}

/**
 * Builds a stable stash key for a given entity + key values. Ordering the
 * keys alphabetically keeps two DELETEs of the same row consistent.
 */
function prefetchStashKey(entityName, data) {
  if (!entityName || !data || typeof data !== 'object') return String(entityName ?? '')
  const parts = Object.keys(data)
    .sort()
    .map((k) => `${k}=${String(data[k])}`)
    .join('|')
  return `${entityName}#${parts}`
}

function buildWhereClause(keyFields, data, conditionExpr) {
  const parts = []
  for (const key of keyFields) {
    if (data?.[key] === undefined) return undefined
    if (parts.length) parts.push('and')
    parts.push({ ref: [key] }, '=', { val: data[key] })
  }
  if (parts.length === 0) return undefined
  if (conditionExpr) {
    return [{ xpr: parts }, 'and', { xpr: conditionExpr }]
  }
  return { xpr: parts }
}

/**
 * Shapes the final payload sent to n8n. When no explicit inputs are given, the
 * entire fetched row is sent as-is. When inputs are given, we already fetched
 * exactly those columns, so the row shape is already correct.
 */
function shapePayload(row, _inputsCSN) {
  if (row === null || row === undefined) return {}
  return row
}

async function emitTrigger(req, workflow, payload) {
  try {
    const n8n = await cds.connect.to(N8N_SERVICE)
    // When the N8nService kind has `outboxed` configured, cds.connect.to
    // already returns an outboxed proxy — .emit() persists the event in
    // the outbox (persistent queue by default) and dispatches it after the
    // caller's transaction commits.
    // When outbox is disabled (e.g. tests, console kind), emit runs
    // synchronously against the underlying service.
    await n8n.emit('trigger', { workflow, payload })
  } catch (err) {
    // Do not roll back the caller's transaction — trigger failure is a
    // side-effect issue, not a business-logic failure.
    LOG.error(
      `Failed to enqueue n8n trigger for workflow ${workflow}: ${err.message ?? err}`,
    )
  }
}

module.exports = {
  handleTrigger,
  buildColumnsFromInputs,
  prefetchStashKey,
  PREFETCH_KEY,
}
