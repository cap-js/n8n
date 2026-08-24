const cds = require("@sap/cds")
const { N8N_PROCESS_START } = require("../constants")
const { normalizeHttpMethod } = require("../shared/http-methods")
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
    const row = Array.isArray(result)
      ? (result[0] ?? req.data)
      : result && Object.keys(result).length > 0
        ? result
        : req.data
    await handleTrigger(req, row, ann)
  }
}

/**
 * Walks the CSN definition looking for `@n8n.process.start[.subkey]`
 * annotations. Yields `{ path, method, on, conditionExpr, inputs }` descriptors.
 *
 * Handles two syntactic forms:
 *   - Record:    @n8n.process.start: { path, method, on, if, inputs }
 *   - Array:     @n8n.process.start: [{ path, method, on, if, inputs }, ...]
 * The array form supports multiple triggers on one entity.
 *
 * Missing `on` produces an empty `on` array and is skipped at registration
 * time (build validation reports a warning).
 * An explicit empty array `on: []` is a deliberate no-op — the annotation
 * is kept but registers no handlers.
 */
function* findAnnotations(def) {
  const hasRecordForm = ["path", "on", "if", "inputs"].some((suffix) =>
    Object.hasOwn(def, `${N8N_PROCESS_START}.${suffix}`),
  )
  if (hasRecordForm) {
    const record = getRecordAnnotation(def)
    if (record) yield record
    return
  }

  const val = def[N8N_PROCESS_START]
  if (Array.isArray(val)) {
    for (const item of yieldFromArrayItems(val)) {
      yield item
    }
  }
}

function getRecordAnnotation(def) {
  const path = def[`${N8N_PROCESS_START}.path`]
  if (typeof path !== "string") return undefined
  const on = normalizeOn(def[`${N8N_PROCESS_START}.on`])
  if (on.length === 0) return undefined
  return {
    path,
    method: normalizeHttpMethod(def[`${N8N_PROCESS_START}.method`]) ?? "POST",
    on,
    conditionExpr: def[`${N8N_PROCESS_START}.if`]?.xpr,
    inputs: def[`${N8N_PROCESS_START}.inputs`],
  }
}

function* yieldFromArrayItems(items) {
  for (const [idx, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const path = item.path
    if (typeof path !== "string") continue
    const rawOn = item.on
    if (rawOn == null) {
      LOG.warn(`${N8N_PROCESS_START}[${idx}]: 'on' is required; this trigger will be skipped.`)
      continue
    }
    const on = normalizeOn(rawOn)
    if (on.length === 0) continue // explicit on: [] → skip
    yield {
      path,
      method: normalizeHttpMethod(item.method) ?? "POST",
      on,
      conditionExpr: item.if?.xpr,
      inputs: item.inputs,
    }
  }
}

function normalizeOn(raw) {
  if (raw == null) return []
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string")
  return []
}

module.exports = { registerAnnotationHandlers, findAnnotations }
