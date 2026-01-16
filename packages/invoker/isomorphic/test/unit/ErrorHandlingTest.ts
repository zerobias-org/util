 
import { testErrorHandling } from '@zerobias-org/util-api-invoker-api/testing';
import { ApiInvokerImpl } from '../../src/ApiInvokerImpl.js';

describe('Api Invoker Impl', () => {
  it('should handle errors properly', async function() {
    await testErrorHandling(new ApiInvokerImpl());
  })
})
