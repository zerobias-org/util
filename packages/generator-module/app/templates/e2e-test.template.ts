/**
 * <%= className %> Module E2E Tests — one test, three impls.
 *
 * TEST_MODE selects the impl:
 *   direct  — <%= className %>Impl (in-process)
 *   docker  — <%= className %>Client (container REST)
 *   hub     — <%= className %>Client (Hub Server via Dana)
 */

import { expect, assert } from 'chai';
import { CoreError } from '@zerobias-org/types-core-js';
import { describeModule } from '@zerobias-org/module-test-client';
import type { <%= className %> } from '../../hub-sdk/generated/api/index.js';

describeModule<<%= className %>>('<%= className %> Module', (client) => {

  // TODO: add e2e tests, e.g.:
  // describe('SomeApi.someOperation', () => {
  //   it('should do something', async () => {
  //     const result = await client.getSomeApi().someOperation();
  //     expect(result).to.be.ok;
  //   });
  // });

}, (data) => CoreError.deserialize(data));
