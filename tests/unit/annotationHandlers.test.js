"use strict"

const { findAnnotations } = require("../../lib/handlers/annotationHandlers")

const N8N = "@n8n.process.start"
const ALL_CRUD = ["CREATE", "UPSERT", "UPDATE", "DELETE"]

function collect(def) {
  return [...findAnnotations(def)]
}

// ── shorthand ──────────────────────────────────────────────────────────────

describe("findAnnotations - shorthand", () => {
  it("yields descriptor with empty on for a plain string value (registers nothing)", () => {
    const results = collect({ [N8N]: "my-hook" })
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      path: "my-hook",
      on: [],
      conditionExpr: undefined,
      inputs: undefined,
    })
  })

  it("handles qualified shorthand (#foo)", () => {
    const results = collect({ [`${N8N}#foo`]: "my-hook" })
    expect(results[0].path).toBe("my-hook")
    expect(results[0].on).toEqual([])
  })
})

// ── record form ────────────────────────────────────────────────────────────

describe("findAnnotations - record form", () => {
  it("yields descriptor with explicit on", () => {
    const results = collect({ [`${N8N}.path`]: "wf", [`${N8N}.on`]: "CREATE" })
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("wf")
    expect(results[0].on).toEqual(["CREATE"])
  })

  it("skips when on is absent (on is required)", () => {
    expect(collect({ [`${N8N}.path`]: "wf" })).toHaveLength(0)
  })

  it("skips when path is missing", () => {
    expect(collect({ [`${N8N}.on`]: "CREATE" })).toHaveLength(0)
  })

  it("skips when on is an explicit empty array", () => {
    expect(collect({ [`${N8N}.path`]: "wf", [`${N8N}.on`]: [] })).toHaveLength(0)
  })

  it("forwards conditionExpr and inputs", () => {
    const xpr = [{ ref: ["status"] }, "=", { val: "shipped" }]
    const inputs = [{ "=": "$self.ID" }]
    const results = collect({
      [`${N8N}.path`]: "wf",
      [`${N8N}.on`]: "CREATE",
      [`${N8N}.if`]: { xpr },
      [`${N8N}.inputs`]: inputs,
    })
    expect(results[0].conditionExpr).toBe(xpr)
    expect(results[0].inputs).toBe(inputs)
  })
})

// ── array form ─────────────────────────────────────────────────────────────

describe("findAnnotations - array form", () => {
  it("yields one descriptor per element", () => {
    const results = collect({
      [N8N]: [
        { path: "book-created", on: "CREATE" },
        { path: "book-deleted", on: "DELETE" },
      ],
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      path: "book-created",
      on: ["CREATE"],
      conditionExpr: undefined,
      inputs: undefined,
    })
    expect(results[1]).toEqual({
      path: "book-deleted",
      on: ["DELETE"],
      conditionExpr: undefined,
      inputs: undefined,
    })
  })

  it("skips elements missing on (on is required)", () => {
    expect(collect({ [N8N]: [{ path: "my-hook" }] })).toHaveLength(0)
  })

  it.each([
    ["string", "UPDATE", ["UPDATE"]],
    ["array", ["CREATE", "UPDATE"], ["CREATE", "UPDATE"]],
  ])("normalises on: %s", (_label, on, expected) => {
    expect(collect({ [N8N]: [{ path: "wf", on }] })[0].on).toEqual(expected)
  })

  it("skips elements missing or non-string path", () => {
    const results = collect({
      [N8N]: [{ on: "CREATE" }, { path: 42 }, { path: "wf", on: "DELETE" }],
    })
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe("wf")
  })

  it("skips elements with explicit on: []", () => {
    expect(collect({ [N8N]: [{ path: "wf", on: [] }] })).toHaveLength(0)
  })

  it("skips non-object elements (null, primitives, nested arrays)", () => {
    const results = collect({
      [N8N]: [null, "string", 42, ["nested"], { path: "wf", on: "DELETE" }],
    })
    expect(results).toHaveLength(1)
  })

  it("forwards conditionExpr and inputs from element", () => {
    const xpr = [{ ref: ["status"] }, "=", { val: "shipped" }]
    const inputs = [{ "=": "$self.ID" }, { "=": "$self.total" }]
    const results = collect({ [N8N]: [{ path: "wf", on: "CREATE", if: { xpr }, inputs }] })
    expect(results[0].conditionExpr).toBe(xpr)
    expect(results[0].inputs).toBe(inputs)
  })

  it("handles qualified array annotation (#foo)", () => {
    const results = collect({
      [`${N8N}#foo`]: [
        { path: "wf-a", on: "CREATE" },
        { path: "wf-b", on: "DELETE" },
      ],
    })
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.path)).toEqual(["wf-a", "wf-b"])
  })

  it("handles an empty array (yields nothing)", () => {
    expect(collect({ [N8N]: [] })).toHaveLength(0)
  })

  it("coexists with a qualified record form on the same entity", () => {
    const results = collect({
      [N8N]: [{ path: "arr-hook", on: "CREATE" }],
      [`${N8N}#extra.path`]: "rec-hook",
      [`${N8N}#extra.on`]: "DELETE",
    })
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.path).sort()).toEqual(["arr-hook", "rec-hook"])
  })
})
