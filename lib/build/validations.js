const cds = require("@sap/cds")
const { N8N_PROCESS_START } = require("../constants")
const { HTTP_METHODS, normalizeHttpMethod } = require("../shared/http-methods")

const ALLOWED_SUFFIXES = ["path", "method", "on", "if", "inputs"]

// Terminal color helpers from CAP's public `cds.utils.colors` API. 
// Constants collapse to empty strings when the terminal doesn't support ANSI colors
const { BOLD, CYAN, YELLOW, RESET } = cds.utils.colors
const bold = (s) => `${BOLD}${s}${RESET}`
const cyan = (s) => `${CYAN}${s}${RESET}`
const yellow = (s) => `${YELLOW}${s}${RESET}`

// Renders `@n8n.process.start for path 'x':` with the annotation cyan and the path value yellow
function annCtx(ann, path) {
  return path ? `${cyan(ann)} for path ${yellow(`'${path}'`)}:` : `${cyan(ann)}:`
}

/**
 * Validates `@n8n.process.start` shapes on a single entity and event definition
 */
function validateTriggerAnnotations(entityName, def, plugin) {
  const { ERROR, WARNING } = plugin.constructor

  // Push through the public API + add definition location if available
  const push = (severity, msg) => {
    plugin.pushMessage(`${bold(entityName)} - ${msg}`, severity)
    if (def.$location) {
      const last = plugin.messages[plugin.messages.length - 1]
      if (last) last.$location = def.$location
    }
  }
  const error = (msg) => push(ERROR, msg)
  const warn = (msg) => push(WARNING, msg)

  // Validates one element of an array-form annotation
  // (e.g. `@n8n.process.start: [{ ... }]`).
  // Uses the item's `path` (the user-authored trigger id) as the reference
  // in messages rather than the internal array index. Falls back to
  // `@n8n.process.start` alone when the path itself is missing/invalid.
  function validateArrayItem(ann, idx, item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      error(`${cyan(ann)}: array element #${idx + 1} must be an object with at least a .path key.`)
      return
    }

    const hasValidPath = typeof item.path === "string" && item.path.trim() !== ""
    const ctx = annCtx(ann, hasValidPath ? item.path : null)

    for (const k of Object.keys(item)) {
      if (!ALLOWED_SUFFIXES.includes(k)) {
        warn(`${ctx} unknown key '${k}'. Allowed: ${ALLOWED_SUFFIXES.map((s) => `.${s}`).join(", ")}.`)
      }
    }

    if (!hasValidPath) {
      error(`${cyan(ann)}: .path is required and must be a non-empty string (array element #${idx + 1}).`)
    }

    validateMethod(item.method, `${ctx} ${cyan(".method")}`)

    if (item.on === undefined) {
      warn(`${ctx} ${cyan(".on")} is required. Trigger will be skipped.`)
    } else {
      validateItemOn(item.on, ctx)
    }

    if (item.if !== undefined && (typeof item.if !== "object" || !("xpr" in item.if))) {
      error(`${ctx} ${cyan(".if")} must be a CDS expression.`)
    }

    if (item.inputs !== undefined) validateItemInputs(item.inputs, ctx)
  }

  function validateItemOn(on, ctx) {
    if (typeof on !== "string" && !Array.isArray(on)) {
      error(`${ctx} ${cyan(".on")} must be a string or an array of strings.`)
      return
    }
    const onList = Array.isArray(on) ? on : [on]
    for (const ev of onList) {
      if (typeof ev !== "string" || ev.trim() === "") {
        error(`${ctx} ${cyan(".on")} values must be non-empty strings.`)
      }
    }
  }

  function validateItemInputs(inputs, ctx) {
    if (!Array.isArray(inputs)) {
      error(`${ctx} ${cyan(".inputs")} must be an array of input mappings.`)
      return
    }
    for (const entry of inputs) {
      if (!entry || typeof entry !== "object") {
        error(`${ctx} ${cyan(".inputs")}: each entry must be an object.`)
        continue
      }
      if (!("=" in entry)) {
        error(
          `${ctx} ${cyan(".inputs")}: each entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
        )
      }
    }
  }

  function validateMethod(method, annotation) {
    if (method === undefined) return
    if (!normalizeHttpMethod(method)) {
      error(`${annotation} must be one of ${HTTP_METHODS.join(", ")}.`)
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
    error(`${cyan(key)}: string shorthand is no longer supported; use the record form with .path and .on.`)
  }

  const prefix = N8N_PROCESS_START
  const pathKey = `${prefix}.path`
  const methodKey = `${prefix}.method`
  const onKey = `${prefix}.on`
  const ifKey = `${prefix}.if`
  const inputsKey = `${prefix}.inputs`

  const hasRecordForm = [pathKey, methodKey, onKey, ifKey, inputsKey].some((key) => key in def)
  if (!hasRecordForm) return

  // Warn about unknown sub-keys.
  for (const key of Object.keys(def)) {
    if (!key.startsWith(`${prefix}.`)) continue
    const suffix = key.slice(prefix.length + 1).split(".")[0]
    if (!ALLOWED_SUFFIXES.includes(suffix)) {
      warn(`${cyan(key)}: unknown sub-key. Allowed: ${ALLOWED_SUFFIXES.map((s) => `.${s}`).join(", ")}.`)
    }
  }

  const hasPath = def[pathKey] !== undefined
  const hasOn = def[onKey] !== undefined

  // Record form requires both `path` and `on`.
  if (!hasPath) {
    error(`${cyan(pathKey)} is required${hasOn ? ` (found only ${cyan(onKey)})` : ""}.`)
    return
  }

  if (!hasOn) {
    error(`${cyan(onKey)} is required.`)
  }

  // path must be a non-empty string.
  if (typeof def[pathKey] !== "string" || def[pathKey].trim() === "") {
    error(`${cyan(pathKey)} must be a non-empty string.`)
  }

  // on: shape-check only when provided. Values are forwarded verbatim to
  // `service.after` — CAP validates event names at handler-registration
  // time. An explicit empty array `[]` means "disabled".
  if (hasOn) {
    const onValue = def[onKey]
    if (typeof onValue !== "string" && !Array.isArray(onValue)) {
      error(`${cyan(onKey)} must be a string or an array of strings.`)
    } else {
      const onList = Array.isArray(onValue) ? onValue : [onValue]
      for (const ev of onList) {
        if (typeof ev !== "string" || ev.trim() === "") {
          error(`${cyan(onKey)} values must be non-empty strings.`)
        }
      }
    }
  }

  validateMethod(def[methodKey], cyan(methodKey))

  // if: must have an .xpr shape when present.
  if (def[ifKey] !== undefined) {
    if (typeof def[ifKey] !== "object" || !("xpr" in def[ifKey])) {
      error(`${cyan(ifKey)} must be a CDS expression.`)
    }
  }

  // inputs: must be an array when present.
  if (def[inputsKey] !== undefined) {
    if (!Array.isArray(def[inputsKey])) {
      error(`${cyan(inputsKey)} must be an array of input mappings.`)
    } else {
      for (const entry of def[inputsKey]) {
        if (!entry || typeof entry !== "object") {
          error(`${cyan(inputsKey)}: each entry must be an object.`)
          continue
        }
        if (!("=" in entry)) {
          error(
            `${cyan(inputsKey)}: each entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
          )
        }
      }
    }
  }
}

module.exports = {
  validateTriggerAnnotations,
}
