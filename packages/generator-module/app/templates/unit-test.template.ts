import { expect } from 'chai';
import { new<%= className %> } from '../../src/index.js';

describe('new <%= className %>', function () {
  it('should return a new instance', async function () {
    const api = new<%= className %>();
    expect(api).to.be.ok;
  });
});
