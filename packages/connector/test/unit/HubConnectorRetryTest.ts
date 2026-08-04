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
/** What `connect()` builds as the axios baseURL, and therefore the byTarget key. */
const TARGET_URL = `${HOST}${TARGET_BASE}`;

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

describe('HubConnector.getRetryStats', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
    resetDefaultBreaker();
    HubConnector.resetRetryStats();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    resetDefaultBreaker();
    HubConnector.resetRetryStats();
  });

  it('starts zeroed', () => {
    expect(HubConnector.getRetryStats()).to.deep.equal({
      transportRetries: 0,
      unavailableRetries: 0,
      exhausted: 0,
      breakerTrips: 0,
      byTarget: {},
    });
  });

  it('counts a retried transport failure', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .get(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });

    await connector.httpClient()!.get('/getUsers');

    const stats = HubConnector.getRetryStats();
    expect(stats.transportRetries).to.equal(1);
    expect(stats.unavailableRetries).to.equal(0);
    expect(stats.exhausted).to.equal(0);
    expect(stats.byTarget).to.deep.equal({ [TARGET_URL]: 1 });
  });

  it('counts a retried unavailability separately from transport', async () => {
    const connector = await connected();
    nock(HOST)
      .put(`${TARGET_BASE}/getUsers`)
      .reply(200, { message: 'Node abc is no longer connected' }, { 'hub-error': 'true' })
      .put(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });

    await connector.httpClient()!.put('/getUsers', {});

    const stats = HubConnector.getRetryStats();
    expect(stats.unavailableRetries).to.equal(1);
    expect(stats.transportRetries).to.equal(0);
    expect(stats.byTarget).to.deep.equal({ [TARGET_URL]: 1 });
  });

  it('counts exhaustion when attempts run out', async () => {
    const connector = await connected({ ...FAST, attempts: 2 });
    const boom = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(boom())
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(boom());

    let caught: unknown;
    try {
      await connector.httpClient()!.get('/getUsers');
    } catch (error) {
      caught = error;
    }

    const stats = HubConnector.getRetryStats();
    // One retry was performed, then the second attempt used the budget up.
    expect(stats.transportRetries).to.equal(1);
    expect(stats.exhausted).to.equal(1);
    expect(stats.breakerTrips).to.equal(0);
    // A replay re-enters the whole interceptor chain, so the failure that finally surfaces has
    // been through normalizeError twice. CoreError.from() is idempotent and the marker must
    // still be readable - this is the shape callers actually see in production.
    expect(isTransportFailure(caught)).to.equal(true);
    expect((caught as any).code).to.equal('ECONNRESET');
  });

  it('counts a breaker trip', async () => {
    // threshold 1: the single exhaustion below is enough to open it.
    const connector = await connected({ ...FAST, attempts: 2, breakerThreshold: 1 });
    const boom = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(boom())
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(boom());

    try {
      await connector.httpClient()!.get('/getUsers');
    } catch { /* expected */ }

    const stats = HubConnector.getRetryStats();
    expect(stats.exhausted).to.equal(1);
    expect(stats.breakerTrips).to.equal(1);
  });

  it('returns a copy that cannot mutate the counters', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .get(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });
    await connector.httpClient()!.get('/getUsers');

    const first = HubConnector.getRetryStats();
    first.transportRetries = 999;
    first.exhausted = 999;
    first.byTarget[TARGET_URL] = 999;
    first.byTarget.injected = 42;

    const second = HubConnector.getRetryStats();
    expect(second.transportRetries).to.equal(1);
    expect(second.exhausted).to.equal(0);
    expect(second.byTarget).to.deep.equal({ [TARGET_URL]: 1 });
    // byTarget must be a distinct object, not the live one behind a spread.
    expect(second.byTarget).to.not.equal(first.byTarget);
  });

  it('clears on resetRetryStats', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${TARGET_BASE}/getUsers`)
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .get(`${TARGET_BASE}/getUsers`)
      .reply(200, { ok: true });
    await connector.httpClient()!.get('/getUsers');
    expect(HubConnector.getRetryStats().transportRetries).to.equal(1);

    HubConnector.resetRetryStats();

    expect(HubConnector.getRetryStats()).to.deep.equal({
      transportRetries: 0,
      unavailableRetries: 0,
      exhausted: 0,
      breakerTrips: 0,
      byTarget: {},
    });
  });
});
