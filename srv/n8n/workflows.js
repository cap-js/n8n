const { parseResponse, getProperty } = require("../../lib/handlers/utils")

function n8nRequest(opts) {
  return require("../n8n-to-rest").n8nRequest(opts)
}

const WORKFLOW_READ_ONLY_FIELDS = [
  "id",
  "active",
  "createdAt",
  "updatedAt",
  "isArchived",
  "versionId",
  "triggerCount",
  "tags",
  "meta",
  "shared",
  "activeVersion",
]

// Removes fields the n8n API considers read-only. Returns a shallow copy so
// the caller's input is untouched.
function stripReadOnly(payload) {
  if (!payload || typeof payload !== "object") return payload
  const out = { ...payload }
  for (const f of WORKFLOW_READ_ONLY_FIELDS) delete out[f]
  return out
}

// Extracts the workflow id from an UPDATE / DELETE / bound-action request.
function extractWorkflowId(req) {
  const last = req.params?.at?.(-1)
  if (last != null) {
    if (typeof last === "object" && last.id != null) return last.id
    if (typeof last !== "object") return last
  }
  if (req.data?.id) return req.data.id
  
  const cqn = req.query?.UPDATE ?? req.query?.DELETE
  const ref = cqn?.entity?.ref ?? cqn?.from?.ref
  const where = ref?.at?.(-1)?.where ?? cqn?.where
  if (where) {
    const id = getProperty(where, "id")
    if (id) return id
  }
  return null
}

async function readWorkflows(req) {
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
  const id = getProperty(where, "id")

  let path = "/api/v1/workflows"
  if (id) {
    path += `/${encodeURIComponent(id)}`
  } else {
    const params = new URLSearchParams()
    const active = getProperty(where, "active")
    const name = getProperty(where, "name")
    if (active != null) params.set("active", String(active))
    if (name) params.set("name", name)
    if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
    const qs = params.toString()
    if (qs) path += `?${qs}`
  }

  const response = await n8nRequest({ method: "GET", path })
  return parseResponse(req, response)
}

async function createWorkflow(req) {
  const body = stripReadOnly(req.data ?? {})
  for (const required of ["name", "nodes", "connections", "settings"]) {
    if (body[required] == null) {
      return req.reject(400, `Missing required workflow field: ${required}`)
    }
  }
  const response = await n8nRequest({
    method: "POST",
    path: "/api/v1/workflows",
    body,
  })
  return parseResponse(req, response)
}

async function updateWorkflow(req) {
  const id = extractWorkflowId(req)
  if (!id) return req.reject(400, "Missing workflow id for UPDATE")
  const body = stripReadOnly(req.data ?? {})
  const response = await n8nRequest({
    method: "PUT",
    path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    body,
  })
  return parseResponse(req, response)
}

async function deleteWorkflow(req) {
  const id = extractWorkflowId(req)
  if (!id) return req.reject(400, "Missing workflow id for DELETE")
  const response = await n8nRequest({
    method: "DELETE",
    path: `/api/v1/workflows/${encodeURIComponent(id)}`,
  })
  return parseResponse(req, response)
}

async function publishWorkflow(req) {
  const { id, versionId, name, description } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for publishWorkflow")
  const body = {}
  if (versionId) body.versionId = versionId
  if (name) body.name = name
  if (description) body.description = description
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/publish`,
    body: Object.keys(body).length > 0 ? body : undefined,
  })
  return parseResponse(req, response)
}

async function unpublishWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for unpublishWorkflow")
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/unpublish`,
  })
  return parseResponse(req, response)
}

async function archiveWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for archiveWorkflow")
  const response = await n8nRequest({
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
  // Exposed for reuse and unit tests.
  stripReadOnly,
  extractWorkflowId,
  WORKFLOW_READ_ONLY_FIELDS,
}
