@open
type AnyType {}
type ExecutionsReturn : many AnyType;

@protocol: 'none'
@impl    : './restN8nService'
service N8nService {

  /**
   * Fires an n8n production webhook.
   *  - path    : the webhook path segment (POSTed to `{baseUrl}/webhook/<path>`)
   *  - payload : arbitrary JSON body sent to the webhook
   */
  event trigger {
    @mandatory path : String(256);
    payload         : AnyType;
  }

  /**
   * Retrieves a single execution by ID from the n8n public API.
   * Calls GET /api/v1/executions/{id}?includeData=true.
   */
  function getExecution(
    @mandatory executionId : String(256)
  ) returns AnyType;

  /**
   * Lists executions for a given workflow ID.
   * Calls GET /api/v1/executions?workflowId={id}&includeData=true.
   */
  function listExecutions(
    @mandatory workflowId : String(256)
  ) returns ExecutionsReturn;
}
