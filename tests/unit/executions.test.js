const cds = require("@sap/cds")
const executions = require("../../srv/n8n/executions")
const { readExecutions, deleteExecution, retryExecution, stopExecution, stopExecutions } =
  executions

describe("Execution handlers", () => {
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
      n8n: { credentials: { url: "http://x:5678", apiKey: "key-1" } },
    }
    globalThis.fetch = async (url, init) => {
      capturedInit = { url, init }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        json: async () => ({ id: 42, status: "success" }),
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
      target: { name: "n8n.WorkflowExecutions" },
      reject: vi.fn((code, message) => {
        const err = new Error(typeof message === "string" ? message : code?.message)
        err.code = code
        throw err
      }),
      ...overrides,
    }
  }

  describe("readExecutions", () => {
    it("GETs a single execution with ?includeData=true when id is in where", async () => {
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowExecutions",
                  where: [{ ref: ["id"] }, "=", { val: "42" }],
                },
              ],
            },
          },
        },
      })
      await readExecutions(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/42?includeData=true")
      expect(capturedInit.init.method).toBe("GET")
    })

    it("GETs the list with workflowId / status / limit query params", async () => {
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowExecutions",
                  where: [
                    { ref: ["workflowId"] },
                    "=",
                    { val: "wf-1" },
                    "and",
                    { ref: ["status"] },
                    "=",
                    { val: "success" },
                  ],
                },
              ],
            },
            limit: { rows: { val: 5 } },
          },
        },
      })
      await readExecutions(req)
      const url = new URL(capturedInit.url)
      expect(url.pathname).toBe("/api/v1/executions")
      expect(url.searchParams.get("workflowId")).toBe("wf-1")
      expect(url.searchParams.get("status")).toBe("success")
      expect(url.searchParams.get("limit")).toBe("5")
    })

    it("fans out to per-id GETs with ?includeData=true when `WHERE id IN (...)`", async () => {
      const calls = []
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        // The URL has ?includeData=true so slicing off `?...` and taking
        // the last segment gives us the id.
        const id = url.split("?")[0].split("/").at(-1)
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ id, status: "success" }),
          text: async () => "",
        }
      }
      const req = makeReq({
        query: {
          SELECT: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowExecutions",
                  where: [{ ref: ["id"] }, "in", { list: [{ val: "1" }, { val: "2" }] }],
                },
              ],
            },
          },
        },
      })
      const rows = await readExecutions(req)
      expect(calls).toHaveLength(2)
      expect(calls.map((c) => c.url)).toEqual([
        "http://x:5678/api/v1/executions/1?includeData=true",
        "http://x:5678/api/v1/executions/2?includeData=true",
      ])
      for (const c of calls) expect(c.init.method).toBe("GET")
      expect(rows).toEqual([
        { id: "1", status: "success" },
        { id: "2", status: "success" },
      ])
    })
  })

  describe("deleteExecution", () => {
    it("DELETEs /executions/{id}", async () => {
      await deleteExecution(makeReq({ params: [{ id: "42" }] }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/42")
      expect(capturedInit.init.method).toBe("DELETE")
    })

    it("resolves id from a CQN DELETE where-clause", async () => {
      const req = makeReq({
        query: {
          DELETE: {
            from: {
              ref: [
                {
                  id: "n8n.WorkflowExecutions",
                  where: [{ ref: ["id"] }, "=", { val: "abc" }],
                },
              ],
            },
          },
        },
      })
      await deleteExecution(req)
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/abc")
      expect(capturedInit.init.method).toBe("DELETE")
    })

    it("rejects when no id is provided", async () => {
      await expect(deleteExecution(makeReq({ params: [] }))).rejects.toThrow(/id/i)
    })

    it("fans out to per-id DELETEs when the CQN uses `WHERE id IN (...)`", async () => {
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
                  id: "n8n.WorkflowExecutions",
                  where: [{ ref: ["id"] }, "in", { list: [{ val: "1" }, { val: "2" }] }],
                },
              ],
            },
          },
        },
      })
      const res = await deleteExecution(req)
      expect(calls).toHaveLength(2)
      expect(calls.map((c) => c.url)).toEqual([
        "http://x:5678/api/v1/executions/1",
        "http://x:5678/api/v1/executions/2",
      ])
      for (const c of calls) expect(c.init.method).toBe("DELETE")
      expect(Array.isArray(res)).toBe(true)
      expect(res).toHaveLength(0)
      expect(res.affected).toBe(2)
    })
  })

  describe("retryExecution", () => {
    it("POSTs to /executions/{id}/retry with no body by default", async () => {
      await retryExecution(makeReq({ data: { id: "42" } }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/42/retry")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.body).toBeUndefined()
      expect(capturedInit.init.headers["Content-Type"]).toBeUndefined()
    })

    it("POSTs { loadWorkflow: true } when the flag is supplied", async () => {
      await retryExecution(makeReq({ data: { id: "42", loadWorkflow: true } }))
      expect(JSON.parse(capturedInit.init.body)).toEqual({ loadWorkflow: true })
    })

    it("POSTs { loadWorkflow: false } — explicit opt-out is preserved", async () => {
      await retryExecution(makeReq({ data: { id: "42", loadWorkflow: false } }))
      expect(JSON.parse(capturedInit.init.body)).toEqual({ loadWorkflow: false })
    })

    it("rejects when id is missing", async () => {
      await expect(retryExecution(makeReq({ data: {} }))).rejects.toThrow(/id/i)
    })
  })

  describe("stopExecution", () => {
    it("POSTs to /executions/{id}/stop with no body", async () => {
      await stopExecution(makeReq({ data: { id: "42" } }))
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/42/stop")
      expect(capturedInit.init.method).toBe("POST")
      expect(capturedInit.init.body).toBeUndefined()
      expect(capturedInit.init.headers["Content-Type"]).toBeUndefined()
    })

    it("rejects when id is missing", async () => {
      await expect(stopExecution(makeReq({ data: {} }))).rejects.toThrow(/id/i)
    })
  })

  describe("stopExecutions", () => {
    it("POSTs workflow and status filters to /executions/stop", async () => {
      globalThis.fetch = async (url, init) => {
        capturedInit = { url, init }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          json: async () => ({ stopped: 2 }),
          text: async () => "",
        }
      }
      const result = await stopExecutions(
        makeReq({ data: { workflowId: "workflow-1", status: ["waiting", "running"] } }),
      )
      expect(capturedInit.url).toBe("http://x:5678/api/v1/executions/stop")
      expect(capturedInit.init.method).toBe("POST")
      expect(JSON.parse(capturedInit.init.body)).toEqual({
        workflowId: "workflow-1",
        status: ["waiting", "running"],
      })
      expect(result).toBe(2)
    })

    it("rejects without a workflow id or status", async () => {
      await expect(stopExecutions(makeReq({ data: { status: ["waiting"] } }))).rejects.toThrow(
        /workflow id/i,
      )
      await expect(stopExecutions(makeReq({ data: { workflowId: "workflow-1" } }))).rejects.toThrow(
        /status/i,
      )
    })
  })
})
