import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SPEC = `openapi: 3.0.3
info:
  title: server-params
  version: 1.0.0
servers:
  - url: /
paths:
  /things/{thingId}:
    patch:
      operationId: updateThing
      tags: [things]
      parameters:
        - name: thingId
          in: path
          required: true
          schema:
            type: string
        - name: If-Match
          in: header
          required: false
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                display_name:
                  type: string
      responses:
        '200':
          description: The thing
          content:
            application/json:
              schema:
                type: string
`;

/**
 * hub-module-server used to declare a header or form parameter's variable under its name on the wire, while the impl
 * call passes the camelCase name: `If-Match` made a controller that doesn't compile, and `display_name` one that passes
 * an undeclared `displayName`. It also read a header in its declared case, but Node lowercases incoming header names, so
 * any header parameter with a capital read undefined.
 */
describe('hub-module-server: header and form parameters', function () {
  this.timeout(120000);

  let dir: string;
  let controller: string;

  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-server-params-'));
    fs.writeFileSync(path.join(dir, 'api.yml'), SPEC);
    execFileSync(path.join(__dirname, '../../bin/hub-generator.js'), [
      'generate', '-g', 'hub-module-server', '-i', path.join(dir, 'api.yml'), '-o', path.join(dir, 'out'),
      '-p', 'modulePackage=../../src/',
    ], { stdio: 'pipe' });
    controller = fs.readFileSync(path.join(dir, 'out/server/ThingsApiController.ts'), 'utf-8');
  });

  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('declares a header parameter under its camelCase name and reads it lowercased', function () {
    expect(controller).to.include(`let ifMatch: string = await ObjectSerializer.deserialize(req.headers['if-match'], "string");`);
    expect(controller).to.not.include('let If-Match');
  });

  it('declares a form field under its camelCase name, reading it under its own', function () {
    expect(controller).to.include(`let displayName: string = await ObjectSerializer.deserialize(req.body['display_name'], "string");`);
  });

  it('passes the parameters to the impl under the names it declared', function () {
    expect(controller).to.include('impl.updateThing(thingId, ifMatch, displayName)');
  });
});
