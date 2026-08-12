/**
 * N8n Service registration name in cds.requires.
 */
const N8N_SERVICE = "N8nService"

/**
 * Annotation prefixes / suffixes
 */
const N8N_PROCESS_START = "@n8n.process.start"

const SUFFIX_PATH = ".path"
const SUFFIX_ON = ".on"
const SUFFIX_IF = ".if"
const SUFFIX_INPUTS = ".inputs"

/**
 * Default local n8n base URL used only in [development] profile.
 */
const DEV_DEFAULT_BASE_URL = "http://localhost:5678"

/**
 * Default HTTP timeouts (ms).
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 3000
const DEFAULT_READ_TIMEOUT_MS = 5000

module.exports = {
  N8N_SERVICE,
  N8N_PROCESS_START,
  SUFFIX_PATH,
  SUFFIX_ON,
  SUFFIX_IF,
  SUFFIX_INPUTS,
  DEV_DEFAULT_BASE_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
}
