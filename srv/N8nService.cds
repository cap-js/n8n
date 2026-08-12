using { N8nApi } from './external/n8n-api';

@protocol: 'none'
@impl    : './n8n-to-rest'
service N8nService {

  /**
   * Fires an n8n production webhook.
   *  - path    : the webhook path segment (POSTed to `{baseUrl}/webhook/<path>`)
   *  - payload : arbitrary JSON body sent to the webhook
   */
  event trigger {
    @mandatory path : String(256);
    payload         : Map;
  }

  @readonly entity WorkflowExecutions  as projection on N8nApi.Executions;
  @readonly entity WorkflowDefinitions as projection on N8nApi.Workflows;
}
