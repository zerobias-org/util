import axios, { type AxiosInstance } from 'axios';
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
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
      summary: Takes */* and /* too
      description: Takes any type, */* included, and /* this too.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: checksum, in: query, description: 'The MD5 of the contents, of any type: */* included', schema: { type: string } }
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
  /things/{id}/a*/b:
    get:
      operationId: getOddPath
      tags: [odds]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - name: order
          in: query
          schema:
            type: string
            enum: [asc, desc]
            x-enum-descriptions: ['Oldest first, never */ early', 'Newest first /* last']
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
  /things/{id}/contents:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getContents
      tags: [things]
      parameters:
        - { name: X-Trace-Id, in: header, schema: { type: string } }
      responses:
        '200':
          description: The thing's contents, of any type
          content:
            '*/*':
              schema:
                type: string
                format: binary
    put:
      operationId: renderContents
      tags: [things]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Thing'
      responses:
        '200':
          description: The thing rendered as a PDF
          content:
            application/pdf:
              schema:
                type: string
                format: binary
    delete:
      operationId: takeContents
      tags: [things]
      responses:
        '200':
          description: The contents that were removed
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary
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
      description: A thing, whose contents can be of any type, */* included
      required: [id]
      properties:
        id:
          type: string
          description: Its id, never /* a comment */
    MediaRange:
      type: string
      description: A media range, such as text/* or */*
      enum: ['text/*', 'image/png']
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

