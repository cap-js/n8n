'use strict'

/**
 * N8n Service registration name in cds.requires
 */
const N8N_SERVICE = 'N8nService'

/**
 * Log namespace for cds.log
 */
const N8N_LOGGER_PREFIX = 'n8n'

/**
 * CRUD lifecycle events supported by @n8n.trigger.on
 */
const CUD_EVENTS = ['CREATE', 'UPDATE', 'DELETE']

/**
 * Default set of events used when @n8n.trigger is applied as a string shorthand.
 * String shorthand: @n8n.trigger: 'my-webhook' → fires on CREATE + UPDATE.
 */
const DEFAULT_STRING_SHORTHAND_EVENTS = ['CREATE', 'UPDATE']

/**
 * Annotation prefixes / suffixes
 */
const N8N_PREFIX = '@n8n'
const N8N_TRIGGER = '@n8n.trigger'

const SUFFIX_WORKFLOW = '.workflow'
const SUFFIX_ON = '.on'
const SUFFIX_IF = '.if'
const SUFFIX_INPUTS = '.inputs'

/**
 * Full annotation keys (unqualified). These match the record form:
 *   @n8n.trigger: { workflow: '...', on: '...', if: ..., inputs: [...] }
 * The CDS compiler flattens the record into '@n8n.trigger.workflow', etc.
 */
const N8N_TRIGGER_WORKFLOW = `${N8N_TRIGGER}${SUFFIX_WORKFLOW}`
const N8N_TRIGGER_ON = `${N8N_TRIGGER}${SUFFIX_ON}`
const N8N_TRIGGER_IF = `${N8N_TRIGGER}${SUFFIX_IF}`
const N8N_TRIGGER_INPUTS = `${N8N_TRIGGER}${SUFFIX_INPUTS}`

/**
 * Default local n8n base URL used only in [development] profile.
 */
const DEV_DEFAULT_BASE_URL = 'http://localhost:5678'

module.exports = {
  N8N_SERVICE,
  N8N_LOGGER_PREFIX,
  CUD_EVENTS,
  DEFAULT_STRING_SHORTHAND_EVENTS,
  N8N_PREFIX,
  N8N_TRIGGER,
  SUFFIX_WORKFLOW,
  SUFFIX_ON,
  SUFFIX_IF,
  SUFFIX_INPUTS,
  N8N_TRIGGER_WORKFLOW,
  N8N_TRIGGER_ON,
  N8N_TRIGGER_IF,
  N8N_TRIGGER_INPUTS,
  DEV_DEFAULT_BASE_URL,
}
