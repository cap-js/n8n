async function waitForExecution(
  n8n,
  WorkflowExecutions,
  where,
  predicate = () => true,
  includeData = false,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await n8n.run(SELECT.from(WorkflowExecutions).where(where))
    const execution = rows.find(predicate)
    if (execution) {
      if (!includeData) return execution
      return n8n.run(SELECT.one.from(WorkflowExecutions).where({ id: execution.id }))
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for execution matching ${JSON.stringify(where)}`)
}

module.exports = { waitForExecution }
