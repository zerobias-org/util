import { expect } from 'chai';
import { ObjectSerializer, TestResponse, WrongDeserializedObj } from '../../generated/model/index.js';

const RESPONSE = {
  id: 'id',
  items: {
    foo: { started: '2021-04-16T23:20:50.52Z', url: 'https://someUrl.com/' },
    bar: { started: '2022-03-16T10:29:23.52Z', url: 'https://example.com/' },
  }
};

describe('Generator Test', () => {

  it('should deserialize an object with additionalProperties', async () => {
    const obj = ObjectSerializer.deserialize(RESPONSE, 'TestResponse');
    expect(obj).to.be.ok;
    expect(obj).to.be.instanceof(TestResponse);
    expect(obj.items.foo).to.be.instanceof(WrongDeserializedObj);
    expect(obj.items.bar).to.be.instanceof(WrongDeserializedObj);
  });

});
