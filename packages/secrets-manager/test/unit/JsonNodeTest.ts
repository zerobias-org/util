/* eslint-disable */
import { expect } from 'chai';
import { JsonNode } from '../../src/JsonNode.js';

describe('JsonNodeTest', function () {
  it('returns a plain string secret unchanged', async () => {
    const node = new JsonNode('ghp_plaintoken', 'githubPat');
    expect(await node.getValue()).to.eq('ghp_plaintoken');
  });

  it('returns a JSON-object-shaped string secret as its original string', async () => {
    const blob = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","expiresAt":1789}}';
    const node = new JsonNode(blob, 'anthropicCredential');
    expect(await node.getValue()).to.eq(blob);
  });

  it('returns a JSON-array-shaped string secret as its original string', async () => {
    const arr = '["a","b"]';
    const node = new JsonNode(arr, 'list');
    expect(await node.getValue()).to.eq(arr);
  });
});
