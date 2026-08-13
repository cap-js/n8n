const cds = require("@sap/cds")
const LOG = cds.log("@cap-js/n8n")

function hasPayload(payload) {
  if (payload == null) return false
  if (typeof payload !== "object") return true
  if (Array.isArray(payload)) return payload.length > 0
  return Object.keys(payload).length > 0
}

function getProperty(where, property) {
  if (!where) return null
  for (let i = 0; i < where.length; i++) {
    const ele = where[i]
    if (
      ele?.val !== undefined &&
      ((where[i - 1] === "=" && where[i - 2]?.ref && where[i - 2].ref[0] === property) ||
        (where[i + 1] === "=" && where[i + 2]?.ref && where[i + 2].ref[0] === property))
    ) {
      return ele.val
    } else if (ele?.xpr) {
      const val = getProperty(ele.xpr, property)
      if (val) return val
    }
  }
  return null
}

async function parseResponse(req, response) {
  if (response.ok) {
    const body = await response.json().catch(() => null)
    if (body == null) return body
    let res = Array.isArray(body?.data) ? body.data : body
    if (req.query?.SELECT?.one) {
      res = Array.isArray(res) ? res[0] : res
    }
    return res
  }

  const body = response.headers?.get?.("content-type")?.match?.("json")
    ? JSON.stringify(await response.json().catch(() => ({})))
    : response.status
  LOG.error(
    `Error requesting ${req.target?.name ?? req.event} from n8n: `,
    req.event,
    body,
  )
  return {}
}

module.exports = { getProperty, hasPayload, parseResponse }
