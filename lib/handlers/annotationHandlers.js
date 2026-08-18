const cds = require("@sap/cds")
const { N8N_PROCESS_START } = require("../constants")
const { handleTrigger, prefetchForDelete } = require("./triggerHandler")

const LOG = cds.log("@cap-js/n8n")

function registerAnnotationHandlers(service) {
  let count = 0
  const deleteAnnotationsByEntity = new Map()

  for (const entity of service.entities) {
    for (const ann of findAnnotations(entity)) {
      if (ann.on.length === 0) continue
      if (ann.on.includes("DELETE") || ann.on.includes("*")) {
        const list = deleteAnnotationsByEntity.get(entity) ?? []
        list.push(ann)
        deleteAnnotationsByEntity.set(entity, list)
      }
      service.after(ann.on, entity, buildAfterHandler(ann))
      count += ann.on.length
    }
  }

  // One before-DELETE hook per entity captures each trigger's selected state.
  for (const [entity, annotations] of deleteAnnotationsByEntity) {
    service.before("DELETE", entity, (req) => prefetchForDelete(req, entity, annotations))
  }

  /**
   * Instead of counting, a log like
   * Register triggerWorkflow handler in <service> for:
   * [{entity: entityName, event: events}, ..., {}]
   */
  if (count > 0) {
    LOG.debug(`Registered ${count} @n8n.process.start handler(s) for service ${service.name}`)
  }
}

function buildAfterHandler(ann) {
  return async (result, req) => {
    const row = Array.isArray(result) ? result[0] : (result ?? req.data)
    await handleTrigger(req, row, ann)
  }
}

/**
 * Walks the CSN definition looking for `@n8n.process.start[#qualifier][.subkey]`
 * annotations. Yields `{ path, on, conditionExpr, inputs }` descriptors.
 *
 * Handles the record form: `@n8n.process.start: { path, on, if, inputs }`.
 * Qualified annotations such as `@n8n.process.start#foo` are supported.
 *
 * `on` is required. An explicit empty array `on: []` is a deliberate no-op —
 * the annotation is kept but registers no handlers.
 */
function* findAnnotations(def) {
  const byPrefix = new Map()
  for (const key of Object.keys(def)) {
    if (!key.startsWith(N8N_PROCESS_START)) continue
    const dot = key.indexOf(".", N8N_PROCESS_START.length)
    const prefix = dot === -1 ? key : key.slice(0, dot)
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, false)
    if (dot !== -1) byPrefix.set(prefix, true) // has sub-keys → record form
  }

  for (const [prefix, hasSubkeys] of byPrefix) {
    if (hasSubkeys) {
      const path = def[`${prefix}.path`]
      if (typeof path !== "string") continue
      const rawOn = def[`${prefix}.on`]
      const on = normalizeOn(rawOn)
      if (on.length === 0) continue // explicit `on: []` → skip
      yield {
        path,
        on,
        conditionExpr: def[`${prefix}.if`]?.xpr,
        inputs: def[`${prefix}.inputs`],
      }
      continue
    }
  }
}

function normalizeOn(raw) {
  if (raw == null) return []
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string")
  return []
}

module.exports = { registerAnnotationHandlers }
