const cds = require("@sap/cds")
const { N8N_PROCESS_START } = require("../constants")
const { HTTP_METHODS, normalizeHttpMethod } = require("../shared/http-methods")

const ALLOWED_KEYS = ["path", "method", "on", "if", "inputs"]

// Terminal color helpers from CAP's public `cds.utils.colors` API.
// Constants collapse to empty strings when the terminal doesn't support ANSI colors.
const { BOLD, CYAN, YELLOW, RESET } = cds.utils.colors
const bold = (s) => `${BOLD}${s}${RESET}`
const cyan = (s) => `${CYAN}${s}${RESET}`
const yellow = (s) => `${YELLOW}${s}${RESET}`

/**
 * Validates `@n8n.process.start` shapes on a single entity/event definition
 *
 * Handles two CSN shapes uniformly:
 *   - Array form:  def["@n8n.process.start"] = [{...}, {...}]
 *   - Record form: def["@n8n.process.start.path"] = ..., etc.
 *
 * Both are normalized to a common trigger shape and then validated by a
 * single set of rules, so severity/wording decisions live in one place.
 */
function validateTriggerAnnotations(entityName, def, plugin) {
  const { ERROR, WARNING } = plugin.constructor

  const push = (severity, msg) => {
    plugin.pushMessage(`${bold(entityName)} - ${msg}`, severity)
    if (def.$location) {
      const last = plugin.messages[plugin.messages.length - 1]
      if (last) last.$location = def.$location
    }
  }
  const error = (msg) => push(ERROR, msg)
  const warn = (msg) => push(WARNING, msg)

  // ── 1. Report legacy string shorthand (still an error) ─────────────────


  // ── 2. Collect triggers into a common shape ────────────────────────────
  const triggers = collectTriggers(def)
  if (triggers.length === 0) return

  // ── 3. Validate each trigger with a single rule set ────────────────────
  for (const t of triggers) validateTrigger(t)

  function validateTrigger(t) {
    // Structural failures (non-object array item) reported here directly.
    if (t.itemInvalid) {
      error(`${cyan(t.ann)}: array element #${t.idx + 1} must be an object with a .path key.`)
      return
    }

    // Unknown keys → warning
    for (const k of t.unknownKeys) {
      warn(
        `${t.ref} unknown key '${k}'. Allowed: ${ALLOWED_KEYS.map((s) => `.${s}`).join(", ")}.`,
      )
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

    // if (optional): must be a CDS expression ({ xpr: [...] })
    if (t.if !== undefined && (typeof t.if !== "object" || !("xpr" in t.if))) {
      warn(`${t.ref} ${cyan(".if")} must be a CDS expression. Condition will be ignored.`)
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
 *   - ref          - preformatted, colored context string for messages
 *   - ann          - the raw annotation key (e.g. "@n8n.process.start")
 *   - idx          - 0-based index within an array-form annotation, else 0
 *   - unknownKeys  - keys present on an array item that aren't in ALLOWED_KEYS
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
      })
    })
  }

  // Record form: def["@n8n.process.start.path"], .method, .on, .if, .inputs
  const dotted = ALLOWED_KEYS.map((k) => `${prefix}.${k}`)
  const hasRecord = dotted.some((k) => k in def)
  if (hasRecord) {
    const hasPath = typeof def[`${prefix}.path`] === "string" && def[`${prefix}.path`].trim() !== ""
    triggers.push({
      ann: prefix,
      idx: 0,
      arrayForm: false,
      ref: annCtx(prefix, hasPath ? def[`${prefix}.path`] : null),
      path: def[`${prefix}.path`],
      method: def[`${prefix}.method`],
      on: def[`${prefix}.on`],
      if: def[`${prefix}.if`],
      inputs: def[`${prefix}.inputs`],
      // Unknown sub-keys under @n8n.process.start.* (e.g. .foo, .bar)
      unknownKeys: Object.keys(def)
        .filter((k) => k.startsWith(`${prefix}.`))
        .map((k) => k.slice(prefix.length + 1).split(".")[0])
        .filter((suffix) => !ALLOWED_KEYS.includes(suffix)),
    })
  }

  return triggers
}

// Renders `@n8n.process.start for path 'x':` when a path is present, else
// just `@n8n.process.start:`. Used as a stable prefix for every message.
function annCtx(ann, path) {
  return path ? `${cyan(ann)} for path ${yellow(`'${path}'`)}:` : `${cyan(ann)}:`
}

module.exports = {
  validateTriggerAnnotations,
}
