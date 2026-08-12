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

  it("accepts path-only record (on defaults to all CRUD)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.path": "wf" }), plugin)
    expect(plugin.messages).toEqual([])
  })

  it("reports error when only on is set (path is required)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.on": "CREATE" }), plugin)
    expect(plugin.messages.some((m) => /is required/i.test(m.message))).toBe(true)
  })

  it("passes arbitrary on values through without error (no allowlist)", () => {
    // The plugin no longer validates `on:` content — values are forwarded
    // verbatim to `service.after`, which is CAP's job to accept or reject.
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "READ",
      }),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === "Error")).toEqual([])
  })

  it("accepts arbitrary strings in on (including bound-action-looking names)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": "archive",
      }),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === "Error")).toEqual([])
  })

  it("rejects on with non-string / non-array shape", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": 42,
      }),
      plugin,
    )
    expect(
      plugin.messages.some((m) => /must be a string or an array of strings/i.test(m.message)),
    ).toBe(true)
  })

  it("rejects on with empty-string entries", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.on": ["CREATE", ""],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /values must be non-empty strings/i.test(m.message))).toBe(
      true,
    )
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
