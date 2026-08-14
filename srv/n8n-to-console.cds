using N8nService as service from './N8nService';

annotate service with @impl: './n8n-to-console';

annotate service.WorkflowExecutions with @cds.persistence.table;
annotate service.WorkflowDefinitions with @cds.persistence.table;
