import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';
import { InvalidInputError } from '@zerobias-org/types-core-js';

const SPEC = `openapi: 3.0.3
info:
  title: validation-errors
  version: 1.0.0
servers:
  - url: /
paths:
  /things/{thingId}:
    put:
      operationId: updateThing
      tags: [things]
      parameters:
        - name: thingId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                principals:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        '200':
          description: The updated thing's id
          content:
            application/json:
              schema:
                type: string
`;

/** Finds the first node in `sf` that `match` accepts, depth first. */
function find<T extends ts.Node>(sf: ts.SourceFile, match: (node: ts.Node) => node is T): T | undefined {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && match(node)) {
      found = node;
    } else if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return found;
}

/** Loads one top-level function of the generated index.ts on its own; the ones tested here import nothing. */
async function loadFunction(sf: ts.SourceFile, name: string): Promise<(...args: unknown[]) => unknown> {
  const fn = find(sf, (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  expect(fn, `function ${name} in the generated index.ts`).to.not.equal(undefined);
  const js = ts.transpileModule(`${fn!.getText(sf)}\nexport { ${name} };\n`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  return loaded[name];
}

/**
 * hub-module-server reported a `format` failure under the last segment of the validator's path alone, so a bad item
 * in a nested array read `Invalid 0: must match format "uuid"` and never named the field. The paths below are the ones
 * express-openapi-validator 5.6 reports, location prefix and JSON Pointer escapes included.
 */
describe('hub-module-server: request-validation format errors', function () {
  this.timeout(120000);

  let dir: string;
  let sf: ts.SourceFile;
  let fieldPath: (path?: string) => string;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-validation-errors-'));
    fs.writeFileSync(path.join(dir, 'api.yml'), SPEC);
    execFileSync(path.join(__dirname, '../../bin/hub-generator.js'), [
      'generate', '-g', 'hub-module-server', '-i', path.join(dir, 'api.yml'), '-o', path.join(dir, 'out'),
      '-p', 'modulePackage=../../src',
    ], { stdio: 'pipe' });
    const index = path.join(dir, 'out/server/index.ts');
    sf = ts.createSourceFile(index, fs.readFileSync(index, 'utf8'), ts.ScriptTarget.ES2022, true);
    fieldPath = await loadFunction(sf, 'fieldPath') as (path?: string) => string;
  });

  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names a nested array item by its full path', function () {
    expect(fieldPath('/body/runtimeConfig/authorizedPrincipals/1')).to.equal('runtimeConfig.authorizedPrincipals[1]');
  });

  it('names a top-level body field, path parameter or query parameter as before', function () {
    expect(fieldPath('/body/top')).to.equal('top');
    expect(fieldPath('/params/id')).to.equal('id');
    expect(fieldPath('/query/limit')).to.equal('limit');
  });

  it('undoes JSON Pointer escapes', function () {
    expect(fieldPath('/body/odd~1key')).to.equal('odd/key');
    expect(fieldPath('/query/a~0b~1c')).to.equal('a~b/c');
  });

  it('keeps a bare location, and falls back when there is no path', function () {
    expect(fieldPath('/body')).to.equal('body');
    expect(fieldPath('/body/0')).to.equal('[0]');
    expect(fieldPath(undefined)).to.equal('unknown');
    expect(fieldPath('')).to.equal('unknown');
  });

  it('reports a format failure under that path', function () {
    const formatCase = find(sf, (n): n is ts.CaseClause => ts.isCaseClause(n)
      && ts.isStringLiteral(n.expression) && n.expression.text === 'format.openapi.validation');
    expect(formatCase, 'the format.openapi.validation case').to.not.equal(undefined);
    expect(formatCase!.getText(sf)).to.contain('new InvalidInputError(fieldPath(errorObj.path), errorObj.message');

    const error = new InvalidInputError(fieldPath('/body/runtimeConfig/authorizedPrincipals/0'), 'must match format "uuid"');
    expect(error.message).to.equal('Invalid runtimeConfig.authorizedPrincipals[0]: must match format "uuid"');
  });
});
