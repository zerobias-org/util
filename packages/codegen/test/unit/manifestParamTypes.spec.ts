import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A module container exposes its impl through two generated entry points, and they used to
 * disagree. The REST controllers deserialize every param before invoking the impl; the
 * wire-protocol route that Hub Node actually uses in production handed raw JSON straight through.
 * Harmless until codegen 3.x began emitting DateTime/DateFormat wrappers, at which point a
 * regenerated module's mapper called .toDate() on what was still an ISO string.
 *
 * Fixing that needed types the manifest never carried: operationParams listed names only. These
 * assertions fingerprint the block that adds them, so a future template edit that drops it fails
 * here rather than silently restoring the pass-through.
 */
describe('hub-module manifest: operation parameter types', function () {
  const tmplPath = path.join(__dirname, '../../src/main/resources/hub-module/manifest.mustache');
  const tmpl = fs.readFileSync(tmplPath, 'utf-8');

  it('still emits operationParamTypes', function () {
    expect(tmpl).to.include('"operationParamTypes"');
  });

  it('emits a name, a type and a format for each parameter', function () {
    expect(tmpl).to.include('{"name": "{{paramName}}"');
    // datatypeWithEnum when the generator has one (it names inline enums), dataType otherwise —
    // mirroring how the REST controller template picks between them.
    expect(tmpl).to.include('{{#datatypeWithEnum}}{{{datatypeWithEnum}}}{{/datatypeWithEnum}}');
    expect(tmpl).to.include('{{^datatypeWithEnum}}{{{dataType}}}{{/datatypeWithEnum}}');
    expect(tmpl).to.include('{{#dataFormat}}, "format": "{{{dataFormat}}}"{{/dataFormat}}');
  });

  it('keeps operationParams, which older modules still resolve names from', function () {
    // The server-entry falls back to name-only resolution when a manifest predates
    // operationParamTypes, so removing this would break every module built before the change.
    expect(tmpl).to.include('"operationParams"');
  });
});
