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

describe("validateTriggerAnnotations - record form", () => {
  it("accepts supported webhook methods case-insensitively", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.method": "get",
        "@n8n.process.start.on": "CREATE",
      }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it("rejects unsupported webhook methods", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.method": "TRACE",
        "@n8n.process.start.on": "CREATE",
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be one of/i.test(m.message))).toBe(true)
  })

  it("rejects multiple webhook methods", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({
        "@n8n.process.start.path": "wf",
        "@n8n.process.start.method": ["GET", "POST"],
        "@n8n.process.start.on": "CREATE",
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be one of/i.test(m.message))).toBe(true)
  })

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

  it("rejects path-only record without on", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.path": "wf" }), plugin)
    expect(plugin.messages.some((m) => /\.on is required/i.test(m.message))).toBe(true)
  })

  it("reports error when only on is set (path is required)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Orders", ent({ "@n8n.process.start.on": "CREATE" }), plugin)
    expect(plugin.messages.some((m) => /is required/i.test(m.message))).toBe(true)
  })

  it("rejects a record without path or on", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Orders",
      ent({ "@n8n.process.start.if": { xpr: [{ ref: ["status"] }] } }),
      plugin,
    )
    expect(plugin.messages.some((m) => /path is required/i.test(m.message))).toBe(true)
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

describe("validateTriggerAnnotations - array form", () => {
  it("accepts a valid two-element array", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({
        "@n8n.process.start": [
          { path: "book-created", on: "CREATE" },
          { path: "book-deleted", on: "DELETE" },
        ],
      }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it("accepts an element with on as array", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", on: ["CREATE", "UPDATE"] }] }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it("accepts an element with valid inputs", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", on: "CREATE", inputs: [{ "=": "$self.ID" }] }] }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it("rejects an element missing path", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Books", ent({ "@n8n.process.start": [{ on: "CREATE" }] }), plugin)
    expect(
      plugin.messages.some((m) => m.severity === "Error" && /path.*required/i.test(m.message)),
    ).toBe(true)
  })

  it("rejects an element with empty path", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Books", ent({ "@n8n.process.start": [{ path: "  " }] }), plugin)
    expect(plugin.messages.some((m) => m.severity === "Error")).toBe(true)
  })

  it("rejects a non-object element (e.g. a string)", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations("Books", ent({ "@n8n.process.start": ["not-an-object"] }), plugin)
    expect(plugin.messages.some((m) => m.severity === "Error")).toBe(true)
  })

  it("rejects an element with on of invalid type", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", on: 42 }] }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be a string or an array/i.test(m.message))).toBe(true)
  })

  it("rejects an element with empty-string in on array", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", on: ["CREATE", ""] }] }),
      plugin,
    )
    expect(plugin.messages.some((m) => /values must be non-empty/i.test(m.message))).toBe(true)
  })

  it("rejects an element with non-expression if", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", if: "invalid" }] }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be a CDS expression/i.test(m.message))).toBe(true)
  })

  it("rejects an element with non-array inputs", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", inputs: "foo" }] }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be an array/i.test(m.message))).toBe(true)
  })

  it("rejects aliased inputs entries", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({
        "@n8n.process.start": [{ path: "wf", inputs: [{ path: { "=": "$self.ID" }, as: "id" }] }],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /Aliasing is not supported/i.test(m.message))).toBe(true)
  })

  it("warns on unknown keys in an element", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({ "@n8n.process.start": [{ path: "wf", bogus: "value" }] }),
      plugin,
    )
    expect(
      plugin.messages.some((m) => m.severity === "Warning" && /unknown key/i.test(m.message)),
    ).toBe(true)
  })

  it("reports errors on the correct element index", () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      "Books",
      ent({
        "@n8n.process.start": [
          { path: "wf-ok" },
          { on: "CREATE" }, // missing path — index 1
        ],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /\[1\]/.test(m.message))).toBe(true)
  })
})
