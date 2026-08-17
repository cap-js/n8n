const cds = require("@sap/cds")
const {
  extractWhereClause,
  extractIds,
  getProperty,
  getPropertyList,
} = require("../../lib/handlers/utils")

const parse = (cql) => cds.parse.cql(cql)

describe("extractWhereClause", () => {
  it("returns null when the request has no CQN query", () => {
    expect(extractWhereClause({})).toBeNull()
    expect(extractWhereClause({ query: {} })).toBeNull()
  })

  it("reads the where-clause from a CQL SELECT", () => {
    const req = { query: parse("SELECT from n8n.WorkflowDefinitions where id = 'abc'") }
    expect(extractWhereClause(req)).toEqual([{ ref: ["id"] }, "=", { val: "abc" }])
  })

  it("reads the where-clause from a fluent UPDATE.entity().where()", () => {
    const req = {
      query: UPDATE.entity("n8n.WorkflowDefinitions").where({ id: "abc" }).with({ name: "x" }),
    }
    expect(extractWhereClause(req)).toEqual([{ ref: ["id"] }, "=", { val: "abc" }])
  })

  it("reads the where-clause from the nested `entity.ref[-1].where` shape", () => {
    // The nested shape is what `UPDATE(entity, key)` produces (with the
    // model-resolved primary key). We hand-craft here since the fluent
    // builder alone can't produce a lowercase `id` without a model.
    const req = {
      query: {
        UPDATE: {
          entity: {
            ref: [
              {
                id: "n8n.WorkflowDefinitions",
                where: [{ ref: ["id"] }, "=", { val: "abc" }],
              },
            ],
          },
        },
      },
    }
    expect(extractWhereClause(req)).toEqual([{ ref: ["id"] }, "=", { val: "abc" }])
  })

  it("reads the where-clause from a fluent DELETE.from().where({id})", () => {
    // DELETE.from().where(...) puts `where` at the CQN top level.
    const req = { query: DELETE.from("n8n.WorkflowDefinitions").where({ id: "abc" }) }
    expect(extractWhereClause(req)).toEqual([{ ref: ["id"] }, "=", { val: "abc" }])
  })
})

describe("extractIds", () => {
  it("returns null when nothing carries an id", () => {
    expect(extractIds({})).toBeNull()
    expect(extractIds({ params: [] })).toBeNull()
    expect(extractIds({ data: {} })).toBeNull()
    expect(extractIds({ query: {} })).toBeNull()
  })

  it("wraps a single id from `req.params` in a one-element array", () => {
    expect(extractIds({ params: [{ id: "abc" }] })).toEqual(["abc"])
    expect(extractIds({ params: [{ id: "outer" }, { id: "leaf" }] })).toEqual(["leaf"])
    expect(extractIds({ params: ["abc"] })).toEqual(["abc"])
  })

  it("wraps `req.data.id` in a one-element array", () => {
    expect(extractIds({ data: { id: "from-data" } })).toEqual(["from-data"])
    expect(extractIds({ params: [], data: { id: "from-data" } })).toEqual(["from-data"])
  })

  it("returns a one-element array for a CQN `= <val>` where-clause", () => {
    const req = {
      query: UPDATE.entity("n8n.WorkflowDefinitions").where({ id: "abc" }).with({ name: "x" }),
    }
    expect(extractIds(req)).toEqual(["abc"])
  })

  it("returns the full list for a CQN `WHERE id IN (...)` where-clause", () => {
    const req = {
      query: parse("SELECT from n8n.WorkflowDefinitions where id in ('a','b','c')"),
    }
    expect(extractIds(req)).toEqual(["a", "b", "c"])
  })

  it("extracts from a fluent DELETE ... WHERE id IN (...)", () => {
    const req = {
      query: DELETE.from("n8n.WorkflowExecutions").where({ id: { in: ["1", "2"] } }),
    }
    expect(extractIds(req)).toEqual(["1", "2"])
  })

  it("returns null for an empty `in` list and no other source", () => {
    // The fluent builder collapses `in: []` to falsy, so hand-craft the CQN.
    const req = {
      query: {
        DELETE: {
          from: { ref: ["n8n.WorkflowDefinitions"] },
          where: [{ ref: ["id"] }, "in", { list: [] }],
        },
      },
    }
    expect(extractIds(req)).toBeNull()
  })

  it("honors a custom key argument", () => {
    expect(extractIds({ data: { workflowId: "wf-1" } }, "workflowId")).toEqual(["wf-1"])
    expect(extractIds({ params: [{ workflowId: "wf-1" }] }, "workflowId")).toEqual(["wf-1"])
    const req = {
      query: parse("SELECT from n8n.WorkflowExecutions where workflowId in ('wf-1','wf-2')"),
    }
    expect(extractIds(req, "workflowId")).toEqual(["wf-1", "wf-2"])
    // Default key `"id"` — no match for the "workflowId" property.
    expect(extractIds(req)).toBeNull()
  })
})

describe("getProperty", () => {
  it("returns null for empty / missing input", () => {
    expect(getProperty(null, "id")).toBeNull()
    expect(getProperty(undefined, "id")).toBeNull()
    expect(getProperty([], "id")).toBeNull()
  })
  it("reads a scalar equality on a top-level property", () => {
    const { where } = parse("SELECT from X where id = 'abc'").SELECT
    expect(getProperty(where, "id")).toBe("abc")
  })
  it("returns null when the property doesn't match", () => {
    const { where } = parse("SELECT from X where name = 'abc'").SELECT
    expect(getProperty(where, "id")).toBeNull()
  })
  it("recurses into xpr sub-trees", () => {
    // Parenthesised sub-expression → CQN `xpr` sub-tree.
    const { where } = parse("SELECT from X where (id = 'abc') and name = 'wf'").SELECT
    expect(getProperty(where, "id")).toBe("abc")
    expect(getProperty(where, "name")).toBe("wf")
  })
})

describe("getPropertyList", () => {
  it("returns null for empty / missing input", () => {
    expect(getPropertyList(null, "id")).toBeNull()
    expect(getPropertyList([], "id")).toBeNull()
  })
  it("returns the array of literal values from a `WHERE id IN (...)` clause", () => {
    const { where } = parse("SELECT from X where id in ('a','b')").SELECT
    expect(getPropertyList(where, "id")).toEqual(["a", "b"])
  })
  it("returns null for a plain equality clause", () => {
    const { where } = parse("SELECT from X where id = 'a'").SELECT
    expect(getPropertyList(where, "id")).toBeNull()
  })
  it("recurses into xpr sub-trees", () => {
    const { where } = parse("SELECT from X where (id in ('a','b'))").SELECT
    expect(getPropertyList(where, "id")).toEqual(["a", "b"])
  })
})
