const cds = require("@sap/cds")
const LOG = cds.log("@cap-js/n8n")

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
    const body = await response.json()
    let res = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [body]
    if (req.query.SELECT?.one) res = Array.isArray(res) ? res[0] : res
    return res
  }
  const bodyText = await response.text().catch(() => "")
  LOG.error(
    `Error requesting ${req.target?.name} from n8n: `,
    response.status,
    response.statusText,
    bodyText,
  )
  return req.query.SELECT?.one ? null : []
}

module.exports = { getProperty, parseResponse }
