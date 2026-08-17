const cds = require("@sap/cds")
const { registerAnnotationHandlers } = require("./lib/handlers/annotationHandlers")
const { N8nValidationPlugin } = require("./lib/build/plugin")

const LOG = cds.log("@cap-js/n8n")

// Register build plugin (no-op at runtime, active during `cds build`).
cds.build?.register?.("n8n-validation", N8nValidationPlugin)

// Register event handlers for @n8n.process.start annotation
cds.on("served", (services) => {
  for (const srv of services) {
    if (!(srv instanceof cds.ApplicationService) || srv.name === "N8nService") continue
    registerAnnotationHandlers(srv)
  }
})

cds.once("served", () => {
  const cfg = cds.env.requires?.["N8nService"]
  if (cfg) {
    LOG.debug(`Using kind: ${cfg.kind ?? "default"}`)
  }
})
