import axios, { type AxiosInstance } from 'axios';
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { Readable } from 'stream';
import ts from 'typescript';
import { pathToFileURL } from 'url';

const SPEC = `openapi: 3.0.3
info:
  title: api-client-bodies
  version: 1.0.0
servers:
  - url: /
paths:
  /things:
    get:
      operationId: listThings
      tags: [things]
      parameters:
        - { name: pageNumber, in: query, required: true, schema: { type: integer } }
        - { name: pageSize, in: query, required: true, schema: { type: integer } }
        - { name: X-Trace-Id, in: header, schema: { type: string } }
      responses:
        '200':
          description: A page of things
          headers:
            link:
              schema:
                type: array
                items:
                  type: string
            count:
              schema:
                type: integer
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Thing'
    post:
      operationId: createThing
      tags: [things]
      requestBody:
        required: true
        content:
          '*/*':
            schema:
              $ref: '#/components/schemas/Thing'
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
  /things/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getThing
      tags: [things]
      parameters:
        - { name: X-Trace-Id, in: header, schema: { type: string } }
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
    delete:
      operationId: deleteThing
      tags: [things]
      parameters:
        - { name: If-Match, in: header, schema: { type: string } }
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
  /things/{id}/label:
    put:
      operationId: setLabel
      tags: [things]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: If-Match, in: header, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: string
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
  /things/{id}/upload:
    post:
      operationId: uploadThing
      tags: [things]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: checksum, in: query, schema: { type: string } }
        - { name: If-Match, in: header, schema: { type: string } }
      requestBody:
        required: true
        content:
          '*/*':
            schema:
              type: string
              format: binary
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
  /things/{id}/report:
    post:
      operationId: uploadReport
      tags: [things]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/pdf:
            schema:
              type: string
              format: binary
      responses:
        '200':
          $ref: '#/components/responses/ThingResponse'
components:
  responses:
    ThingResponse:
      description: A thing
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Thing'
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id:
          type: string
`;

/** Type-checks the caller's view of RequestFile: every kind of body must be assignable to it. */
const REQUEST_FILE_CHECK = `
import type { Readable } from 'stream';
import type { RequestFile } from './out/model/index.js';

export function bodies(stream: Readable): RequestFile[] {
  return [
    'text',
    Buffer.from('bytes'),
    stream,
    new Blob(['bytes'], { type: 'application/pdf' }),
    { value: new Blob(['bytes']), options: { contentType: 'application/pdf' } },
  ];
}
`;

interface Received {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Type-checks the generated client the way an SDK compiles it (NodeNext, strict) and emits it to `js/`. It sees only the
 * ES libraries and @types/node, so a type that exists only in the DOM library would fail here.
 */
function compile(dir: string): string {
  const api = path.join(dir, 'out/api/ThingsApi.ts');
  const check = path.join(dir, 'check.ts');
  const nodeTypes = path.dirname(createRequire(__filename).resolve('@types/node/package.json'));
  const program = ts.createProgram([api, check], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noImplicitAny: false,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [path.dirname(nodeTypes)],
    rootDir: dir,
    outDir: path.join(dir, 'js'),
  });
  program.emit();
  const diagnostics = [api, check].flatMap((file) => ts.getPreEmitDiagnostics(program, program.getSourceFile(file)));
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => dir,
    getNewLine: () => '\n',
  });
}

/**
 * The api-client generator used to set no Content-Type on a binary body, so axios sent
 * `application/x-www-form-urlencoded`, whose body a gateway running a form parser never forwards. It also JSON-encoded a
 * RequestDetailedFile, sending the wrapper instead of the file, and dropped every declared header parameter. These
 * generate a client, compile it and call it over HTTP, with axios configured as BaseApiClient configures it.
 */
