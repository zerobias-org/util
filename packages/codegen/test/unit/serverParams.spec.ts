import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';
import { pathToFileURL } from 'url';

const SPEC = `openapi: 3.0.3
info:
  title: server-params
  version: 1.0.0
servers:
  - url: /
paths:
  /things:
    post:
      operationId: createThing
      tags: [things]
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
          description: The new thing's id
          content:
            application/json:
              schema:
                type: string
  /things/{thingId}:
    delete:
      operationId: deleteThing
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
      responses:
        '200':
          description: The deleted thing's id
          content:
            application/json:
              schema:
                type: string
`;

/**
 * The module package the controller imports, cut down to what it uses: `ThingsApi` has the signatures hub-module
 * generates for SPEC, and `ObjectSerializer` hands every value through unchanged.
 */
const MODULE_STUB = `
export interface ThingsApi {
  createThing(displayName?: string): Promise<string>;
  deleteThing(thingId: string, ifMatch?: string): Promise<string>;
}
export interface ServerParams {
  getThingsApi(): ThingsApi;
}
export type RequestFile = string | Buffer;
export interface RequestDetailedFile {
  value: RequestFile;
  options?: { filename?: string; contentType?: string; attachment?: boolean };
}
export const ObjectSerializer = {
  deserialize: (data: any, type: string, format?: string): any => data,
};
`;

/** Just enough of express for the controller, and an untyped stand-in for the core types it imports. */
const PACKAGE_STUBS = `
declare module 'express' {
  import type { IncomingHttpHeaders } from 'http';
  export interface Request {
    params: Record<string, string>;
    query: Record<string, unknown>;
    headers: IncomingHttpHeaders;
    body: any;
  }
  export interface Response {
    send(body?: unknown): Response;
  }
  export type NextFunction = (err?: unknown) => void;
  export interface Express {
    [method: string]: (path: string, handler: (req: Request, res: Response, next: NextFunction) => unknown) => void;
  }
}
declare module '@zerobias-org/types-core-js';
`;

/**
 * Type-checks the generated controller the way a module repo compiles it (NodeNext, strict) and emits it to `js/`.
 * Only the controller's own diagnostics count: the generated index.ts also imports packages this repo doesn't have.
 */
function compile(dir: string): string {
  const controller = path.join(dir, 'out/server/ThingsApiController.ts');
  const nodeTypes = path.dirname(createRequire(__filename).resolve('@types/node/package.json'));
  const program = ts.createProgram([controller, path.join(dir, 'stubs.d.ts')], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noImplicitAny: false,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [path.dirname(nodeTypes)],
    rootDir: dir,
    outDir: path.join(dir, 'js'),
  });
  program.emit();
  return ts.formatDiagnostics(ts.getPreEmitDiagnostics(program, program.getSourceFile(controller)), {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => dir,
    getNewLine: () => '\n',
  });
}

/**
 * Runs one operation of the compiled controller on a request shaped the way express hands one over, its header names
 * lowercased as Node delivers them, and returns the arguments the impl received.
 */
async function call(dir: string, operation: string, req: object): Promise<unknown[]> {
  const { ThingsApiController } = await import(pathToFileURL(path.join(dir, 'js/out/server/ThingsApiController.js')).href);
  const calls: unknown[][] = [];
  const impl = { [operation]: async (...args: unknown[]) => { calls.push(args); return 't-1'; } };
  const factory = { onRequest: async () => ({ getThingsApi: () => impl }), afterRequest: async () => undefined };
  const request = { params: {}, query: {}, headers: {}, body: {}, ...req };
  await new ThingsApiController(factory, '')[operation](request, { send: () => undefined }, () => undefined);
  expect(calls).to.have.lengthOf(1);
  return calls[0];
}

/**
 * hub-module-server used to declare a header or form parameter's variable under its name on the wire, while the impl
 * call passes the camelCase name: `If-Match` made a controller that doesn't compile, and `display_name` one that passes
 * an undeclared `displayName`. It also read a header in its declared case, but Node lowercases incoming header names, so
 * any header parameter with a capital read undefined. These generate a server, compile its controller and run it.
 */
describe('hub-module-server: header and form parameters', function () {
  this.timeout(120000);

  let dir: string;
  let diagnostics: string;

  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-server-params-'));
    fs.writeFileSync(path.join(dir, 'api.yml'), SPEC);
    execFileSync(path.join(__dirname, '../../bin/hub-generator.js'), [
      'generate', '-g', 'hub-module-server', '-i', path.join(dir, 'api.yml'), '-o', path.join(dir, 'out'),
      '-p', 'modulePackage=../../src',
    ], { stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/index.ts'), MODULE_STUB);
    fs.writeFileSync(path.join(dir, 'stubs.d.ts'), PACKAGE_STUBS);
    diagnostics = compile(dir);
  });

  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compiles against the module API it calls', function () {
    expect(diagnostics).to.equal('');
  });

  it('reads a header parameter under the lowercased name Node delivers it as', async function () {
    const req = { params: { thingId: 't-1' }, headers: { 'if-match': '"v7"' } };
    expect(await call(dir, 'deleteThing', req)).to.deep.equal(['t-1', '"v7"']);
  });

  it('passes a form field to the impl under its camelCase name', async function () {
    expect(await call(dir, 'createThing', { body: { display_name: 'Lobby' } })).to.deep.equal(['Lobby']);
  });
});
