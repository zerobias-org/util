/* eslint-disable */
import {
  testInvokeApi,
  testFetchJson
} from '@zerobias-org/util-api-invoker-api';
import { ApiInvokerImpl } from '../../src/ApiInvokerImpl.js';

describe('api-invoker', () => {
  describe('test api invoker', () => {
    it('should invoke api', async () => {
      await testInvokeApi(new ApiInvokerImpl());
    });

    it('should get json', async () => {
      await testFetchJson(new ApiInvokerImpl());
    });
  });
});
