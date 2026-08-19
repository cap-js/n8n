/**
 * n8n Public REST API — hand-written CDS shapes.
 *
 * Origin: https://github.com/n8n-io/n8n/blob/master/packages/cli/src/public-api/v1/openapi.yml
 */
context N8nApi {

    /**
   * Mirrors GET /api/v1/workflows and GET /api/v1/workflows/{id}.
   */
  @cds.persistence.skip
  entity Workflows {
    key           id           : String;
                  name         : String    @mandatory;
                  description  : String;
    @readonly     active       : Boolean default false;
    @readonly     isArchived   : Boolean default false;

        // could be maybe LargeString
                  nodes        : many Map @mandatory;
                  connections  : LargeString      @mandatory;
                  settings     : LargeString      @mandatory;
                  staticData   : LargeString;

    @readonly     triggerCount : Integer;
    @readonly     versionId    : UUID;
    /** Array of tag objects `{id, name, createdAt, updatedAt}`. */
    @readonly     tags         : many Map;
    @readonly     createdAt    : Timestamp @cds.on.insert: $now;
    @readonly     updatedAt    : Timestamp @cds.on.update: $now;
  }

  /**
   * Mirrors GET /api/v1/executions and GET /api/v1/executions/{id}.
   */
  @cds.persistence.skip
  entity Executions {
    key id             : String;
        workflowId     : String;
        finished       : Boolean;
        /** 'cli' | 'error' | 'integrated' | 'internal' | 'manual' | 'retry' | 'trigger' | 'webhook' | 'evaluation' | 'chat' */
        mode           : String;
        retryOf        : Integer;
        retrySuccessId : Integer;
        /** 'new' | 'running' | 'success' | 'error' | 'waiting' | 'canceled' | 'crashed' | 'unknow' */
        status         : String;
        startedAt      : Timestamp @cds.on.insert: $now;
        stoppedAt      : Timestamp;
        waitTill       : Timestamp;
        /**
         * Full node run data as returned by `?includeData=true`.
         */
        data           : LargeString;
  }
}