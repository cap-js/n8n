'use strict'

const {
  N8N_TRIGGER,
  CUD_EVENTS,
} = require('../constants')
const {
  getAnnotationPrefixes,
  extractStringShorthand,
} = require('../shared/annotations-helper')

const ALLOWED_SUFFIXES = ['workflow', 'on', 'if', 'inputs']

/**
 * Validates `@n8n.trigger` shapes on a single entity definition.
 * Reports issues onto the plugin's `messages` array via the helper `report`.
 */
function validateTriggerAnnotations(entityName, def, plugin) {
  const ERROR = plugin?.constructor?.ERROR ?? 'error'
  const WARN = plugin?.constructor?.WARN ?? 'warning'

  // Discover string-shorthand keys ("@n8n.trigger" or "@n8n.trigger#foo" with a
  // plain string value). No structured validation to do beyond "value is a
  // non-empty string" (checked at scan time), so we simply note them for
  // completeness.
  for (const key of Object.keys(def)) {
    if (!key.startsWith(N8N_TRIGGER)) continue
    if (key.includes('.', N8N_TRIGGER.length)) continue
    const shorthand = extractStringShorthand(def, key)
    if (shorthand === undefined) continue
    if (typeof shorthand !== 'string' || shorthand.trim() === '') {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: key,
        message: `${key}: value must be a non-empty string when used as a string shorthand.`,
      })
    }
  }

  const prefixes = getAnnotationPrefixes(def, N8N_TRIGGER)
  for (const prefix of prefixes) {
    const wfKey = `${prefix}.workflow`
    const onKey = `${prefix}.on`
    const ifKey = `${prefix}.if`
    const inputsKey = `${prefix}.inputs`

    // Warn about unknown sub-keys.
    for (const key of Object.keys(def)) {
      if (!key.startsWith(`${prefix}.`)) continue
      const suffix = key.slice(prefix.length + 1).split('.')[0]
      if (!ALLOWED_SUFFIXES.includes(suffix)) {
        report(plugin, WARN, {
          entity: entityName,
          annotation: key,
          message: `${key}: unknown sub-key. Allowed: ${ALLOWED_SUFFIXES.map((s) => `.${s}`).join(', ')}.`,
        })
      }
    }

    const hasWorkflow = def[wfKey] !== undefined
    const hasOn = def[onKey] !== undefined

    // Both workflow and on required for record form.
    if (hasWorkflow !== hasOn) {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: prefix,
        message: `${prefix}: both ${wfKey} and ${onKey} must be present together when using the record form.`,
      })
      continue
    }

    if (!hasWorkflow) continue // nothing more to validate

    // workflow must be a non-empty string.
    if (typeof def[wfKey] !== 'string' || def[wfKey].trim() === '') {
      report(plugin, ERROR, {
        entity: entityName,
        annotation: wfKey,
        message: `${wfKey}: must be a non-empty string.`,
      })
    }

    // on must be a string or non-empty array of strings from the allowed set OR a bound action.
    const onValue = def[onKey]
    const onList = Array.isArray(onValue) ? onValue : [onValue]
    const allowedEvents = new Set([...CUD_EVENTS, ...(def.actions ? Object.keys(def.actions) : [])])
    for (const ev of onList) {
      if (typeof ev !== 'string' || ev.trim() === '') {
        report(plugin, ERROR, {
          entity: entityName,
          annotation: onKey,
          message: `${onKey}: values must be non-empty strings.`,
        })
        continue
      }
      if (ev === '*') continue // wildcard is allowed
      if (!allowedEvents.has(ev)) {
        report(plugin, ERROR, {
          entity: entityName,
          annotation: onKey,
          message: `${onKey}: "${ev}" is not a CRUD event (CREATE, UPDATE, DELETE) or a bound action of ${entityName}.`,
        })
      }
    }

    // if: must have an .xpr shape when present.
    if (def[ifKey] !== undefined) {
      if (typeof def[ifKey] !== 'object' || !('xpr' in def[ifKey])) {
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
          if (!entry || typeof entry !== 'object') {
            report(plugin, ERROR, {
              entity: entityName,
              annotation: inputsKey,
              message: `${inputsKey}: each entry must be an object.`,
            })
            continue
          }
          const isSimple = '=' in entry
          const isAliased = 'path' in entry && 'as' in entry
          if (!isSimple && !isAliased) {
            report(plugin, ERROR, {
              entity: entityName,
              annotation: inputsKey,
              message: `${inputsKey}: each entry must be a { '=': '$self.…' } path or a { path: { '=': '…' }, as: '…' } alias.`,
            })
          }
        }
      }
    }
  }
}

function report(plugin, severity, { entity, annotation, message }) {
  if (plugin && typeof plugin.error === 'function' && severity === 'error') {
    plugin.error(message)
    return
  }
  if (plugin && typeof plugin.warn === 'function' && severity === 'warning') {
    plugin.warn(message)
    return
  }
  // Fallback: push onto plugin.messages if API is available; otherwise console.
  if (plugin && Array.isArray(plugin.messages)) {
    plugin.messages.push({ severity, entity, annotation, message })
    return
  }
  const label = severity === 'error' ? '[n8n-build ERROR]' : '[n8n-build WARN]'
  // eslint-disable-next-line no-console
  console.warn(`${label} ${entity} — ${message}`)
}

module.exports = {
  validateTriggerAnnotations,
  report,
  ALLOWED_SUFFIXES,
}
