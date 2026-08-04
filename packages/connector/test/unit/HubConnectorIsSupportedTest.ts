import { expect } from 'chai';
import nock from 'nock';
import {
  HubConnectionProfile,
  OperationSupportStatus,
  URL as CoreURL,
  UUID
} from '@zerobias-org/types-core-js';
import { HubConnector } from '../../src/HubConnector.js';

const HOST = 'http://localhost:19999';
const BASE_PATH = '/api';
const TARGET_ID = '00000000-0000-4000-8000-000000000001';

function profile(): HubConnectionProfile {
  return new HubConnectionProfile(
    new CoreURL(`${HOST}${BASE_PATH}`),
    new UUID(TARGET_ID)
  );
}

/**
 * `connect()` eagerly fetches remote metadata, so every connected test needs
 * that call stubbed before the interesting one.
 */
async function connected(): Promise<HubConnector> {
  nock(HOST)
    .get(`${BASE_PATH}/targets/${TARGET_ID}/metadata`)
    .reply(200, { status: 'on' });

  const connector = new HubConnector();
  await connector.connect(profile());
  return connector;
}

describe('HubConnector.isSupported', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('returns the deserialized status from the server when supported', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${BASE_PATH}/targets/${TARGET_ID}/getUsers/supported`)
      .reply(200, 'yes');

    const result = await connector.isSupported('getUsers');

    expect(result).to.equal(OperationSupportStatus.Yes);
  });

  it('returns No when the server reports the operation is unsupported', async () => {
    // Pins the behaviour change: this previously always resolved to Maybe
    // because the request promise was dropped rather than returned.
    const connector = await connected();
    nock(HOST)
      .get(`${BASE_PATH}/targets/${TARGET_ID}/getUsers/supported`)
      .reply(200, 'no');

    const result = await connector.isSupported('getUsers');

    expect(result).to.equal(OperationSupportStatus.No);
  });

  it('falls back to Maybe when the request fails', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${BASE_PATH}/targets/${TARGET_ID}/getUsers/supported`)
      .reply(500, { message: 'boom' });

    const result = await connector.isSupported('getUsers');

    expect(result).to.equal(OperationSupportStatus.Maybe);
  });

  it('falls back to Maybe when the payload is not a valid status', async () => {
    const connector = await connected();
    nock(HOST)
      .get(`${BASE_PATH}/targets/${TARGET_ID}/getUsers/supported`)
      .reply(200, 'not-a-status');

    const result = await connector.isSupported('getUsers');

    expect(result).to.equal(OperationSupportStatus.Maybe);
  });

  it('returns Maybe without issuing a request when not connected', async () => {
    const connector = new HubConnector();

    const result = await connector.isSupported('getUsers');

    expect(result).to.equal(OperationSupportStatus.Maybe);
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('actually issues the request rather than dropping the promise', async () => {
    const connector = await connected();
    const scope = nock(HOST)
      .get(`${BASE_PATH}/targets/${TARGET_ID}/getUsers/supported`)
      .reply(200, 'yes');

    await connector.isSupported('getUsers');

    // isDone() is false if the interceptor was never consumed, which is exactly
    // what the dropped-promise bug looked like from the caller's side.
    expect(scope.isDone()).to.equal(true);
  });
});
