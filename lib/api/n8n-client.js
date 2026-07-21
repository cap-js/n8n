'use strict'

const cds = require('@sap/cds')
const { N8N_LOGGER_PREFIX } = require('../constants')

const LOG = cds.log(N8N_LOGGER_PREFIX)

const API_BASE = '/api/v1'
const WEBHOOK_BASE = '/webhook'

/**
 * Normalises a workflow value into a webhook path.
 *   'my-hook'                     → 'my-hook'
 *   '/webhook/my-hook'            → 'my-hook'
 *   'webhook-test/foo'            → 'webhook-test/foo'   (n8n test URL prefix)
 *   'https://…/webhook/my-hook'   → returned as absolute URL
 */
function normalizeWebhookPath(workflow) {
  if (!workflow) return ''
  const trimmed = String(workflow).trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return trimmed.replace(/^\/+/, '').replace(/^webhook\//, '')
}

function buildWebhookUrl(baseUrl, workflow) {
  const path = normalizeWebhookPath(workflow)
  if (/^https?:\/\//i.test(path)) return path
  return `${trimTrailingSlash(baseUrl)}${WEBHOOK_BASE}/${path}`
}

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * Firing an n8n production webhook.
 * Returns { ok, status, executionId?, body }.
 */
async function trigger(baseUrl, headers, workflow, payload) {
  const url = buildWebhookUrl(baseUrl, workflow)
  LOG.debug(`POST ${url}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload ?? {}),
  })

  const bodyText = await res.text()
  let body
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    body = bodyText
  }

  if (!res.ok) {
    const msg = `n8n webhook call to ${url} failed: ${res.status} ${res.statusText || ''}${bodyText ? ` – ${bodyText.slice(0, 500)}` : ''}`
    throw cds.error(res.status, msg)
  }

  return {
    ok: true,
    status: res.status,
    executionId: extractExecutionId(body),
    body,
  }
}

function extractExecutionId(body) {
  if (!body || typeof body !== 'object') return undefined
  return body.executionId ?? body.id ?? undefined
}

/**
 * GET /api/v1/executions/{id}?includeData=true
 */
async function getExecution(baseUrl, headers, executionId) {
  const url = `${trimTrailingSlash(baseUrl)}${API_BASE}/executions/${encodeURIComponent(executionId)}?includeData=true`
  LOG.debug(`GET ${url}`)

  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw cds.error(
      res.status,
      `Failed to fetch execution ${executionId}: ${res.status} ${res.statusText || ''}${body ? ` – ${body.slice(0, 500)}` : ''}`,
    )
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

/**
 * GET /api/v1/executions?workflowId={id}&includeData=true
 * Returns the `data` array from n8n's paged response.
 */
async function listExecutions(baseUrl, headers, workflowId) {
  const url = `${trimTrailingSlash(baseUrl)}${API_BASE}/executions?workflowId=${encodeURIComponent(workflowId)}&includeData=true`
  LOG.debug(`GET ${url}`)

  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw cds.error(
      res.status,
      `Failed to list executions for workflow ${workflowId}: ${res.status} ${res.statusText || ''}${body ? ` – ${body.slice(0, 500)}` : ''}`,
    )
  }
  const text = await res.text()
  if (!text) return []
  const parsed = JSON.parse(text)
  // n8n returns `{ data: [...], nextCursor: … }` — surface just the array to callers.
  return Array.isArray(parsed) ? parsed : parsed?.data ?? []
}

/**
 * Factory returning a bound client. The client caches nothing; each call
 * consults the passed-in connection resolver (async), so token/destination
 * refreshes propagate naturally.
 */
function createN8nClient(resolveConnection) {
  return {
    async trigger(workflow, payload) {
      const { baseUrl, headers } = await resolveConnection()
      return trigger(baseUrl, headers, workflow, payload)
    },
    async getExecution(executionId) {
      const { baseUrl, headers } = await resolveConnection()
      return getExecution(baseUrl, headers, executionId)
    },
    async listExecutions(workflowId) {
      const { baseUrl, headers } = await resolveConnection()
      return listExecutions(baseUrl, headers, workflowId)
    },
  }
}

module.exports = {
  trigger,
  getExecution,
  listExecutions,
  createN8nClient,
  normalizeWebhookPath,
  buildWebhookUrl,
}
