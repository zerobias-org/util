/* eslint-disable */
import { expect } from 'chai';
import {
    ApiInvoker,
    RequestPrototype,
    ResponsePrototype,
    ResponseType
} from '../index.js';
import nock from 'nock';

const URL = 'http://localhost:8888';

const VENDORS_LIST = [{
  code: 'adp',
  status: 'draft',
  id: 'dc0480f7-3244-5169-a373-22b1acf5b3dc',
  type: 'vendor',
  name: 'ADP',
  created: '2021-06-10T20:03:40.860Z',
  updated: '2021-06-10T20:03:40.860Z',
  logo: 'https://www.adp.com/-/media/adp/redesign2018/ui/logo-adp-fy19.svg',
  url: 'https://www.adp.com/',
  keywords: [],
  description: 'Automatic Data Processing, Inc. ',
}];

function mockListVendors(): void {
  nock(URL)
    .get((uri) => uri.startsWith('/vendors'))
    .reply(200, VENDORS_LIST);
}

export async function testInvokeApi(apiInvoker: ApiInvoker): Promise<void> {
  mockListVendors();
  const input: RequestPrototype = {
    method: 'get',
    location: {
      protocol: 'http',
      hostname: 'localhost',
      path: '/vendors',
      pathParams: {},
      port: '8888',
    },
    headers: {Authorization: 'Bearer Dummy'},
  };
  const output: ResponsePrototype = await apiInvoker.invokeApi(input);
  expect(output).to.be.ok;
  expect(output.status).to.be.equal(200);
  expect(output.body).to.be.instanceOf(Array);
  const body = output.body as Array<Record<string, unknown>>;
  expect(body.length).to.be.equal(1);
  expect(body[0].code).to.be.ok;
  expect(body[0].code).to.be.equal(VENDORS_LIST[0].code);
  expect(body[0].code).to.be.equal(VENDORS_LIST[0].code);
}

export async function testFetchJson(apiInvoker: ApiInvoker): Promise<void> {
  mockListVendors();
  const input: RequestPrototype = {
    method: 'get',
    location: {
      protocol: 'http',
      hostname: 'localhost',
      path: '/vendors',
      pathParams: {},
      port: '8888',
    },
    options: {
      response: {
        body: {
          type: ResponseType.Json
        }
      }
    }
  };

  const output: ResponsePrototype = await apiInvoker.invokeApi(input);
  expect(output).to.be.ok;
  expect(output.status).to.be.equal(200);
  expect(output.body).to.be.instanceOf(Array);
  const body = output.body as Array<Record<string, unknown>>;
  expect(body.length).to.be.equal(1);
  expect(body[0].code).to.be.ok;
  expect(body[0].code).to.be.equal(VENDORS_LIST[0].code);
  expect(body[0].code).to.be.equal(VENDORS_LIST[0].code);
}
