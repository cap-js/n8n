/**
 * N8n Service registration name in cds.requires
 */
const N8N_SERVICE = "N8nService"

/**
 * Log namespace for cds.log
 */
const N8N_LOGGER_PREFIX = "n8n"

/**
 * CRUD lifecycle events supported by @n8n.process.start.on
 */
const CUD_EVENTS = ["CREATE", "UPDATE", "DELETE"]

/**
 * Default set of events used when @n8n.process.start is applied as a string shorthand.
 * String shorthand: @n8n.process.start: 'my-webhook' → fires on CREATE + UPDATE.
 */
const DEFAULT_STRING_SHORTHAND_EVENTS = ["CREATE", "UPDATE"]

/**
 * Annotation prefixes / suffixes
 */
const N8N_PREFIX = "@n8n"
const N8N_PROCESS_START = "@n8n.process.start"

const SUFFIX_PATH = ".path"
const SUFFIX_ON = ".on"
const SUFFIX_IF = ".if"
const SUFFIX_INPUTS = ".inputs"

/**
 * Full annotation keys (unqualified). These match the record form:
 *   @n8n.process.start: { path: '...', on: '...', if: ..., inputs: [...] }
 * The CDS compiler flattens the record into '@n8n.process.start.path', etc.
 */
const N8N_PROCESS_START_PATH = `${N8N_PROCESS_START}${SUFFIX_PATH}`
const N8N_PROCESS_START_ON = `${N8N_PROCESS_START}${SUFFIX_ON}`
const N8N_PROCESS_START_IF = `${N8N_PROCESS_START}${SUFFIX_IF}`
const N8N_PROCESS_START_INPUTS = `${N8N_PROCESS_START}${SUFFIX_INPUTS}`

/**
 * Default local n8n base URL used only in [development] profile.
 */
const DEV_DEFAULT_BASE_URL = "http://localhost:5678"

/**
 * Path prefixes used to build webhook URLs. n8n exposes two: `/webhook/…`
 * for published (production) workflows and `/webhook-test/…` for the
 * "Listen for Test Event" one-shot capture used during authoring.
 */
const WEBHOOK_PATH_PREFIX = "/webhook"
const WEBHOOK_TEST_PATH_PREFIX = "/webhook-test"

/**
 * Default HTTP timeouts (ms).
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 3000
const DEFAULT_READ_TIMEOUT_MS = 5000

module.exports = {
  N8N_SERVICE,
  N8N_LOGGER_PREFIX,
  CUD_EVENTS,
  DEFAULT_STRING_SHORTHAND_EVENTS,
  N8N_PREFIX,
  N8N_PROCESS_START,
  SUFFIX_PATH,
  SUFFIX_ON,
  SUFFIX_IF,
  SUFFIX_INPUTS,
  N8N_PROCESS_START_PATH,
  N8N_PROCESS_START_ON,
  N8N_PROCESS_START_IF,
  N8N_PROCESS_START_INPUTS,
  DEV_DEFAULT_BASE_URL,
  WEBHOOK_PATH_PREFIX,
  WEBHOOK_TEST_PATH_PREFIX,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
}
