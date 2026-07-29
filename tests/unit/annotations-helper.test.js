"use strict"

const {
  findTriggerAnnotations,
  buildTriggerCache,
  extractQualifier,
} = require("../../lib/shared/annotations-helper")

const CUD = ["CREATE", "UPDATE", "DELETE"]

// Helper to build a fake CSN-shaped entity object.
function ent(name, annotations, actions) {
  return { name, actions, ...annotations }
}

describe("extractQualifier", () => {
  it("returns undefined for base annotation", () => {
    expect(extractQualifier("@n8n.process.start", "@n8n.process.start")).toBeUndefined()
  })
  it("returns qualifier portion", () => {
    expect(extractQualifier("@n8n.process.start#one", "@n8n.process.start")).toBe("one")
  })
  it("returns undefined for weird separator", () => {
    expect(extractQualifier("@n8n.process.start.foo", "@n8n.process.start")).toBeUndefined()
  })
})

describe("findTriggerAnnotations - string shorthand", () => {
  it("picks up plain string form and defaults to CREATE + UPDATE", () => {
    const e = ent("Foo", { "@n8n.process.start": "my-hook" })
    expect(findTriggerAnnotations(e)).toEqual([
      {
        qualifier: undefined,
        path: "my-hook",
        on: ["CREATE", "UPDATE"],
        conditionExpr: undefined,
        inputs: undefined,
      },
    ])
  })

  it("picks up qualified string form", () => {
    const e = ent("Foo", { "@n8n.process.start#other": "other-hook" })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(1)
    expect(anns[0].qualifier).toBe("other")
    expect(anns[0].path).toBe("other-hook")
  })
})

describe("findTriggerAnnotations - record form", () => {
  it("reads path / on / if / inputs", () => {
    const e = ent("Foo", {
      "@n8n.process.start.path": "wf-a",
      "@n8n.process.start.on": "UPDATE",
      "@n8n.process.start.if": { xpr: [{ ref: ["status"] }, "=", { val: "shipped" }] },
      "@n8n.process.start.inputs": [{ "=": "$self.ID" }],
    })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(1)
    expect(anns[0]).toMatchObject({
      path: "wf-a",
      on: ["UPDATE"],
      qualifier: undefined,
    })
    expect(anns[0].conditionExpr).toBeDefined()
    expect(anns[0].inputs).toEqual([{ "=": "$self.ID" }])
  })

  it("supports array on: values", () => {
    const e = ent("Foo", {
      "@n8n.process.start.path": "wf-a",
      "@n8n.process.start.on": ["CREATE", "UPDATE"],
    })
    const anns = findTriggerAnnotations(e)
    expect(anns[0].on).toEqual(["CREATE", "UPDATE"])
  })

  it("skips record form when required keys missing", () => {
    // has .path but no .on -> ignored at scan time (build validation will
    // report the error separately).
    const e = ent("Foo", { "@n8n.process.start.path": "wf-a" })
    expect(findTriggerAnnotations(e)).toEqual([])
  })

  it("captures multiple qualified record annotations", () => {
    const e = ent("Foo", {
      "@n8n.process.start#one.path": "wf-one",
      "@n8n.process.start#one.on": "CREATE",
      "@n8n.process.start#two.path": "wf-two",
      "@n8n.process.start#two.on": "DELETE",
    })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(2)
    expect(new Set(anns.map((a) => a.path))).toEqual(new Set(["wf-one", "wf-two"]))
  })
})

describe("buildTriggerCache", () => {
  it("produces one cache entry per (entity,event)", () => {
    const entities = [
      ent("Books", { "@n8n.process.start": "book-hook" }), // CREATE + UPDATE
      ent("Orders", {
        "@n8n.process.start.path": "order-hook",
        "@n8n.process.start.on": "UPDATE",
      }),
    ]
    const cache = buildTriggerCache(entities, CUD)
    // Books -> CREATE + UPDATE, Orders -> UPDATE
    expect(cache.size).toBe(3)
    expect(cache.get("Books:CREATE").triggerAnnotations[0].path).toBe("book-hook")
    expect(cache.get("Books:UPDATE").triggerAnnotations[0].path).toBe("book-hook")
    expect(cache.get("Orders:UPDATE").triggerAnnotations[0].path).toBe("order-hook")
  })

  it('expands wildcard "*" to CRUD + bound actions', () => {
    const entities = [
      ent(
        "Books",
        {
          "@n8n.process.start.path": "star-hook",
          "@n8n.process.start.on": "*",
        },
        { archive: {} },
      ),
    ]
    const cache = buildTriggerCache(entities, CUD)
    expect(new Set([...cache.keys()])).toEqual(
      new Set(["Books:CREATE", "Books:UPDATE", "Books:DELETE", "Books:archive"]),
    )
  })
})
