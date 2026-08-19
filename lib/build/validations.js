const { N8N_PROCESS_START } = require("../constants")

const ALLOWED_SUFFIXES = ["path", "method", "on", "if", "inputs"]
const ALLOWED_ITEM_KEYS = new Set(ALLOWED_SUFFIXES)
const ALLOWED_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"])

// Validates one element of an array-form annotation (e.g. `@n8n.process.start: [{ ... }]`).
// `ann` is the annotation key, `idx` is the 0-based element index.
function validateArrayItem(entityName, ann, idx, item, plugin, ERROR, WARNING) {
  const ref = `${ann}[${idx}]`

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    report(plugin, ERROR, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: each array element must be an object with at least a 'path' key.`,
    })
    return
  }

  for (const k of Object.keys(item)) {
    if (!ALLOWED_ITEM_KEYS.has(k)) {
      report(plugin, WARNING, {
        entity: entityName,
        annotation: ref,
        message: `${ref}: unknown key '${k}'. Allowed: ${ALLOWED_SUFFIXES.join(", ")}.`,
      })
    }
  }

  if (typeof item.path !== "string" || item.path.trim() === "") {
    report(plugin, ERROR, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: 'path' is required and must be a non-empty string.`,
    })
  }

  validateMethod(item.method, ref, entityName, plugin, ERROR)

  if (item.on === undefined) {
    report(plugin, WARNING, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: 'on' is required; this trigger will be skipped.`,
    })
  } else {
    validateItemOn(item.on, ref, entityName, plugin, ERROR)
  }

  if (item.if !== undefined && (typeof item.if !== "object" || !("xpr" in item.if))) {
    report(plugin, ERROR, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: 'if' must be a CDS expression.`,
    })
  }

  if (item.inputs !== undefined) validateItemInputs(item.inputs, ref, entityName, plugin, ERROR)
}

function validateItemOn(on, ref, entityName, plugin, ERROR) {
  if (typeof on !== "string" && !Array.isArray(on)) {
    report(plugin, ERROR, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: 'on' must be a string or an array of strings.`,
    })
    return
  }
  const onList = Array.isArray(on) ? on : [on]
  for (const ev of onList) {
    if (typeof ev !== "string" || ev.trim() === "") {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: ref,
        message: `${ref}: 'on' values must be non-empty strings.`,
      })
    }
  }
}

function validateItemInputs(inputs, ref, entityName, plugin, ERROR) {
  if (!Array.isArray(inputs)) {
    report(plugin, ERROR, {
      entity: entityName,
      annotation: ref,
      message: `${ref}: 'inputs' must be an array of input mappings.`,
    })
    return
  }
  for (const entry of inputs) {
    if (!entry || typeof entry !== "object") {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: ref,
        message: `${ref}: each 'inputs' entry must be an object.`,
      })
      continue
    }
    if (!("=" in entry)) {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: ref,
        message: `${ref}: each 'inputs' entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
      })
    }
  }
}

/**
 * Validates `@n8n.process.start` shapes on a single entity definition.
 * Reports issues via `plugin.pushMessage(msg, severity)` using the
 * `Plugin.ERROR` / `Plugin.WARNING` constants exposed on `cds.build.Plugin`
 * (see `@sap/cds-dk/lib/build/plugins/plugin.js`). When those constants are
 * absent (older cds-dk, unit-test doubles) we fall back to the string
 * literals the pluginmanager also accepts.
 */
