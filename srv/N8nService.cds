using {N8nApi} from './external/n8n-api';

@protocol: 'none'
@impl: './n8n-to-rest'
service N8nService {

  /**
   * Fires an n8n production webhook.
   * - path : the webhook path segment (POSTed to `{baseUrl}/webhook/<path>`)
   * - payload : arbitrary JSON body sent to the webhook
   */
  event trigger {
    path    : String(256) @mandatory;
    payload : Map;
  }

  @Capabilities: {
    InsertRestrictions.Insertable: false,
    UpdateRestrictions.Updatable : false,
    DeleteRestrictions.Deletable : true
  }
  entity WorkflowExecutions  as projection on N8nApi.Executions;

  action retryExecution(id : String, loadWorkflow : Boolean) returns WorkflowExecutions;
  action stopExecution(id : String) returns WorkflowExecutions;

  entity WorkflowDefinitions as projection on N8nApi.Workflows;

  action publishWorkflow(
    id : String,
    versionId : String,
    name : String,
    description : String
  ) returns WorkflowDefinitions;

  action unpublishWorkflow(id : String) returns WorkflowDefinitions;
  action archiveWorkflow(id : String) returns WorkflowDefinitions;
}
