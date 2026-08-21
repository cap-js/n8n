using { N8nApi } from './external/n8n-api';

@protocol: 'none'
@impl: './n8n-to-rest'
service n8n {

  type WebhookMethod : String(16) enum {
    DELETE;
    GET;
    HEAD;
    PATCH;
    POST;
    PUT;
  };

  action triggerWorkflow(
    path    : String(256)   @mandatory,
    method  : WebhookMethod @assert.range default 'POST',
    payload : Map
  ) returns Map;

  @Capabilities: {
    InsertRestrictions.Insertable: false,
    UpdateRestrictions.Updatable : false,
    DeleteRestrictions.Deletable : true
  }
  entity WorkflowExecutions  as projection on N8nApi.Executions;

  action retryExecution(id : String @mandatory, loadWorkflow : Boolean) returns WorkflowExecutions;
  action stopExecution(id : String @mandatory) returns WorkflowExecutions;
  action stopExecutions(
    workflowId : String  @mandatory,
    status : many String @mandatory
  ) returns Integer;

  entity WorkflowDefinitions as projection on N8nApi.Workflows;

  action publishWorkflow(
    id : String @mandatory,
    versionId: UUID,
    name : String,
    description : String
  ) returns WorkflowDefinitions;

  action unpublishWorkflow(id : String @mandatory) returns WorkflowDefinitions;
  action archiveWorkflow(id : String @mandatory) returns WorkflowDefinitions;
}
