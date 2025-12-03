/* eslint-disable */
import { expect } from 'chai';
import { NotFoundError } from '@zerobias-org/types-core-js';
import { ApiInvoker, RequestPrototype, ResponsePrototype, ResponseType } from '../index.js';
import nock from 'nock';

function getInput(): RequestPrototype {
  return {
    method: 'get',
    location: {
      protocol: 'http',
      hostname: 'www.foo.bar',
      path: '/images/default/sample.pdf',
      pathParams: {},
      port: '8080',
    },
    options: {
      response: {
        body: {
          type: undefined
        },
        status: {
          tolerated: []
        }
      }
    }
  }
}

function mockDownloadFile(status: number, response: string) {
  nock('http://www.foo.bar:8080', { "encodedQueryParams": true })
    .get('/images/default/sample.pdf')
    .reply(status, response);
}

export async function testErrorHandling(
  apiInvoker: ApiInvoker,
  responseTypes = [ResponseType.Json, undefined]
): Promise<void> {
  return Promise.all(responseTypes.map(async (responseType) => {
    console.info('Testing error handling for', responseType);
    const input = getInput();
    input.options!.response!.body!.type = responseType;

    input.options!.response!.status!.tolerated = [];
    mockDownloadFile(200, 'random response content');
    try {
      const output = await apiInvoker.invokeApi(input);
      expect(output).to.be.ok;
    } catch (error) {
      expect.fail('No error should be thrown for 200 status code');
    }

    input.options!.response!.status!.tolerated = [];
    mockDownloadFile(404, 'Just a Not Found Error message')
    try {
      await apiInvoker.invokeApi(input);
      expect.fail('Not Found Error should be thrown');
    } catch (error) {
      expect(error.statusCode).to.be.eq(404);
      expect(error.key).to.be.eq(NotFoundError.MESSAGE_KEY);
      expect(error.message).contains('Just a Not Found Error message');
    }

    const response = '{"error" : "Just a Not Found Error message"}'
    input.options!.response!.status!.tolerated = [];
    mockDownloadFile(404, response)
    try {
      await apiInvoker.invokeApi(input);
      expect.fail('Not Found Error should be thrown');
    } catch (error) {
      expect(error.statusCode).to.be.eq(404);
      expect(error.key).to.be.eq(NotFoundError.MESSAGE_KEY);
      expect(error.message).to.have.string('Just a Not Found');
    }

    mockDownloadFile(404, response)
    try {
      input.options!.response!.status!.tolerated = [404]
      const output: ResponsePrototype = await apiInvoker.invokeApi(input);
      expect(output).to.be.ok;
    } catch (error) {
      expect.fail('No error should be thrown');
    }
  }))
    .then(() => Promise.resolve());
}
