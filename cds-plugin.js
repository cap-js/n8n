const cds = require("@sap/cds")
const { registerAnnotationHandlers } = require("./lib/handlers/annotationHandlers")
const { N8nValidationPlugin } = require("./lib/build/plugin")

const LOG = cds.log("@cap-js/n8n")
LOG.info(`Registered @cap-js/n8n plugin with kind '${cds.env.requires?.n8n?.kind}'`)

// Register build plugin (no-op at runtime, active during `cds build`).
cds.build?.register?.("n8n-validation", N8nValidationPlugin)

// Register event handlers for @n8n.process.start annotation
cds.on("served", (services) => {
  for (const srv of services) {
    if (!(srv instanceof cds.ApplicationService) || srv.name === "n8n") continue
    registerAnnotationHandlers(srv)
  }
})
