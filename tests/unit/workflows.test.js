const cds = require("@sap/cds")
const workflows = require("../../srv/n8n/workflows")
const {
  readWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  unpublishWorkflow,
  archiveWorkflow,
} = workflows

describe("Workflow handlers", () => {
  let originalFetch
  let savedEnv
  let savedRequires
  let capturedInit

  beforeEach(() => {
    capturedInit = null
    originalFetch = globalThis.fetch
    savedEnv = {
      url: process.env.N8N_BASE_URL,
      key: process.env.N8N_API_KEY,
    }
    savedRequires = cds.env.requires
    cds.env.requires = {
      n8n: {
        credentials: { url: "http://x:5678", apiKey: "key-1" },
      },
    }
    globalThis.fetch = async (url, init) => {
      capturedInit = { url, init }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        json: async () => ({ id: "created-id", name: "wf" }),
        text: async () => "",
      }
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    cds.env.requires = savedRequires
    if (savedEnv.url === undefined) delete process.env.N8N_BASE_URL
    else process.env.N8N_BASE_URL = savedEnv.url
    if (savedEnv.key === undefined) delete process.env.N8N_API_KEY
    else process.env.N8N_API_KEY = savedEnv.key
  })

  function makeReq(overrides = {}) {
    return {
      data: {},
      params: [],
      query: {},
      target: { name: "n8n.WorkflowDefinitions" },
      reject: vi.fn((code, message) => {
        const err = new Error(typeof message === "string" ? message : code?.message)
        err.code = code
        throw err
      }),
      ...overrides,
    }
  }

  describe("readWorkflows", () => {
    it("GETs a single workflow when id is in a scalar `=` where-clause", async () => {
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowDefinitions",
                  where: [{ ref: ["id"] }, "=", { val: "abc" }],
                },
              ],
            },
          },
        },
      })
      await readWorkflows(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc")
      expect(capturedInit.init.method).toBe("GET")
    })

    it("GETs the list when there is no where-clause", async () => {
      const req = makeReq({
        query: { SELECT: { from: { ref: [{ id: "n8n.WorkflowDefinitions" }] } } },
      })
      await readWorkflows(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows")
      expect(capturedInit.init.method).toBe("GET")
    })

    it("fans out to per-id GETs when the CQN uses `WHERE id IN (...)`", async () => {
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        // Return a distinct row per id so we can verify aggregation order.
        const id = url.split("/").at(-1)
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id, name: `wf-${id}` }),
          text: async () => "",
        }
      }
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowDefinitions",
                  where: [
                    { ref: ["id"] },
                    "in",
                    { list: [{ val: "a" }, { val: "b" }, { val: "c" }] },
                  ],
                },
              ],
            },
          },
        },
      })
      const rows = await readWorkflows(req)
      expect(calls).toHaveLength(3)
      expect(calls.map((c) => c.url)).toEqual([
        "http://x:5678/api/v1/workflows/a",
        "http://x:5678/api/v1/workflows/b",
        "http://x:5678/api/v1/workflows/c",
      ])
      for (const c of calls) expect(c.init.method).toBe("GET")
      // Rows come back in the order of the requested id list.
      expect(rows).toEqual([
        { id: "a", name: "wf-a" },
        { id: "b", name: "wf-b" },
        { id: "c", name: "wf-c" },
      ])
    })

    it("returns a single row when the CQN uses `.one` and `WHERE id IN (...)`", async () => {
      globalThis.fetch = async (url) => {
        const id = url.split("/").at(-1)
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id, name: `wf-${id}` }),
          text: async () => "",
        }
      }
      const req = makeReq({
        query: {
          SELECT: {
            one: true,
            from: {
              ref: [
                {
                  id: "n8n.WorkflowDefinitions",
                  where: [{ ref: ["id"] }, "in", { list: [{ val: "a" }] }],
                },
              ],
            },
          },
        },
      })
      const row = await readWorkflows(req)
      expect(row).toEqual({ id: "a", name: "wf-a" })
    })

    it("rejects the batch when one requested workflow is missing", async () => {
      globalThis.fetch = async (url) => {
        const id = url.split("/").at(-1)
        if (id === "missing") {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            headers: { get: () => "application/json" },
            json: async () => ({ message: "not found" }),
            text: async () => "",
          }
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id, name: `wf-${id}` }),
          text: async () => "",
        }
      }
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowDefinitions",
                  where: [
                    { ref: ["id"] },
                    "in",
                    { list: [{ val: "a" }, { val: "missing" }, { val: "c" }] },
                  ],
                },
              ],
            },
          },
        },
      })
      await expect(readWorkflows(req)).rejects.toMatchObject({ status: 502 })
    })
  })

  describe("createWorkflow", () => {
    it("POSTs the request data verbatim to /workflows", async () => {
      const req = makeReq({
        data: {
          name: "wf",
          nodes: [],
          connections: {},
          settings: {},
        },
      })
      await createWorkflow(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.headers["X-N8N-API-KEY"]).toBe("key-1")
      expect(capturedInit.init.headers["Content-Type"]).toBe("application/json")
      const body = JSON.parse(capturedInit.init.body)
      expect(body).toEqual({ name: "wf", nodes: [], connections: {}, settings: {} })
    })

    it("rejects when a required field is missing", async () => {
      const req = makeReq({ data: { name: "wf", nodes: [], connections: {} } }) // no settings
      await expect(createWorkflow(req)).rejects.toThrow(/settings/i)
      expect(capturedInit).toBeNull()
    })
  })

  describe("updateWorkflow", () => {
    it("PUTs to /workflows/{id} with the request data", async () => {
      const req = makeReq({
        params: [{ id: "abc" }],
        data: {
          name: "wf2",
          nodes: [],
          connections: {},
          settings: {},
        },
      })
      await updateWorkflow(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc")
      expect(capturedInit.init.method).toBe("PUT")
      const body = JSON.parse(capturedInit.init.body)
      expect(body).toEqual({ name: "wf2", nodes: [], connections: {}, settings: {} })
    })

    it("URL-encodes ids with special chars", async () => {
      const req = makeReq({
        params: [{ id: "a/b c" }],
        data: { name: "n", nodes: [], connections: {}, settings: {} },
      })
      await updateWorkflow(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/a%2Fb%20c")
    })

    it("rejects when no id is provided", async () => {
      await expect(updateWorkflow(makeReq({ params: [] }))).rejects.toThrow(/id/i)
    })

    it("rejects batch updates", async () => {
      const req = makeReq({
        query: UPDATE.entity("n8n.WorkflowDefinitions")
          .where({ id: { in: ["a", "b"] } })
          .with({ name: "renamed" }),
        data: { name: "renamed" },
      })
      await expect(updateWorkflow(req)).rejects.toThrow(/batch/i)
    })

    it("back-fills PUT-mandatory fields from the current workflow when omitted", async () => {
      // First fetch → the current row; second call → the PUT.
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        // GET returns the "current" workflow
        if (init.method === "GET") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            json: async () => ({
              id: "abc",
              name: "old name",
              nodes: [{ id: "n1" }],
              connections: { a: 1 },
              settings: { s: true },
            }),
            text: async () => "",
          }
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id: "abc", name: "new name" }),
          text: async () => "",
        }
      }
      const req = makeReq({
        params: [{ id: "abc" }],
        // Caller only supplies `name` — everything else must be filled in.
        data: { name: "new name" },
      })
      await updateWorkflow(req)
      expect(calls).toHaveLength(2)
      expect(calls[0].url).toBe("http://x:5678/api/v1/workflows/abc")
      expect(calls[0].init.method).toBe("GET")
      expect(calls[1].url).toBe("http://x:5678/api/v1/workflows/abc")
      expect(calls[1].init.method).toBe("PUT")
      const body = JSON.parse(calls[1].init.body)
      expect(body).toEqual({
        name: "new name",
        nodes: [{ id: "n1" }],
        connections: { a: 1 },
        settings: { s: true },
      })
    })

    it("does not re-fetch when the caller sends a complete body", async () => {
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id: "abc" }),
          text: async () => "",
        }
      }
      const req = makeReq({
        params: [{ id: "abc" }],
        data: { name: "wf", nodes: [], connections: {}, settings: {} },
      })
      await updateWorkflow(req)
      expect(calls).toHaveLength(1)
      expect(calls[0].init.method).toBe("PUT")
    })

    it("rejects 404 when back-fill needs the current workflow but n8n has no row", async () => {
      globalThis.fetch = async (_url, init) => {
        if (init.method === "GET") {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            headers: { get: () => "application/json" },
            json: async () => ({ message: "not found" }),
            text: async () => "",
          }
        }
        throw new Error("PUT should never fire when the GET fails")
      }
      const req = makeReq({ params: [{ id: "abc" }], data: { name: "new name" } })
      await expect(updateWorkflow(req)).rejects.toThrow(/not found/i)
    })
  })

  describe("deleteWorkflow", () => {
    it("DELETEs /workflows/{id}", async () => {
      await deleteWorkflow(makeReq({ params: [{ id: "abc" }] }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc")
      expect(capturedInit.init.method).toBe("DELETE")
      expect(capturedInit.init.body).toBeUndefined()
      expect(capturedInit.init.headers["Content-Type"]).toBeUndefined()
    })

    it("rejects when no id is provided", async () => {
      await expect(deleteWorkflow(makeReq({ params: [] }))).rejects.toThrow(/id/i)
    })

    it("fans out to per-id DELETEs when the CQN uses `WHERE id IN (...)`", async () => {
      // Override the module-scoped fetch stub with one that accumulates
      // every call. `capturedInit` in the outer beforeEach only keeps the
      // last one — no good for verifying a batch.
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id: "deleted" }),
          text: async () => "",
        }
      }
      const req = makeReq({
        query: {
          DELETE: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowDefinitions",
                  where: [
                    { ref: ["id"] },
                    "in",
                    { list: [{ val: "a" }, { val: "b" }, { val: "c" }] },
                  ],
                },
              ],
            },
          },
        },
      })
      const res = await deleteWorkflow(req)
      expect(calls).toHaveLength(3)
      expect(calls.map((c) => c.url)).toEqual([
        "http://x:5678/api/v1/workflows/a",
        "http://x:5678/api/v1/workflows/b",
        "http://x:5678/api/v1/workflows/c",
      ])
      for (const c of calls) expect(c.init.method).toBe("DELETE")
      // Returns an aggregated array of per-id responses.
      expect(Array.isArray(res)).toBe(true)
      expect(res).toHaveLength(3)
    })
  })

  describe("publishWorkflow", () => {
    it("POSTs to /workflows/{id}/publish without body when no optional fields", async () => {
      await publishWorkflow(makeReq({ data: { id: "abc" } }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc/publish")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.body).toBeUndefined()
      expect(capturedInit.init.headers["Content-Type"]).toBeUndefined()
    })

    it("POSTs with only the provided optional fields", async () => {
      await publishWorkflow(makeReq({ data: { id: "abc", versionId: "v1", name: "release 1" } }))
      const body = JSON.parse(capturedInit.init.body)
      expect(body).toEqual({ versionId: "v1", name: "release 1" })
      expect(body).not.toHaveProperty("description")
    })

    it("rejects when id is missing", async () => {
      await expect(publishWorkflow(makeReq({ data: {} }))).rejects.toThrow(/id/i)
    })
  })

  describe("unpublishWorkflow", () => {
    it("POSTs to /workflows/{id}/unpublish with no body", async () => {
      await unpublishWorkflow(makeReq({ data: { id: "abc" } }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc/unpublish")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.body).toBeUndefined()
    })

    it("rejects when id is missing", async () => {
      await expect(unpublishWorkflow(makeReq({ data: {} }))).rejects.toThrow(/id/i)
    })
  })

  describe("archiveWorkflow", () => {
    it("POSTs to /workflows/{id}/archive with no body", async () => {
      await archiveWorkflow(makeReq({ data: { id: "abc" } }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/workflows/abc/archive")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.body).toBeUndefined()
    })

    it("rejects when id is missing", async () => {
      await expect(archiveWorkflow(makeReq({ data: {} }))).rejects.toThrow(/id/i)
    })
  })
})

describe("Workflow handlers — error propagation via unified parseResponse", () => {
  let originalFetch
  let savedRequires

  beforeEach(() => {
    originalFetch = globalThis.fetch
    savedRequires = cds.env.requires
    cds.env.requires = {
      n8n: { credentials: { url: "http://x:5678", apiKey: "k" } },
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    cds.env.requires = savedRequires
  })

  it("rejects with 502 on a 409 publish conflict", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: { get: () => "application/json" },
      json: async () => ({
        message: "publication blocked by review",
        reason: "review_pending",
        workflowReviewRequestId: "r1",
      }),
      text: async () => "",
    })
    const req = {
      data: { id: "abc" },
      params: [],
      query: {},
      target: { name: "n8n.WorkflowDefinitions" },
    }
    await expect(publishWorkflow(req)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining(
        "Error requesting n8n.WorkflowDefinitions from n8n: HTTP 409: publication blocked by review",
      ),
    })
  })

  it("rejects with 502 on a 404 in an event context", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => "application/json" },
      json: async () => ({ message: "workflow not found" }),
      text: async () => "",
    })
    // Event context — no `reject`, no `query`, no `target.name`.
    const req = { data: { id: "abc" }, params: [], event: "publishWorkflow" }
    await expect(publishWorkflow(req)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("Error requesting publishWorkflow from n8n: HTTP 404"),
    })
  })
})
