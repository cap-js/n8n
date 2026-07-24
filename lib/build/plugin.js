"use strict"

const cds = require("@sap/cds")
const { N8N_LOGGER_PREFIX } = require("../constants")
const { validateTriggerAnnotations } = require("./validations")

const LOG = cds.log(`${N8N_LOGGER_PREFIX}-build`)

// cds.build is only defined during `cds build`, not during watch/serve.
const Plugin = cds.build?.Plugin
const ERROR = Plugin?.ERROR ?? "Error"
const BuildPluginBase = Plugin ?? class {}

class N8nValidationPlugin extends BuildPluginBase {
  static taskDefaults = { src: "." }
  static hasTask() {
    return true
  }

  async build() {
    const model = await this.model()
    if (!model) return

    LOG.debug("Validating @n8n.process.start annotations…")

    const definitions = model.definitions ?? {}
    for (const name in definitions) {
      if (!Object.hasOwn(definitions, name)) continue
      const def = definitions[name]
      if (def.kind !== "entity" && def.kind !== "event") continue
      validateTriggerAnnotations(name, def, this)
    }

    if (this.messages && cds.build?.BuildError) {
      for (const message of this.messages) {
        if (message.severity === ERROR) {
          throw new cds.build.BuildError("n8n annotation validation failed.")
        }
      }
    }

    LOG.debug("All @n8n.process.start annotations validated.")
  }
}

module.exports = { N8nValidationPlugin }
