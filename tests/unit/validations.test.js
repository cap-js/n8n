"use strict"

const { validateTriggerAnnotations } = require("../../lib/build/validations")

// Minimal plugin double: implements the canonical cds.build.Plugin surface -
// static severity constants + a `pushMessage(msg, severity)` sink.
class PluginStub {
  static ERROR = "Error"
  static WARNING = "Warning"
  constructor() {
    this.messages = []
  }
  pushMessage(message, severity) {
    // Retain both the raw message and a synthetic { severity, message: <bare> }
    // shape so the existing assertions on `.message` regex-match still work.
    this.messages.push({ severity, message })
  }
}

function makePlugin() {
  return new PluginStub()
}

function ent(annotations, actions) {
  return { actions, ...annotations }
}

describe("validateTriggerAnnotations - string shorthand", () => {
  it("accepts a non-empty string", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Foo", ent({ "@n8n.process.start": "my-hook" }), plugin)
    expect(plugin.messages).toEqual([])
  })

  it("rejects empty string", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Foo", ent({ "@n8n.process.start": "" }), plugin)
    expect(plugin.messages.some((m) => m.severity === "Error")).toBe(true)
  })
})

describe("validateTriggerAnnotations - record form", () => {
  it("accepts a complete record", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
      }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it("reports error when only path is set", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.path": "wf" }), plugin)
    expect(plugin.messages.some((m) => /must be present together/i.test(m.message))).toBe(true)
  })

  it("reports error when only on is set", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.on": "CREATE" }), plugin)
    expect(plugin.messages.some((m) => /must be present together/i.test(m.message))).toBe(true)
  })

  it("reports error for invalid on value", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "READ",
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /not a CRUD event/i.test(m.message))).toBe(true)
  })

  it("accepts bound action name in on", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent(
        {
          "@n8n.process.start.path": "wf",
          "@n8n.process.start.on": "archive",
        },
        { archive: {} },
      ),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === "Error")).toEqual([])
  })

  it("warns on unknown sub-key", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.bogus": "value",
      }),
      plugin,
    )
    expect(
      plugin.messages.some((m) => m.severity === "Warning" && /unknown sub-key/i.test(m.message)),
    ).toBe(true)
  })

  it("rejects inputs that is not an array", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.inputs": "foo",
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be an array/i.test(m.message))).toBe(true)
  })

  it("rejects malformed inputs entry", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.inputs": [{ foo: "bar" }],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /each entry/i.test(m.message))).toBe(true)
  })

  it("accepts simple inputs entries", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.inputs": [{ "=": "$self.ID" }, { "=": "$self.total" }],
      }),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === "Error")).toEqual([])
  })

  it("rejects aliased inputs entries (aliasing not supported)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.inputs": [{ path: { "=": "$self.total" }, as: "amount" }],
      }),
      plugin,
    )
    expect(
      plugin.messages.some(
        (m) => m.severity === "Error" && /Aliasing is not supported/i.test(m.message),
      ),
    ).toBe(true)
  })

  it("uses Plugin.ERROR / Plugin.WARNING constants from the plugin class", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "CREATE",
        "@n8n.process.start.bogus": "value",
      }),
      plugin,
    )
    // Every recorded severity must be one of the two constants - never lower-case.
    for (const m of plugin.messages) {
      expect(["Error", "Warning"]).toContain(m.severity)
    }
  })
})