function validateTriggerAnnotations(entityName, def, plugin) {
  const PluginCtor = plugin?.constructor ?? {}
  const ERROR = PluginCtor.ERROR ?? "Error"
  const WARNING = PluginCtor.WARNING ?? "Warning"

  // Plain-string annotations are not supported. Require the record form
  // or array-form so every trigger declares its event explicitly.
  for (const key of Object.keys(def)) {
    if (!key.startsWith(N8N_PROCESS_START)) continue
    if (key.includes(".", N8N_PROCESS_START.length)) continue
    const shorthand = def[key]
    if (Array.isArray(shorthand)) {
      shorthand.forEach((item, idx) =>
        validateArrayItem(entityName, key, idx, item, plugin, ERROR, WARNING),
      )
      continue
    }
    if (typeof shorthand !== "string") continue
    report(plugin, ERROR, {
      entity: entityName,
      annotation: key,
      message: `${key}: string shorthand is no longer supported; use the record form with .path and .on.`,
    })
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
  if (hasRecordForm) {
    // Warn about unknown sub-keys.
    for (const key of Object.keys(def)) {
      if (!key.startsWith(`${prefix}.`)) continue
      const suffix = key.slice(prefix.length + 1).split(".")[0]
      if (!ALLOWED_SUFFIXES.includes(suffix)) {
        report(plugin, WARNING, {
          entity: entityName,
          annotation: key,
          message: `${key}: unknown sub-key. Allowed: ${ALLOWED_SUFFIXES.map((s) => `.${s}`).join(", ")}.`,
        })
      }
    }

    const hasPath = def[pathKey] !== undefined
    const hasOn = def[onKey] !== undefined

    // Record form requires both `path` and `on`.
    if (!hasPath) {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: prefix,
        message: `${prefix}: ${pathKey} is required${hasOn ? ` (found only ${onKey})` : ""}.`,
      })
      return
    }

    if (!hasOn) {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: prefix,
        message: `${prefix}: ${onKey} is required.`,
      })
    }

    // path must be a non-empty string.
    if (typeof def[pathKey] !== "string" || def[pathKey].trim() === "") {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: pathKey,
        message: `${pathKey}: must be a non-empty string.`,
      })
    }

    // on: shape-check only when provided. Values are forwarded verbatim to
    // `service.after` — CAP validates event names at handler-registration
    // time. An explicit empty array `[]` means "disabled".
    if (hasOn) {
      const onValue = def[onKey]
      if (typeof onValue !== "string" && !Array.isArray(onValue)) {
        report(plugin, ERROR, {
          entity: entityName,
          annotation: onKey,
          message: `${onKey}: must be a string or an array of strings.`,
        })
      } else {
        const onList = Array.isArray(onValue) ? onValue : [onValue]
        for (const ev of onList) {
          if (typeof ev !== "string" || ev.trim() === "") {
            report(plugin, ERROR, {
              entity: entityName,
              annotation: onKey,
              message: `${onKey}: values must be non-empty strings.`,
            })
          }
        }
      }
    }

    validateMethod(def[methodKey], methodKey, entityName, plugin, ERROR)

    // if: must have an .xpr shape when present.
    if (def[ifKey] !== undefined) {
      if (typeof def[ifKey] !== "object" || !("xpr" in def[ifKey])) {
        report(plugin, ERROR, {
          entity: entityName,
          annotation: ifKey,
          message: `${ifKey}: must be a CDS expression.`,
        })
      }
    }

    // inputs: must be an array when present.
    if (def[inputsKey] !== undefined) {
      if (!Array.isArray(def[inputsKey])) {
        report(plugin, ERROR, {
          entity: entityName,
          annotation: inputsKey,
          message: `${inputsKey}: must be an array of input mappings.`,
        })
      } else {
        for (const entry of def[inputsKey]) {
          if (!entry || typeof entry !== "object") {
            report(plugin, ERROR, {
              entity: entityName,
              annotation: inputsKey,
              message: `${inputsKey}: each entry must be an object.`,
            })
            continue
          }
          if (!("=" in entry)) {
            report(plugin, ERROR, {
              entity: entityName,
              annotation: inputsKey,
              message: `${inputsKey}: each entry must be a { '=': '$self.…' } path. Aliasing is not supported; use the Edit Fields node in n8n to rename downstream.`,
            })
          }
        }
      }
    }
  }
}

function validateMethod(method, annotation, entityName, plugin, ERROR) {
  if (method === undefined) return
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method.trim().toUpperCase())) {
    report(plugin, ERROR, {
      entity: entityName,
      annotation,
      message: `${annotation}: must be one of ${[...ALLOWED_METHODS].join(", ")}.`,
    })
  }
}

/**
 * Reports a validation finding. Uses `plugin.pushMessage(msg, severity)` when
 * available (the canonical `cds.build.Plugin` API). Falls back to pushing
 * directly onto `plugin.messages` for test doubles that don't implement the
 * full plugin interface, and finally to `console.warn` for environments where
 * `plugin` was not supplied at all.
 */
function report(plugin, severity, { entity, annotation, message }) {
  const prefixed = `${entity} - ${annotation}: ${message.replace(new RegExp(`^${escapeRegex(annotation)}:\\s*`), "")}`
  if (plugin && typeof plugin.pushMessage === "function") {
    plugin.pushMessage(prefixed, severity)
    return
  }
  if (plugin && Array.isArray(plugin.messages)) {
    plugin.messages.push({ severity, entity, annotation, message })
    return
  }
  const label = /error/i.test(severity) ? "[n8n-build ERROR]" : "[n8n-build WARN]"
  // eslint-disable-next-line no-console
  console.warn(`${label} ${entity} - ${message}`)
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

module.exports = {
  validateTriggerAnnotations,
  report,
  ALLOWED_SUFFIXES,
}
