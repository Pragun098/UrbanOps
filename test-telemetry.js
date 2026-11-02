/**
 * Unit Test Script for UrbanOps Telemetry Ingestion Pipeline (Direct Controller & Schema Tests)
 */

const assert = require('assert');

const runTests = async () => {
  console.log('--- Starting Telemetry Pipeline Validation Tests ---');

  // 1. Verify models/RawData schema definition
  console.log('[Test 1] Verifying RawData Mongoose model definition...');
  const RawData = require('./models/RawData');
  assert(RawData, 'RawData model should be exported');
  assert(RawData.schema.paths.source, 'RawData schema should have "source" field');
  assert(RawData.schema.paths.eventType, 'RawData schema should have "eventType" field');
  assert(RawData.schema.paths.payload, 'RawData schema should have "payload" field');
  assert(RawData.schema.paths.metadata, 'RawData schema should have "metadata" field');
  assert(RawData.schema.paths.createdAt, 'RawData schema should have "createdAt" timestamp');
  console.log('✓ RawData schema structure verified successfully.');

  // 2. Verify config/db.js module export
  console.log('[Test 2] Verifying config/db.js connection module...');
  const { connectDB, DEFAULT_FALLBACK_URI } = require('./config/db');
  assert(typeof connectDB === 'function', 'connectDB must be an async function');
  assert.strictEqual(DEFAULT_FALLBACK_URI, 'mongodb://127.0.0.1:27017/urbanops');
  console.log('✓ Database configuration module verified successfully.');

  // 3. Test Ingestion Route Validation Logic directly
  console.log('[Test 3] Verifying Express routes validation logic directly...');
  const telemetryRouter = require('./routes/telemetry');

  // Find the POST /ingest route handler from router stack
  const ingestRouteLayer = telemetryRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/ingest' && layer.route.methods.post
  );
  assert(ingestRouteLayer, 'POST /ingest handler must be defined on router');
  const handler = ingestRouteLayer.route.stack[0].handle;

  // Helper mock response
  const createMockRes = () => {
    const res = {
      statusCode: null,
      responseData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.responseData = data;
        return this;
      },
    };
    return res;
  };

  // Test 3a: Missing source
  {
    const req = {
      body: { eventType: 'USER_ACTION_DISPATCHED', payload: { action: 'CLICK' } },
      headers: {},
    };
    const res = createMockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.missing.some((f) => f.includes('source')));
    console.log('✓ Route handler returns 400 when "source" is missing.');
  }

  // Test 3b: Missing eventType
  {
    const req = {
      body: { source: 'urbanops-web-frontend', payload: { action: 'CLICK' } },
      headers: {},
    };
    const res = createMockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.missing.some((f) => f.includes('eventType')));
    console.log('✓ Route handler returns 400 when "eventType" is missing.');
  }

  // Test 3c: Missing payload
  {
    const req = {
      body: { source: 'urbanops-web-frontend', eventType: 'USER_ACTION_DISPATCHED' },
      headers: {},
    };
    const res = createMockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.responseData.success, false);
    assert(res.responseData.missing.some((f) => f.includes('payload')));
    console.log('✓ Route handler returns 400 when "payload" is missing.');
  }

  // Test 3d: Successful document creation with mocked RawData.create
  {
    let createdPayload = null;
    const originalCreate = RawData.create;
    RawData.create = async (doc) => {
      createdPayload = doc;
      return {
        _id: 'mock_doc_id_12345',
        source: doc.source,
        eventType: doc.eventType,
        createdAt: new Date(),
      };
    };

    const req = {
      body: {
        source: 'urbanops-web-frontend',
        eventType: 'USER_ACTION_DISPATCHED',
        payload: { buttonId: 'submit-report', formState: 'valid' },
      },
      headers: {
        'x-forwarded-for': '203.0.113.195, 10.0.0.1',
        'user-agent': 'Mozilla/5.0 (UrbanOps Test Agent)',
      },
    };
    const res = createMockRes();
    await handler(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.responseData.success, true);
    assert.strictEqual(createdPayload.source, 'urbanops-web-frontend');
    assert.strictEqual(createdPayload.eventType, 'USER_ACTION_DISPATCHED');
    assert.strictEqual(createdPayload.metadata.ipAddress, '203.0.113.195');
    assert.strictEqual(createdPayload.metadata.userAgent, 'Mozilla/5.0 (UrbanOps Test Agent)');
    assert(createdPayload.metadata.timestamp instanceof Date);

    RawData.create = originalCreate;
    console.log('✓ Route handler returns 201 Created and extracts metadata correctly.');
  }

  console.log('\n--- All Telemetry Pipeline Unit Tests Passed Successfully! ---');
};

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
