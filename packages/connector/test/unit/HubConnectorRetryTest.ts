import { expect } from 'chai';
import nock from 'nock';
import {
  HubConnectionProfile,
  URL as CoreURL,
  UUID
} from '@zerobias-org/types-core-js';
import { HubConnector } from '../../src/HubConnector.js';
import { resetDefaultBreaker, RetryConfig } from '../../src/HttpRetry.js';
import { isTransportFailure } from '../../src/TransportError.js';

const HOST = 'http://localhost:19998';
const BASE_PATH = '/api';
const TARGET_ID = '00000000-0000-4000-8000-000000000002';
const TARGET_BASE = `${BASE_PATH}/targets/${TARGET_ID}`;

function profile(): HubConnectionProfile {
  return new HubConnectionProfile(new CoreURL(`${HOST}${BASE_PATH}`), new UUID(TARGET_ID));
}

/**
 * Retry defaults are sized for production (a 34s floor, to outlast a node reconnect). Tests
 * override the ladder to near-zero so they assert the decision, not the sleeping, and disable
 * the breaker so cases do not leak into each other through its process-wide state.
 */
const FAST: Partial<RetryConfig> = {
  attempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  breakerThreshold: 0,
};

async function connected(retry: Partial<RetryConfig> = FAST): Promise<HubConnector> {
  nock(HOST).get(`${TARGET_BASE}/metadata`).reply(200, { status: 'on' });
  const connector = new HubConnector();
  connector.configureRetry(retry);
  await connector.connect(profile());
  return connector;
}

describe('HubConnector retry', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
    resetDefaultBreaker();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    resetDefaultBreaker();
  });

  it('retries a dropped socket and succeeds', async () => {
    const connector = await connected();
    const scope = nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .get(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });

    const response = await connector.httpClient()!.get('/getUsers');

    expect(response.status).to.equal(200);
    expect(response.data).to.deep.equal({ ok: true });
    expect(scope.isDone()).to.equal(true);
  });

  it('retries a hub-error 200 that names a self-resolving condition', async () => {
    // Hub answers 200 with `hub-error` headers for dispatch failures, so status alone is not
    // the trigger. "is no longer connected" is a node that dropped and will come back.
    const connector = await connected();
    const scope = nock(HOST)
      .put(`${TARGET_BASE}/getUsers`)
      .reply(200, { message: 'Node abc is no longer connected' }, { 'hub-error': 'true' })
      .put(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });

    const response = await connector.httpClient()!.put('/getUsers', {});

    expect(response.data).to.deep.equal({ ok: true });
    expect(scope.isDone()).to.equal(true);
  });

  it('does NOT retry a hub-error 200 carrying a real module failure', async () => {
    // Same envelope, but the message is the module's own answer. Replaying a module operation
    // is not safe in general, so the message has to name a known-transient condition.
    const connector = await connected();
    const scope = nock(HOST)
      .put(`${TARGET_BASE}/getUsers`)
      .reply(200, { message: 'Invalid credentials for the remote system' }, { 'hub-error': 'true' });

    let caught: unknown;
    try {
      await connector.httpClient()!.put('/getUsers', {});
    } catch (error) {
      caught = error;
    }

    expect(caught, 'hub-error response should reject').to.be.an('error');
    expect(scope.isDone()).to.equal(true);
    // A second interceptor was never registered, so a replay would have thrown a nock
    // "no match" error rather than reaching this assertion.
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('does not replay a non-idempotent method', async () => {
    // POST is excluded: a reset can arrive after the server already applied the request.
    const connector = await connected();
    const scope = nock(HOST)
      .post(`${TARGET_BASE}/createUser`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    let caught: unknown;
    try {
      await connector.httpClient()!.post('/createUser', {});
    } catch (error) {
      caught = error;
    }

    expect(caught, 'POST should surface the transport failure').to.be.an('error');
    expect(scope.isDone()).to.equal(true);
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('surfaces the transport marker and code to the caller', async () => {
    // attempts: 1 disables retrying, so the failure reaches normalizeError directly.
    const connector = await connected({ ...FAST, attempts: 1 });
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    let caught: any;
    try {
      await connector.httpClient()!.get('/getUsers');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.an('error');
    expect(isTransportFailure(caught), 'should be flagged as a transport failure').to.equal(true);
    expect(caught.code).to.equal('ECONNRESET');
    // Still a CoreError: consumers instanceof-check these, and the conversion is what keeps
    // circular axios refs out of anything serialized.
    expect(caught.statusCode).to.be.a('number');
    expect(caught.key).to.be.a('string');
  });

  it('keeps the transport marker off the serialized form', async () => {
    const connector = await connected({ ...FAST, attempts: 1 });
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    let caught: any;
    try {
      await connector.httpClient()!.get('/getUsers');
    } catch (error) {
      caught = error;
    }

    // The marker is in-process only. It must not reach the wire, and must not drag any
    // circular axios reference into JSON.stringify.
    const serialized = JSON.parse(JSON.stringify(caught));
    expect(serialized).to.not.have.property('transient');
    expect(serialized).to.not.have.property('code');
    expect(Object.keys(caught)).to.not.include('transient');
  });

  it('does not classify a server answer as a transport failure', async () => {
    const connector = await connected({ ...FAST, attempts: 1 });
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .reply(400, { message: 'bad request' });

    let caught: unknown;
    try {
      await connector.httpClient()!.get('/getUsers');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.an('error');
    expect(isTransportFailure(caught), 'a 400 is an answer, not a blip').to.equal(false);
  });
});

describe('HubConnector.onInstance', () => {
  it('fires for both pre-existing and future instances', () => {
    const existing = new HubConnector();
    const seen: HubConnector[] = [];
    const callback = (connector: HubConnector): void => { seen.push(connector); };

    HubConnector.onInstance(callback);
    try {
      // Replayed for instances that already existed, matching BaseApiClient.onInstance.
      expect(seen).to.include(existing);

      const future = new HubConnector();
      expect(seen).to.include(future);
    } finally {
      HubConnector.removeOnInstance(callback);
    }
  });

  it('stops firing after removeOnInstance', () => {
    const seen: HubConnector[] = [];
    const callback = (connector: HubConnector): void => { seen.push(connector); };

    HubConnector.onInstance(callback);
    HubConnector.removeOnInstance(callback);
    const after = new HubConnector();

    expect(seen).to.not.include(after);
  });

  it('advertises native retry so hub-client can stand its patch down', () => {
    expect(HubConnector.hasNativeRetry).to.equal(true);
  });
});
