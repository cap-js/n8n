const cds = require("@sap/cds")

async function waitForExecution(
  n8n,
  WorkflowExecutions,
  where,
  predicate = () => true,
  includeData = false,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    // Poll sequentially until n8n persists the execution.
    // eslint-disable-next-line no-await-in-loop
    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where(where))
    const execution = rows.find(predicate)
    if (execution) {
      if (!includeData) return execution
      return n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execution.id }))
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for execution matching ${JSON.stringify(where)}`)
}

function makeWorkflowBody(name, webhookPath, nodes = [], connections = {}, method = "POST") {
  return {
    id: cds.utils.uuid(),
    name,
    nodes: [
      {
        id: cds.utils.uuid(),
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [250, 300],
        parameters: {
          httpMethod: method,
          path: webhookPath,
          responseMode: "onReceived",
          options: {},
        },
        webhookId: webhookPath,
      },
      ...nodes,
    ],
    connections: JSON.stringify(connections),
    settings: "{}",
  }
}

module.exports = { waitForExecution, makeWorkflowBody }
