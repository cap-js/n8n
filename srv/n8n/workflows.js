const { parseResponse, getProperty, extractIds, writeResult } = require("../../lib/handlers/utils")
const { n8nAPIRequest } = require("../../lib/api/connection")

function parseJsonFields(workflow) {
  for (const field of ["connections", "settings", "staticData"]) {
    if (typeof workflow[field] === "string") {
      try {
        workflow[field] = JSON.parse(workflow[field])
      } catch {
        // Let n8n return its validation error for malformed JSON.
      }
    }
  }
  return workflow
}

async function readWorkflows(req) {
  const ids = extractIds(req)
  if (ids) {
    const responses = await Promise.all(
      ids.map((id) =>
        n8nAPIRequest({ method: "GET", path: `/api/v1/workflows/${encodeURIComponent(id)}` }),
      ),
    )
    // A missing workflow is an empty CQL result, not a failed query.
    const rows = (
      await Promise.all(
        responses.map((r) => (r.status === 404 ? undefined : parseResponse(req, r))),
      )
    ).filter((row) => row && (typeof row !== "object" || Object.keys(row).length > 0))
    if (req.query.SELECT?.one) return rows[0]
    return rows
  }

  // No id in the where-clause — list all with optional filters.
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
  const params = new URLSearchParams()
  const active = getProperty(where, "active")
  const name = getProperty(where, "name")
  if (active != null) params.set("active", String(active))
  if (name) params.set("name", name)
  if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
  const qs = params.toString()
  const path = qs ? `/api/v1/workflows?${qs}` : "/api/v1/workflows"

  const response = await n8nAPIRequest({ method: "GET", path })
  return parseResponse(req, response)
}

async function createWorkflow(req) {
  const body = { ...(req.data ?? {}) }
  delete body.id // n8n assigns workflow IDs
  parseJsonFields(body)
  for (const required of ["name", "nodes", "connections", "settings"]) {
    if (body[required] == null) {
      return req.reject(400, `Missing required workflow field: ${required}`)
    }
  }
  const response = await n8nAPIRequest({
    method: "POST",
    path: "/api/v1/workflows",
    body,
  })
  const created = await parseResponse(req, response)

  if (!created || typeof created !== "object" || !created.id) {
    return created // error path — parseResponse already logged and returned {}
  }
  return writeResult([{ id: created.id }], 1)
}

// n8n's PUT /workflows/{id} rejects a request missing any of `name`,
// `nodes`, `connections`, `settings`. CQL semantics are the opposite —
// a partial UPDATE leaves untouched columns alone. Bridge by fetching
// the current row when the caller omits any PUT-mandatory field and
// back-filling from that.
const WORKFLOW_PUT_REQUIRED_FIELDS = ["name", "nodes", "connections", "settings"]

async function updateWorkflow(req) {
  const ids = extractIds(req) ?? []
  if (ids.length > 1) return req.reject(400, "Batch workflow UPDATE is not supported")
  const [id] = ids
  if (!id) return req.reject(400, "Missing workflow id for UPDATE")
  const body = { ...(req.data ?? {}) }
  // These fields are computed by n8n and must not be sent back in a PUT.
  delete body.id
  delete body.active
  delete body.isArchived
  parseJsonFields(body)

  const missing = WORKFLOW_PUT_REQUIRED_FIELDS.filter((f) => body[f] == null)
  if (missing.length > 0) {
    const currentResponse = await n8nAPIRequest({
      method: "GET",
      path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    })
    const current = await parseResponse(req, currentResponse)
    if (!current || (typeof current === "object" && Object.keys(current).length === 0)) {
      return req.reject(404, `Workflow ${id} not found`)
    }
    for (const f of missing) {
      if (current[f] != null) body[f] = current[f]
    }
  }

  const response = await n8nAPIRequest({
    method: "PUT",
    path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    body,
  })
  const updated = await parseResponse(req, response)
  // conform to CAP return shape
  const affected = updated && typeof updated === "object" && updated.id ? 1 : 0
  return writeResult([], affected)
}

async function deleteWorkflow(req) {
  const ids = extractIds(req)
  if (!ids || ids.length === 0) return req.reject(400, "Missing workflow id for DELETE")

  const responses = await Promise.all(
    ids.map((id) =>
      n8nAPIRequest({ method: "DELETE", path: `/api/v1/workflows/${encodeURIComponent(id)}` }),
    ),
  )
  const results = await Promise.all(responses.map((r) => parseResponse(req, r)))

  // conform to CAP return shape
  const affected = results.filter(
    (r) => r && typeof r === "object" && Object.keys(r).length > 0,
  ).length
  return writeResult([], affected)
}

async function publishWorkflow(req) {
  const { id, versionId, name, description } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for publishWorkflow")
  const body = {}
  if (versionId) body.versionId = versionId
  if (name) body.name = name
  if (description) body.description = description
  const response = await n8nAPIRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/publish`,
    body: Object.keys(body).length > 0 ? body : undefined,
  })
  return parseResponse(req, response)
}

async function unpublishWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for unpublishWorkflow")
  const response = await n8nAPIRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/unpublish`,
  })
  return parseResponse(req, response)
}

async function archiveWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for archiveWorkflow")
  const response = await n8nAPIRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/archive`,
  })
  return parseResponse(req, response)
}

module.exports = {
  readWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  unpublishWorkflow,
  archiveWorkflow,
  parseJsonFields,
  // Exposed for reuse and unit tests.
  WORKFLOW_PUT_REQUIRED_FIELDS,
}
