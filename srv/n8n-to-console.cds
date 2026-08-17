using n8n as service from './n8n';

annotate service with @impl: './n8n-to-console';

annotate service.WorkflowExecutions with @cds.persistence.table;
annotate service.WorkflowDefinitions with @cds.persistence.table;
