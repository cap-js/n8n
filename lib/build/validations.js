const { N8N_PROCESS_START } = require("../constants")
const { HTTP_METHODS, normalizeHttpMethod } = require("../shared/http-methods")

const ALLOWED_SUFFIXES = ["path", "method", "on", "if", "inputs"]

/**
 * Validates `@n8n.process.start` shapes on a single entity definition.
 * Reports issues via `plugin.pushMessage(msg, severity)` using the
 * `Plugin.ERROR` / `Plugin.WARNING` constants exposed on `cds.build.Plugin`.
 * When those constants are absent (older cds-dk, unit-test doubles) we fall
 * back to the string literals the pluginmanager also accepts.
 */
function validateTriggerAnnotations(entityName, def, plugin) {
  const { ERROR, WARNING } = plugin.constructor

  const error = (msg) => plugin.pushMessage(`${entityName} - ${msg}`, ERROR)
  const warn = (msg) => plugin.pushMessage(`${entityName} - ${msg}`, WARNING)

  // Validates one element of an array-form annotation
  // (e.g. `@n8n.process.start: [{ ... }]`).
  function validateArrayItem(ann, idx, item) {
    const ref = `${ann}[${idx}]`

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      error(`${ref}: each array element must be an object with at least a 'path' key.`)
      return
    }

    for (const k of Object.keys(item)) {
      if (!ALLOWED_SUFFIXES.includes(k)) {
        warn(`${ref}: unknown key '${k}'. Allowed: ${ALLOWED_SUFFIXES.join(", ")}.`)
      }
    }

    if (typeof item.path !== "string" || item.path.trim() === "") {
      error(`${ref}: 'path' is required and must be a non-empty string.`)
    }

    validateMethod(item.method, ref)

    if (item.on === undefined) {
      warn(`${ref}: 'on' is required; this trigger will be skipped.`)
    } else {
      validateItemOn(item.on, ref)
    }

    if (item.if !== undefined && (typeof item.if !== "object" || !("xpr" in item.if))) {
      error(`${ref}: 'if' must be a CDS expression.`)
    }

    if (item.inputs !== undefined) validateItemInputs(item.inputs, ref)
  }

  function validateItemOn(on, ref) {
    if (typeof on !== "string" && !Array.isArray(on)) {
      error(`${ref}: 'on' must be a string or an array of strings.`)
      return
    }
    const onList = Array.isArray(on) ? on : [on]
    for (const ev of onList) {
      if (typeof ev !== "string" || ev.trim() === "") {
        error(`${ref}: 'on' values must be non-empty strings.`)
      }
    }
  }

  function validateItemInputs(inputs, ref) {
    if (!Array.isArray(inputs)) {
      error(`${ref}: 'inputs' must be an array of input mappings.`)
      return
    }
    for (const entry of inputs) {
      if (!entry || typeof entry !== "object") {
        error(`${ref}: each 'inputs' entry must be an object.`)
        continue
      }
      if (!("=" in entry)) {
        error(
          `${ref}: each 'inputs' entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
        )
      }
    }
  }

  function validateMethod(method, annotation) {
    if (method === undefined) return
    if (!normalizeHttpMethod(method)) {
      error(`${annotation}: must be one of ${HTTP_METHODS.join(", ")}.`)
    }
  }

  // Plain-string annotations are not supported. Require the record form
  // or array-form so every trigger declares its event explicitly.
  for (const key of Object.keys(def)) {
    if (!key.startsWith(N8N_PROCESS_START)) continue
    if (key.includes(".", N8N_PROCESS_START.length)) continue
    const shorthand = def[key]
    if (Array.isArray(shorthand)) {
      shorthand.forEach((item, idx) => validateArrayItem(key, idx, item))
      continue
    }
    if (typeof shorthand !== "string") continue
    error(
      `${key}: string shorthand is no longer supported; use the record form with .path and .on.`,
    )
  }

  const prefix = N8N_PROCESS_START
  const pathKey = `${prefix}.path`
  const methodKey = `${prefix}.method`
  const onKey = `${prefix}.on`
  const ifKey = `${prefix}.if`
  const inputsKey = `${prefix}.inputs`

  const hasRecordForm = Object.keys(def).some(
    (key) =>
      key === pathKey || key === methodKey || key === onKey || key === ifKey || key === inputsKey,
  )
  if (!hasRecordForm) return

  // Warn about unknown sub-keys.
  for (const key of Object.keys(def)) {
    if (!key.startsWith(`${prefix}.`)) continue
    const suffix = key.slice(prefix.length + 1).split(".")[0]
    if (!ALLOWED_SUFFIXES.includes(suffix)) {
      warn(`${key}: unknown sub-key. Allowed: ${ALLOWED_SUFFIXES.map((s) => `.${s}`).join(", ")}.`)
    }
  }

  const hasPath = def[pathKey] !== undefined
  const hasOn = def[onKey] !== undefined

  // Record form requires both `path` and `on`.
  if (!hasPath) {
    error(`${prefix}: ${pathKey} is required${hasOn ? ` (found only ${onKey})` : ""}.`)
    return
  }

  if (!hasOn) {
    error(`${prefix}: ${onKey} is required.`)
  }

  // path must be a non-empty string.
  if (typeof def[pathKey] !== "string" || def[pathKey].trim() === "") {
    error(`${pathKey}: must be a non-empty string.`)
  }

  // on: shape-check only when provided. Values are forwarded verbatim to
  // `service.after` — CAP validates event names at handler-registration
  // time. An explicit empty array `[]` means "disabled".
  if (hasOn) {
    const onValue = def[onKey]
    if (typeof onValue !== "string" && !Array.isArray(onValue)) {
      error(`${onKey}: must be a string or an array of strings.`)
    } else {
      const onList = Array.isArray(onValue) ? onValue : [onValue]
      for (const ev of onList) {
        if (typeof ev !== "string" || ev.trim() === "") {
          error(`${onKey}: values must be non-empty strings.`)
        }
      }
    }
  }

  validateMethod(def[methodKey], methodKey)

  // if: must have an .xpr shape when present.
  if (def[ifKey] !== undefined) {
    if (typeof def[ifKey] !== "object" || !("xpr" in def[ifKey])) {
      error(`${ifKey}: must be a CDS expression.`)
    }
  }

  // inputs: must be an array when present.
  if (def[inputsKey] !== undefined) {
    if (!Array.isArray(def[inputsKey])) {
      error(`${inputsKey}: must be an array of input mappings.`)
    } else {
      for (const entry of def[inputsKey]) {
        if (!entry || typeof entry !== "object") {
          error(`${inputsKey}: each entry must be an object.`)
          continue
        }
        if (!("=" in entry)) {
          error(
            `${inputsKey}: each entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
          )
        }
      }
    }
  }
}

module.exports = {
  validateTriggerAnnotations,
}
