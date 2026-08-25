const cds = require("@sap/cds")
const { parseInputsArray, buildInputTree, WILDCARD } = require("../shared/input-parser")

const LOG = cds.log("n8n")

const { SELECT } = cds.ql

// Symbol used to stash prefetched DELETE rows on the request context. Not a
// plain string to avoid clashing with any application-level bookkeeping.
const PREFETCH_KEY = Symbol.for("@cap-js/n8n:delete-prefetch")

/**
 * Executes a single @n8n.process.start annotation for a given request + row.
 * 1. Merge request data with action params (for bound actions).
 * 2. Fetch the row (or read the stash on DELETE).
 * 3. Evaluate the .if condition (via the WHERE clause).
 * 4. Send `trigger` on the outboxed n8n service.
 */
async function handleTrigger(req, data, annotation) {
  const entityData = mergeParams(data, req.params)
  const columns = buildColumnsFromInputs(annotation.inputs, req.target)
  const row = await resolveEntityRow(req, entityData, annotation, columns)
  if (row === undefined) return
  await sendTrigger(annotation.path, row, annotation.method)
}

/**
 * Prefetch handler for DELETE. Each annotation is queried separately so its
 * condition and input mapping also apply to the pre-delete state.
 */
async function prefetchForDelete(req, entity, annotations) {
  const keyFields = Object.keys(entity.keys ?? {}).filter((k) => !entity.keys[k].virtual)
  if (keyFields.length === 0) return

  const where = buildKeyWhere(keyFields, req.data)
  if (!where) return

  const stash = (req.context[PREFETCH_KEY] ??= new Map())
  const rows = new Map()
  await Promise.all(
    annotations.map(async (annotation) => {
      const columns = buildColumnsFromInputs(annotation.inputs, entity)
      const condition = annotation.conditionExpr
        ? [{ xpr: where.xpr }, "and", { xpr: annotation.conditionExpr }]
        : where
      try {
        const row = await req.tx.run(SELECT.one.from(entity.name).columns(columns).where(condition))
        if (row) rows.set(annotation, row)
      } catch (err) {
        LOG.error(
          `Failed to prefetch row for DELETE trigger on ${entity.name}:`,
          err.message ?? err,
        )
      }
    }),
  )
  if (rows.size > 0) stash.set(prefetchStashKey(entity.name, req.data), rows)
}

/**
 * Merges CAP req.data with any additional action params. Bound actions expose
 * the target row's keys via req.params; unbound actions carry inputs in data.
 */
function mergeParams(data, params) {
  if (!params || !Array.isArray(params) || params.length === 0) return data ?? {}
  const merged = params.reduce((acc, p) => {
    if (p && typeof p === "object") return { ...acc, ...p }
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
      const isAssocOrComp = element.type === "cds.Association" || element.type === "cds.Composition"
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
 * Fetches the entity row using the key values. On DELETE, returns the
 * prefetched row (stashed by the before-handler) - falling back to the
 * incoming keys if no prefetch happened.
 *
 * When a conditional `.if` expression is present, it's ANDed onto the WHERE
 * clause - no row -> skip trigger.
 */
async function resolveEntityRow(req, data, annotation, columns) {
  if (req.event === "DELETE") {
    return readPrefetchedRow(req, data, annotation)
  }

  if (!req.target || !req.target.keys) return data

  const keyFields = Object.keys(req.target.keys).filter((k) => !req.target.keys[k].virtual)
  if (keyFields.length === 0) return data

  const where = buildWhereClause(keyFields, data, annotation.conditionExpr)
  if (!where) return data

  // On READ we must not re-select via req.tx: that would dispatch through
  // the application service and re-enter this same after('READ') handler,
  // causing unbounded recursion. cds.db.run() goes to the persistence
  // service directly and joins the request's ambient transaction (via
  // cds.context), so no separate tx lifecycle to manage.
  // REVISIT: check if we could always use cds.db.run (inputs/if resolved for service level projections)
  let runner
  if (req.event === "READ") {
    if (!cds.db) {
      // No persistence layer to safely re-select against; fall back to the
      // row the framework already fetched (skips `.if` and `inputs`).
      return data && typeof data === "object" ? data : undefined
    }
    runner = cds.db
  } else {
    runner = req.tx
  }

  try {
    return await runner.run(SELECT.one.from(req.target.name).columns(columns).where(where))
  } catch (err) {
    LOG.error(
      `Failed to fetch row for @n8n.process.start on ${req.target.name}:`,
      err.message ?? err,
    )
    return undefined
  }
}

function readPrefetchedRow(req, data, annotation) {
  const stash = req.context?.[PREFETCH_KEY]
  if (!stash) return undefined
  return stash.get(prefetchStashKey(req.target?.name, data))?.get(annotation)
}

// Stable stash key. JSON so key values containing separator characters
// (`|`, `=`) do not collide.
function prefetchStashKey(entityName, data) {
  if (!entityName || !data || typeof data !== "object") return String(entityName ?? "")
  const sorted = Object.keys(data)
    .sort()
    .map((k) => [k, data[k]])
  return `${entityName}#${JSON.stringify(sorted)}`
}

function buildKeyWhere(keyFields, data) {
  const parts = []
  for (const key of keyFields) {
    if (data?.[key] === undefined) return undefined
    if (parts.length) parts.push("and")
    parts.push({ ref: [key] }, "=", { val: data[key] })
  }
  return parts.length ? { xpr: parts } : undefined
}

function buildWhereClause(keyFields, data, conditionExpr) {
  const parts = []
  for (const key of keyFields) {
    if (data?.[key] === undefined) return undefined
    if (parts.length) parts.push("and")
    parts.push({ ref: [key] }, "=", { val: data[key] })
  }
  if (parts.length === 0) return undefined
  if (conditionExpr) {
    return [{ xpr: parts }, "and", { xpr: conditionExpr }]
  }
  return { xpr: parts }
}

async function sendTrigger(path, payload, method) {
  const n8n = await cds.connect.to("n8n")
  try {
    await n8n.trigger({ path, method, payload })
  } catch (err) {
    LOG.error(`Failed to enqueue n8n trigger for path ${path}: ${err.message ?? err}`)
    throw err
  }
}

module.exports = {
  handleTrigger,
  prefetchForDelete,
}
