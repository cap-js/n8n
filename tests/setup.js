'use strict'

// Silence CAP telemetry / auto-open in tests.
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.CDS_LOG_LEVELS_N8N = process.env.CDS_LOG_LEVELS_N8N || 'error'
