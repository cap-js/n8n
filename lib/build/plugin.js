const cds = require("@sap/cds")
const { validateTriggerAnnotations } = require("../shared/validations")

const LOG = cds.log("n8n")

// cds.build is only defined during `cds build`, not during watch/serve.
const Plugin = cds.build?.Plugin
const BuildPluginBase = Plugin ?? class {}

class N8nValidationPlugin extends BuildPluginBase {
  static taskDefaults = { src: "." }
  static hasTask() {
    return true
  }

  // Include $location on definitions
  options() {
    return { ...super.options?.(), locations: true }
  }

  async build() {
    const model = await this.model()
    if (!model) return

    const messagesBefore = this.messages?.length ?? 0
    const ERROR = this.constructor.ERROR ?? "Error"

    // compile to runtime CSN
    const runtimeCSN = cds.compile.for.nodejs(structuredClone(model))

    const definitions = runtimeCSN.definitions ?? {}
    for (const name in definitions) {
      if (!Object.hasOwn(definitions, name)) continue
      const def = definitions[name]
      if (def.kind !== "entity" && def.kind !== "event") continue
      validateTriggerAnnotations(name, def, this, runtimeCSN)
    }

    // Abort the build if validation pushed any ERROR-severity message.
    const newMessages = this.messages?.slice(messagesBefore) ?? []
    if (newMessages.some((m) => m.severity === ERROR)) {
      throw new cds.build.BuildError("build failed because of n8n annotation validation")
    }

    LOG.debug("All @n8n.process.start annotations validated.")
  }
}

module.exports = { N8nValidationPlugin }