describe('api-client: binary bodies and header parameters', function () {
  this.timeout(120000);

  const THING = { id: 't-1' };
  const received: Received[] = [];
  let reply: (res: http.ServerResponse) => void;

  let dir: string;
  let diagnostics: string;
  let server: http.Server;
  let client: AxiosInstance;
  let api: any;

  const ok = (res: http.ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json', count: '1' });
    res.end(JSON.stringify(THING));
  };

  /** Runs one client call and returns the request that reached the server. */
  async function sent(call: (a: any) => Promise<unknown>): Promise<Received> {
    const before = received.length;
    await call(api);
    expect(received).to.have.lengthOf(before + 1);
    return received[before];
  }

  /** Runs one client call that must reject, and returns its error. */
  async function failure(call: (a: any) => Promise<unknown>): Promise<any> {
    try {
      await call(api);
    } catch (err) {
      return err;
    }
    throw new Error('Expected the call to reject');
  }

  before(async function () {
    const buildDir = path.join(__dirname, '../../build');
    fs.mkdirSync(buildDir, { recursive: true });
    dir = fs.mkdtempSync(path.join(buildDir, 'api-client-bodies-'));
    fs.writeFileSync(path.join(dir, 'api.yml'), SPEC);
    execFileSync(path.join(__dirname, '../../bin/hub-generator.js'), [
      'generate', '-g', 'api-client', '-i', path.join(dir, 'api.yml'), '-o', path.join(dir, 'out'), '--skip-validate-spec',
    ], { stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
    fs.writeFileSync(path.join(dir, 'check.ts'), REQUEST_FILE_CHECK);
    diagnostics = compile(dir);

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        reply(res);
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    client = axios.create({ baseURL: `http://127.0.0.1:${port}`, validateStatus: () => true });

    const { ThingsApiHttpImpl } = await import(pathToFileURL(path.join(dir, 'js/out/api/ThingsApi.js')).href);
    api = new ThingsApiHttpImpl(client);
  });

  beforeEach(function () {
    reply = ok;
  });

  after(async function () {
    await new Promise((resolve) => { server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compiles, with every kind of body assignable to RequestFile', function () {
    expect(diagnostics).to.equal('');
  });

  describe('Content-Type of a binary body', function () {
    it('sends a Buffer as application/octet-stream when the spec declares */*', async function () {
      const bytes = Buffer.from([0, 1, 2, 255]);
      const request = await sent((a) => a.uploadThing('t-1', bytes));
      expect(request.method).to.equal('POST');
      expect(request.url).to.equal('/things/t-1/upload');
      expect(request.headers['content-type']).to.equal('application/octet-stream');
      expect(request.headers['content-length']).to.equal('4');
      expect(request.body.equals(bytes)).to.equal(true);
    });

    it('sends a string the same way', async function () {
      const request = await sent((a) => a.uploadThing('t-1', 'name=Lobby&floor=2'));
      expect(request.headers['content-type']).to.equal('application/octet-stream');
      expect(request.body.toString()).to.equal('name=Lobby&floor=2');
    });

    it('streams a Readable, with no length', async function () {
      const request = await sent((a) => a.uploadThing('t-1', Readable.from([Buffer.from('name\n'), Buffer.from('Lobby\n')])));
      expect(request.headers['content-type']).to.equal('application/octet-stream');
      expect(request.headers['content-length']).to.equal(undefined);
      expect(request.headers['transfer-encoding']).to.equal('chunked');
      expect(request.body.toString()).to.equal('name\nLobby\n');
    });

    it('sends the media type the spec declares', async function () {
      const request = await sent((a) => a.uploadReport('t-1', Buffer.from('%PDF-1.7')));
      expect(request.headers['content-type']).to.equal('application/pdf');
    });

    it('takes the type from a Blob, and its length', async function () {
      const request = await sent((a) => a.uploadThing('t-1', new Blob(['%PDF-1.7'], { type: 'application/pdf' })));
      expect(request.headers['content-type']).to.equal('application/pdf');
      expect(request.headers['content-length']).to.equal('8');
      expect(request.body.toString()).to.equal('%PDF-1.7');
    });

    it('falls back to the declared type for a Blob without one', async function () {
      const octet = await sent((a) => a.uploadThing('t-1', new Blob(['bytes'])));
      expect(octet.headers['content-type']).to.equal('application/octet-stream');
      const pdf = await sent((a) => a.uploadReport('t-1', new Blob(['%PDF-1.7'])));
      expect(pdf.headers['content-type']).to.equal('application/pdf');
    });

    it('keeps the type of an empty Blob', async function () {
      const request = await sent((a) => a.uploadThing('t-1', new Blob([], { type: 'application/pdf' })));
      expect(request.headers['content-type']).to.equal('application/pdf');
      expect(request.body).to.have.lengthOf(0);
    });
  });

  describe('a RequestDetailedFile', function () {
    it('sends its value, with the type it names', async function () {
      const value = Buffer.from('%PDF-1.7');
      const request = await sent((a) => a.uploadThing('t-1', { value, options: { filename: 'plan.pdf', contentType: 'application/pdf' } }));
      expect(request.headers['content-type']).to.equal('application/pdf');
      expect(request.body.equals(value)).to.equal(true);
    });

    it('takes the declared type when it names none', async function () {
      const request = await sent((a) => a.uploadThing('t-1', { value: Buffer.from('bytes') }));
      expect(request.headers['content-type']).to.equal('application/octet-stream');
      expect(request.body.toString()).to.equal('bytes');
    });

    it('prefers the type it names to a Blob value\'s, and names one for a Blob without', async function () {
      const request = await sent((a) => a.uploadThing('t-1', {
        value: new Blob(['a,b\n'], { type: 'text/plain' }),
        options: { contentType: 'text/csv' },
      }));
      expect(request.headers['content-type']).to.equal('text/csv');
      expect(request.body.toString()).to.equal('a,b\n');
      const untyped = await sent((a) => a.uploadThing('t-1', { value: new Blob(['a,b\n']), options: { contentType: 'text/csv' } }));
      expect(untyped.headers['content-type']).to.equal('text/csv');
    });
  });

  it('sends JSON text byte for byte', async function () {
    const value = '{ "n": 1.0,   "big": 12345678901234567890 }\n';
    const request = await sent((a) => a.uploadThing('t-1', { value, options: { contentType: 'application/json' } }));
    expect(request.headers['content-type']).to.equal('application/json');
    expect(request.body.toString()).to.equal(value);
  });

  it('sends text that isn\'t JSON unquoted, whatever type it names', async function () {
    const request = await sent((a) => a.uploadThing('t-1', { value: 'not json', options: { contentType: 'application/json' } }));
    expect(request.body.toString()).to.equal('not json');
  });

  describe('responses to a binary body', function () {
    it('resolves a 2xx into the declared model', async function () {
      reply = (res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(THING));
      };
      expect(await api.uploadThing('t-1', Buffer.from('bytes'))).to.deep.include(THING);
    });

    it('fails on a redirect rather than following it', async function () {
      const before = received.length;
      reply = (res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/elsewhere` });
        res.end();
      };
      const err = await failure((a) => a.uploadThing('t-1', Buffer.from('bytes')));
      expect(err.response?.status).to.equal(307);
      expect(received).to.have.lengthOf(before + 1);
    });

    it('still reads an error response as the service\'s error', async function () {
      reply = (res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: 'err.forbidden', statusCode: 403 }));
      };
      const err = await failure((a) => a.uploadThing('t-1', Buffer.from('bytes')));
      expect(err.isAxiosError).to.equal(undefined);
    });
  });

  describe('header parameters', function () {
    it('sends one on a DELETE, in its declared name', async function () {
      const request = await sent((a) => a.deleteThing('t-1', '"v7"'));
      expect(request.method).to.equal('DELETE');
      expect(request.headers['if-match']).to.equal('"v7"');
    });

    it('sends one on a GET', async function () {
      const request = await sent((a) => a.getThing('t-1', 'trace-1'));
      expect(request.headers['x-trace-id']).to.equal('trace-1');
    });

    it('sends one on a paged GET', async function () {
      const results = { pageNumber: 1, pageSize: 10, count: 0, items: [], headers: {} };
      const request = await sent((a) => a.listThings(results, 'trace-1'));
      expect(request.headers['x-trace-id']).to.equal('trace-1');
      expect(request.url).to.include('pageSize=10');
    });

    it('sends one alongside a binary body, with its query parameters', async function () {
      const request = await sent((a) => a.uploadThing('t-1', Buffer.from('bytes'), 'abc123', '"v7"'));
      expect(request.url).to.equal('/things/t-1/upload?checksum=abc123');
      expect(request.headers['if-match']).to.equal('"v7"');
      expect(request.headers['content-type']).to.equal('application/octet-stream');
    });

    it('sends one alongside a primitive body, which stays JSON', async function () {
      const request = await sent((a) => a.setLabel('t-1', 'Lobby', '"v7"'));
      expect(request.headers['if-match']).to.equal('"v7"');
      expect(request.headers['content-type']).to.equal('application/json');
      expect(request.body.toString()).to.equal('"Lobby"');
    });

    it('leaves one out when it isn\'t given', async function () {
      const request = await sent((a) => a.deleteThing('t-1'));
      expect(request.headers).to.not.have.property('if-match');
    });
  });

  it('leaves an object body alone: it is sent as JSON, whatever the spec declares', async function () {
    const request = await sent((a) => a.createThing({ id: 't-2' }));
    expect(request.headers['content-type']).to.equal('application/json');
    expect(JSON.parse(request.body.toString())).to.deep.equal({ id: 't-2' });
  });
});
