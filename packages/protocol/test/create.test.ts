import assert from 'node:assert/strict';
import test from 'node:test';

import { gatewayRoutes } from '../src/index.js';

test('agentCreateSubmit returns the flat create-jobs path', () => {
  assert.equal(gatewayRoutes.agentCreateSubmit(), '/api/create/jobs');
});

test('agentCreateSubmitPattern matches the submit path exactly', () => {
  assert.equal(gatewayRoutes.agentCreateSubmitPattern, '/api/create/jobs');
});

test('agentCreateStatus interpolates jobId into the flat create-jobs path', () => {
  assert.equal(gatewayRoutes.agentCreateStatus('job_123'), '/api/create/jobs/job_123');
});

test('agentCreateStatus encodes special characters in jobId', () => {
  assert.equal(gatewayRoutes.agentCreateStatus('a/b'), '/api/create/jobs/a%2Fb');
});

test('agentCreateStatusPattern uses the :jobId placeholder', () => {
  assert.equal(gatewayRoutes.agentCreateStatusPattern, '/api/create/jobs/:jobId');
});
