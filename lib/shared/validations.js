const cds = require("@sap/cds")
const { N8N_PROCESS_START } = require("../constants")
const { HTTP_METHODS, normalizeHttpMethod } = require("./http-methods")

const ALLOWED_KEYS = ["path", "method", "on", "if", "inputs"]

const { BOLD, CYAN, YELLOW, RED, RESET } = cds.utils.colors
const bold = (s) => `${BOLD}${s}${RESET}`
const cyan = (s) => `${CYAN}${s}${RESET}`
const yellow = (s) => `${YELLOW}${s}${RESET}`
const red = (s) => `${RED}${s}${RESET}`

// Severity constants — align with cds.build.Plugin's static ERROR/WARNING strings.
const SEVERITY = Object.freeze({ ERROR: "Error", WARNING: "Warning" })

/**
 * Validates `@n8n.process.start` shapes on a single entity/event definition.
 *
 * Handles two CSN shapes uniformly:
 *   - Array form:  def["@n8n.process.start"] = [{...}, {...}]
 *   - Record form: def["@n8n.process.start.path"] = ..., etc.
 *
 * Both are normalized to a common trigger shape and then validated by a
 * single set of rules, so severity/wording decisions live in one place.
 *
 */
function validateTriggerAnnotations(entityName, def, reporter, model) {
  const { ERROR, WARNING } = reporter.constructor

  const push = (severity, msg) => {
    reporter.pushMessage(`${bold(entityName)} - ${msg}`, severity)
    if (def.$location) {
      const last = reporter.messages[reporter.messages.length - 1]
      if (last) last.$location = def.$location
    }
  }
  const error = (msg) => push(ERROR, msg)
  const warn = (msg) => push(WARNING, msg)

  // Collect triggers into a common shape
  const triggers = collectTriggers(def)
  if (triggers.length === 0) return

  // Validate each trigger with a single rule set
  for (const t of triggers) validateTrigger(t)

  function validateTrigger(t) {
    // Structural failures (non-object array item) reported here directly.
    if (t.itemInvalid) {
      error(`${cyan(t.ann)}: array element #${t.idx + 1} must be an object with a .path key.`)
      return
    }

    // Unknown keys → warning
    for (const k of t.unknownKeys) {
      warn(`${t.ref} unknown key '${k}'. Allowed: ${ALLOWED_KEYS.map((s) => `.${s}`).join(", ")}.`)
    }

    // path is required and must be a non-empty string.
    // Disambiguate by array index only when the path (our normal identifier)
    // is missing — otherwise `ref` already carries `for path '<x>'`.
    const hasValidPath = typeof t.path === "string" && t.path.trim() !== ""
    if (!hasValidPath) {
      const suffix = t.arrayForm ? ` (array element #${t.idx + 1})` : ""
      error(`${t.ref} ${cyan(".path")} is required and must be a non-empty string.${suffix}`)
    }

    // method (optional): must be a supported HTTP method
    if (t.method !== undefined && !normalizeHttpMethod(t.method)) {
      error(`${t.ref} ${cyan(".method")} must be one of ${HTTP_METHODS.join(", ")}.`)
    }

    // on: required (warning; missing .on means trigger is skipped at runtime)
    if (t.on === undefined) {
      warn(`${t.ref} ${cyan(".on")} is required. Trigger will be skipped.`)
    } else {
      if (typeof t.on !== "string" && !Array.isArray(t.on)) {
        error(`${t.ref} ${cyan(".on")} must be a string or an array of strings.`)
        return
      }
      const list = Array.isArray(t.on) ? t.on : [t.on]
      for (const ev of list) {
        if (typeof ev !== "string" || ev.trim() === "") {
          error(`${t.ref} ${cyan(".on")} values must be non-empty strings.`)
        }
      }
    }

    // if (optional): must be a CDS expression ({ xpr: [ ... ] }) with a
    // non-empty array. Anything else is silently ignored at runtime, so warn.
    if (t.if !== undefined) {
      const ifOk =
        t.if && typeof t.if === "object" && Array.isArray(t.if.xpr) && t.if.xpr.length > 0
      if (!ifOk) {
        warn(`${t.ref} ${cyan(".if")} must be a CDS expression. Condition will be ignored.`)
      }
    }

    // inputs (optional): array of { '=': '$self.…' } mappings
    if (t.inputs !== undefined) validateInputs(t.inputs, t.ref)
  }

  function validateInputs(inputs, ref) {
    if (!Array.isArray(inputs)) {
      error(`${ref} ${cyan(".inputs")} must be an array of input mappings.`)
      return
    }
    for (const entry of inputs) {
      if (!entry || typeof entry !== "object") {
        error(`${ref} ${cyan(".inputs")}: each entry must be an object.`)
        continue
      }
      if (!("=" in entry)) {
        error(
          `${ref} ${cyan(".inputs")}: each entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
        )
        continue
      }
      validateInputPath(entry["="], ref)
    }
  }

  function validateInputPath(raw, ref) {
    // Reject non-$self paths
    if (typeof raw !== "string" || (raw !== "$self" && !raw.startsWith("$self."))) {
      error(`${ref} ${cyan(".inputs")}: input path '${raw}' must start with '$self.'.`)
      return
    }
    if (!def.elements || !model?.definitions) return
    if (raw === "$self") return
    const segments = raw.slice("$self.".length).split(".")

    let entity = def
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const isLast = i === segments.length - 1
      const el = entity.elements?.[seg]
      if (!el) {
        error(`${ref} ${cyan(".inputs")}: input path '${raw}' refers to unknown element '${seg}'.`)
        return
      }
      // Non-last segment must be an association/composition.
      if (!isLast) {
        if (el.type !== "cds.Association" && el.type !== "cds.Composition") {
          error(
            `${ref} ${cyan(".inputs")}: input path '${raw}': '${seg}' is not an association/composition; cannot traverse into it.`,
          )
          return
        }
        const target = el.target && model.definitions[el.target]
        if (!target) return // target unresolvable — bail without further checks
        entity = target
      }
    }
  }
}

/**
 * Reads all `@n8n.process.start[.…]` annotations on `def` and returns a flat
 * list of normalized triggers, hiding the record-vs-array CSN distinction.
 *
 * Each returned trigger has:
 *   - path, method, on, if, inputs — the user's raw values (may be undefined)
 *   - normalized  - { method, on, conditionExpr } derived for handler use.
 *                   `method` is uppercased or "POST" if unrecognized/absent.
 *                   `on` is always a string array (possibly empty).
 *                   `conditionExpr` is `if.xpr` if it's a non-empty array.
 *   - ref          - preformatted, colored context string for messages
 *   - ann          - the raw annotation key (e.g. "@n8n.process.start")
 *   - arrayForm    - true when the trigger came from an array element
 *   - idx          - 0-based index within an array-form annotation, else 0
 *   - unknownKeys  - keys present that aren't in ALLOWED_KEYS
 *   - itemInvalid  - true when the array element itself isn't a plain object
 */
function collectTriggers(def) {
  const prefix = N8N_PROCESS_START
  const triggers = []

  // Array form: def["@n8n.process.start"] is an array of trigger objects.
  const arr = def[prefix]
  if (Array.isArray(arr)) {
    arr.forEach((item, idx) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        triggers.push({ ann: prefix, idx, itemInvalid: true })
        return
      }
      const hasPath = typeof item.path === "string" && item.path.trim() !== ""
      triggers.push({
        ann: prefix,
        idx,
        arrayForm: true,
        ref: annCtx(prefix, hasPath ? item.path : null),
        path: item.path,
        method: item.method,
        on: item.on,
        if: item.if,
        inputs: item.inputs,
        unknownKeys: Object.keys(item).filter((k) => !ALLOWED_KEYS.includes(k)),
        normalized: normalize(item.method, item.on, item.if),
      })
    })
  }

  // Record form: def["@n8n.process.start.path"], .method, .on, .if, .inputs.
  // Only these five exact subkeys count as "record form". Anything else under
  // the prefix (including deeper dotted paths like `.on.foo`) is unknown.
  const record = {}
  const unknownKeys = []
  let hasRecord = false
  for (const key of Object.keys(def)) {
    if (!key.startsWith(`${prefix}.`)) continue
    const suffix = key.slice(prefix.length + 1)
    if (ALLOWED_KEYS.includes(suffix)) {
      record[suffix] = def[key]
      hasRecord = true
    } else {
      unknownKeys.push(suffix)
      hasRecord = true
    }
  }

  if (hasRecord) {
    const hasPath = typeof record.path === "string" && record.path.trim() !== ""
    triggers.push({
      ann: prefix,
      idx: 0,
      arrayForm: false,
      ref: annCtx(prefix, hasPath ? record.path : null),
      path: record.path,
      method: record.method,
      on: record.on,
      if: record.if,
      inputs: record.inputs,
      unknownKeys,
      normalized: normalize(record.method, record.on, record.if),
    })
  }

  return triggers
}

function normalize(method, on, ifExpr) {
  const xpr = ifExpr && typeof ifExpr === "object" ? ifExpr.xpr : undefined
  return {
    method: normalizeHttpMethod(method) ?? "POST",
    on: normalizeOn(on),
    conditionExpr: Array.isArray(xpr) && xpr.length > 0 ? xpr : undefined,
  }
}

function normalizeOn(raw) {
  if (raw == null) return []
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string")
  return []
}

function annCtx(ann, path) {
  return path ? `${cyan(ann)} for path ${yellow(`'${path}'`)}:` : `${cyan(ann)}:`
}

// Logging for runtime validation
class RuntimeReporter {
  static ERROR = SEVERITY.ERROR
  static WARNING = SEVERITY.WARNING

  constructor(log = cds.log("@cap-js/n8n")) {
    this.log = log
    this.messages = []
  }

  pushMessage(message, severity) {
    this.messages.push({ severity, message })
    if (severity === SEVERITY.ERROR) this.log.error(`${bold(red("ERROR"))} ${message}`)
    else if (severity === SEVERITY.WARNING) this.log.warn(`${bold(yellow("WARN"))}  ${message}`)
    else this.log.info(message)
  }

  get hasErrors() {
    return this.messages.some((m) => m.severity === SEVERITY.ERROR)
  }
}

module.exports = {
  validateTriggerAnnotations,
  collectTriggers,
  RuntimeReporter,
}
