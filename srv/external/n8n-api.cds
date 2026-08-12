/**
 * n8n Public REST API — hand-written CDS shapes for the `N8nApi` remote
 * service.
 *
 * Origin: https://github.com/n8n-io/n8n/blob/master/packages/cli/src/public-api/v1/openapi.yml
 */
service N8nApi @(path: '/api/v1') {

  /**
   * Mirrors GET /api/v1/executions and GET /api/v1/executions/{id}.
   */
  @cds.persistence.skip
  entity Executions {
    key id             : String;
        workflowId     : String;
        finished       : Boolean;
        /** 'manual' | 'trigger' | 'webhook' | 'retry' | 'internal' | 'evaluation' */
        mode           : String;
        retryOf        : String;
        retrySuccessId : String;
        /** 'new' | 'running' | 'success' | 'error' | 'waiting' | 'canceled' | 'crashed' */
        status         : String;
        startedAt      : Timestamp;
        stoppedAt      : Timestamp;
        waitTill       : Timestamp;
        /**
         * Full node run data as returned by `?includeData=true`. Opaque map —
         * see n8n docs for shape. Absent when `includeData=false`.
         */
        data           : Map;
  }

  /**
   * Mirrors GET /api/v1/workflows and GET /api/v1/workflows/{id}.
   */
  @cds.persistence.skip
  entity Workflows {
    key id          : String;
        name        : String;
        active      : Boolean;
        createdAt   : Timestamp;
        updatedAt   : Timestamp;
        /** Array of n8n node definitions. Opaque map, one per node. */
        nodes       : many Map;
        /** Directed graph of connections keyed by node name. Opaque. */
        connections : Map;
        /** Workflow-level settings (execution order, timezone, etc.). Opaque. */
        settings    : Map;
        /** Persisted static data available inside workflow expressions. Opaque. */
        staticData  : Map;
        /** Array of tag objects `{id, name, createdAt, updatedAt}`. */
        tags        : many Map;
  }
}
