const cds = require("@sap/cds")
const {
  collectTriggers,
  validateTriggerAnnotations,
  RuntimeReporter,
} = require("../shared/validations")
const { handleTrigger, prefetchForDelete } = require("./triggerHandler")

const LOG = cds.log("@cap-js/n8n")

function registerAnnotationHandlers(service) {
  // Validate all `@n8n.process.start` annotations
  const reporter = new RuntimeReporter(LOG)
  for (const entity of service.entities) {
    validateTriggerAnnotations(entity.name, entity, reporter, cds.model)
  }
  if (reporter.hasErrors) {
    throw new Error(
      `Invalid @n8n.process.start annotation(s) in service '${service.name}'. See log for details.`,
    )
  }

  // Register CAP handlers for the (now validated) annotations
  let count = 0
  const deleteAnnotationsByEntity = new Map()

  for (const entity of service.entities) {
    for (const ann of findAnnotations(entity)) {
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
   * Instead of counting, log like:
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
 * Yields handler descriptors for each `@n8n.process.start` trigger on `def`,
 * regardless of whether it was authored as a record or as array form. Triggers
 * with no `on` value are skipped (validation warns).
 *
 * Descriptor: `{ path, method, on, conditionExpr, inputs }`.
 */
function* findAnnotations(def) {
  for (const t of collectTriggers(def)) {
    if (t.itemInvalid) continue
    if (t.normalized.on.length === 0) continue
    yield {
      path: t.path,
      method: t.normalized.method,
      on: t.normalized.on,
      conditionExpr: t.normalized.conditionExpr,
      inputs: t.inputs,
    }
  }
}

module.exports = { registerAnnotationHandlers, findAnnotations }