/** The syntax errors in every file the generator wrote, such as a comment that a star-slash in a description ended early. */
function syntaxErrors(dir: string): string {
  const files = fs.readdirSync(path.join(dir, 'out'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(dir, 'out', file));
  const program = ts.createProgram(files, { noResolve: true, noLib: true, target: ts.ScriptTarget.ES2022 });
  return ts.formatDiagnostics(program.getSyntacticDiagnostics(), {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => dir,
    getNewLine: () => '\n',
  });
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
 * generate a client, compile it and call it over HTTP, with axios configured as BaseApiClient configures it. They run
 * only on Node; axios sends bodies differently in a browser, so a change here needs checking in one as well.
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
  let ThingsApi: any;

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

    ({ ThingsApiHttpImpl: ThingsApi } = await import(pathToFileURL(path.join(dir, 'js/out/api/ThingsApi.js')).href));
    api = new ThingsApi(client);
  });

  beforeEach(function () {
    reply = ok;
  });

  after(async function () {
    await new Promise((resolve) => { server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compiles, with every kind of body assignable to RequestFile and a */ in a description', function () {
    expect(diagnostics).to.equal('');
  });

  it('writes no file whose comments a */ in the spec ended early', function () {
    expect(syntaxErrors(dir)).to.equal('');
  });

  it('keeps an enum value with a /* in it exact', function () {
    const model = fs.readFileSync(path.join(dir, 'out/model/MediaRange.ts'), 'utf8');
    expect(model).to.include("EnumValue.instance('MediaRange', 'Text', 'text/*')");
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

  describe('bodies that aren\'t a declared RequestFile', function () {
    it('sends a Uint8Array, and only the part of its buffer that it views', async function () {
      const whole = await sent((a) => a.uploadThing('t-1', new Uint8Array([97, 98, 99])));
      expect(whole.headers['content-type']).to.equal('application/octet-stream');
      expect(whole.body.toString()).to.equal('abc');
      const view = await sent((a) => a.uploadThing('t-1', new Uint8Array(new Uint8Array([120, 97, 98, 99, 120]).buffer, 1, 3)));
      expect(view.body.toString()).to.equal('abc');
    });

    it('sends an ArrayBuffer', async function () {
      const request = await sent((a) => a.uploadThing('t-1', new Uint8Array([97, 98, 99]).buffer));
      expect(request.headers['content-type']).to.equal('application/octet-stream');
      expect(request.body.toString()).to.equal('abc');
    });

    it('sends a plain object or an array as JSON, with a JSON type', async function () {
      const object = await sent((a) => a.uploadThing('t-1', { a: 1 }));
      expect(object.headers['content-type']).to.equal('application/json');
      expect(object.body.toString()).to.equal('{"a":1}');
      const array = await sent((a) => a.uploadThing('t-1', [1, 2]));
      expect(array.headers['content-type']).to.equal('application/json');
      expect(array.body.toString()).to.equal('[1,2]');
    });

    it('doesn\'t take an object\'s own type field for a media type', async function () {
      const request = await sent((a) => a.uploadThing('t-1', { type: 'note', a: 1 }));
      expect(request.headers['content-type']).to.equal('application/json');
      expect(JSON.parse(request.body.toString())).to.deep.equal({ type: 'note', a: 1 });
    });

    it('sends any other object as axios did before: a class instance, one without a prototype, a Date', async function () {
      class Note {
        constructor(readonly text: string) {}
      }
      const bare = Object.assign(Object.create(null), { a: 1 });
      for (const [body, json] of [[new Note('hi'), '{"text":"hi"}'], [bare, '{"a":1}'], [new Date(0), '"1970-01-01T00:00:00.000Z"']] as const) {
        const request = await sent((a) => a.uploadThing('t-1', body));
        expect(request.headers['content-type'], json).to.equal('application/json');
        expect(request.body.toString()).to.equal(json);
      }
    });

    it('doesn\'t take an object for a RequestDetailedFile when its value isn\'t contents', async function () {
      const request = await sent((a) => a.uploadThing('t-1', { value: null }));
      expect(request.headers['content-type']).to.equal('application/json');
      expect(request.body.toString()).to.equal('{"value":null}');
    });

    it('keeps the case of a type sent with a string or bytes', async function () {
      const contentType = 'multipart/mixed; boundary=AbC';
      for (const value of ['--AbC--', new Uint8Array(Buffer.from('--AbC--'))]) {
        const request = await sent((a) => a.uploadThing('t-1', { value, options: { contentType } }));
        expect(request.headers['content-type']).to.equal(contentType);
        expect(request.body.toString()).to.equal('--AbC--');
      }
    });

    it('sends an object whole when it has more than a value and options', async function () {
      const request = await sent((a) => a.uploadThing('t-1', { value: 'abc', other: 1 }));
      expect(request.headers['content-type']).to.equal('application/json');
      expect(JSON.parse(request.body.toString())).to.deep.equal({ value: 'abc', other: 1 });
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

  /**
   * An operation that returns a file used to get the body as axios reads text: decoded as UTF-8, which mangles any
   * byte that isn't, and then parsed as JSON when it could be. A file now comes back as its bytes.
   */
  describe('a file response', function () {
    // Bytes that are never UTF-8, then random ones.
    const FILE = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0xc3]), randomBytes(4096)]);
    const file = (body: Buffer, type: string) => (res: http.ServerResponse): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };

    it('returns a binary file byte for byte, as a Buffer', async function () {
      reply = file(FILE, 'application/octet-stream');
      const got = await api.getContents('t-1');
      expect(Buffer.isBuffer(got)).to.equal(true);
      expect(got.equals(FILE)).to.equal(true);
    });

    it('returns a text or JSON file as its bytes too, neither decoded nor parsed', async function () {
      const csv = Buffer.from('﻿café,1\n');
      reply = file(csv, 'text/csv; charset=utf-8');
      expect((await api.getContents('t-1')).equals(csv)).to.equal(true);
      reply = file(Buffer.from('{ "a": 1 }'), 'application/json');
      expect((await api.getContents('t-1')).toString()).to.equal('{ "a": 1 }');
    });

    it('returns an empty file as no bytes', async function () {
      reply = file(Buffer.alloc(0), 'text/plain');
      expect((await api.getContents('t-1')).length).to.equal(0);
    });

    it('returns a file from a PUT and a DELETE as well', async function () {
      reply = file(FILE, 'application/pdf');
      expect((await api.renderContents('t-1', THING)).equals(FILE)).to.equal(true);
      expect((await api.takeContents('t-1')).equals(FILE)).to.equal(true);
    });

    it('still sends its header parameters', async function () {
      reply = file(FILE, 'application/octet-stream');
      const request = await sent((a) => a.getContents('t-1', 'trace-7'));
      expect(request.headers['x-trace-id']).to.equal('trace-7');
    });

    it('throws the same error for an error response as an operation that returns a model', async function () {
      reply = (res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: 'err.no.such.object', statusCode: 404, args: { type: 'File', id: 't-1' } }));
      };
      const fromModel = await failure((a) => a.getThing('t-1'));
      const fromFile = await failure((a) => a.getContents('t-1'));
      expect(fromFile.isAxiosError).to.equal(undefined);
      expect(fromFile.constructor).to.equal(fromModel.constructor);
      expect(fromFile.message).to.equal(fromModel.message);
    });

    it('returns a Blob of the type the response names where axios gives an ArrayBuffer, as in a browser', async function () {
      const asInBrowser = axios.create({
        validateStatus: () => true,
        adapter: async (config) => ({
          data: new Uint8Array(FILE).buffer, status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, config,
        }),
      });
      const got = await new ThingsApi(asInBrowser).getContents('t-1');
      expect(got).to.be.instanceOf(Blob);
      expect(got.type).to.equal('image/png');
      expect(Buffer.from(await got.arrayBuffer()).equals(FILE)).to.equal(true);
    });

    it('leaves an operation that returns a model as it was', async function () {
      expect(await api.getThing('t-1')).to.deep.include(THING);
    });
  });
});
