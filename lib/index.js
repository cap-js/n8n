'use strict'

const cds = require('@sap/cds')
const { N8N_LOGGER_PREFIX, N8N_SERVICE } = require('./constants')
const { registerAnnotationHandlers } = require('./handlers/annotationHandlers')
const { N8nValidationPlugin } = require('./build/plugin')

const LOG = cds.log(N8N_LOGGER_PREFIX)

// Register build plugin (no-op at runtime, active during `cds build`).
cds.build?.register?.('n8n-validation', N8nValidationPlugin)

// Install @n8n.process.start annotation handlers on each ApplicationService as
// it is served. Mirrors process/lib/index.ts's serving hook.
cds.on('serving', (service) => {
  try {
    registerAnnotationHandlers(service)
  } catch (err) {
    LOG.error(`Failed to register @n8n.process.start handlers for ${service?.name}:`, err.message ?? err)
  }
})

cds.once('served', () => {
  const cfg = cds.env.requires?.[N8N_SERVICE]
  if (cfg) {
    LOG.info(`cap-js-n8n ready (kind: ${cfg.kind ?? 'default'})`)
  }
})

module.exports = {
  N8N_SERVICE,
  N8N_LOGGER_PREFIX,
  ...require('./constants'),
  ...require('./shared/input-parser'),
  ...require('./shared/annotations-helper'),
  ...require('./api/n8n-client'),
  ...require('./api/connection'),
}
