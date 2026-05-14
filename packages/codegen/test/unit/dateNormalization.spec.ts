import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

// Mirror of the date-time canonicalization block emitted into every
// generated ObjectSerializer.deserialize() by:
//   src/main/resources/api-client/models.mustache
//   src/main/resources/hub-module/models.mustache
//
// If you change either template, update this function and add a case to
// the table below. The integrityCheck test below also asserts that the
// template still contains this exact normalization shape so we catch drift.
function normalizeDateTime(input: unknown, format: string): unknown {
  let sanitizedData: unknown = input;
  if (
    typeof sanitizedData === 'string'
    && (format === 'date-time' || format === 'time' || format === 'timestamp')
  ) {
    if (format === 'date-time' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(sanitizedData)) {
      sanitizedData = sanitizedData.replace(' ', 'T');
    }
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(sanitizedData as string)) {
      sanitizedData = (sanitizedData as string) + 'Z';
    } else if (format === 'date-time' && !/Z$/.test(sanitizedData as string)) {
      const d = new Date(sanitizedData as string);
      if (!isNaN(d.getTime())) {
        sanitizedData = d.toISOString();
      }
    }
  }
  return sanitizedData;
}

// Matches the DateTime CoreType pattern in @zerobias-org/types-core-js.
// (Strict RFC3339 Z-only form; offsets are intentionally rejected so that
//  normalizeDateTime has a clear contract about what it must produce.)
const DATETIME_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

describe('date-time normalization (ObjectSerializer.deserialize)', function () {
  const cases: Array<{
    label: string;
    input: string;
    expected: string;
    epochMs?: number;
  }> = [
    {
      label: 'UTC offset +00:00 (PG JSONB to_jsonb(timestamptz))',
      input: '2026-05-14T14:39:50.795+00:00',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
    {
      label: 'already canonical Z form',
      input: '2026-05-14T14:39:50.795Z',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
    {
      label: 'no TZ designator (treat as UTC)',
      input: '2026-05-14T14:39:50.795',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
    {
      label: 'no fractional seconds, no TZ',
      input: '2026-05-14T14:39:50',
      expected: '2026-05-14T14:39:50Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 0),
    },
    {
      label: 'UTC offset +0000 (ISO 8601 short form, no colon)',
      input: '2026-05-14T14:39:50.795+0000',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
    {
      label: 'positive non-zero offset +05:30 (shifted into UTC)',
      input: '2026-05-14T14:39:50.795+05:30',
      expected: '2026-05-14T09:09:50.795Z',
      // 14:39:50.795 +05:30 == 09:09:50.795 UTC
      epochMs: Date.UTC(2026, 4, 14, 9, 9, 50, 795),
    },
    {
      label: 'negative offset -08:00 (shifted into UTC)',
      input: '2026-05-14T14:39:50.795-08:00',
      expected: '2026-05-14T22:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 22, 39, 50, 795),
    },
    {
      label: 'space separator instead of T, with offset',
      input: '2026-05-14 14:39:50.795+00:00',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
    {
      label: 'space separator, no TZ',
      input: '2026-05-14 14:39:50.795',
      expected: '2026-05-14T14:39:50.795Z',
      epochMs: Date.UTC(2026, 4, 14, 14, 39, 50, 795),
    },
  ];

  for (const c of cases) {
    it(`${c.label}: "${c.input}" → "${c.expected}"`, function () {
      const out = normalizeDateTime(c.input, 'date-time') as string;
      expect(out).to.equal(c.expected);
      expect(out).to.match(
        DATETIME_PATTERN,
        'normalized output must satisfy the DateTime CoreType pattern',
      );
      if (c.epochMs !== undefined) {
        expect(new Date(out).getTime()).to.equal(
          c.epochMs,
          'normalization must preserve the instant in time',
        );
      }
    });
  }

  it('non-string values pass through unchanged', function () {
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      new Date('2026-05-14T14:39:50.795Z'),
      { foo: 'bar' },
    ];
    for (const v of inputs) {
      expect(normalizeDateTime(v, 'date-time')).to.equal(v);
    }
  });

  it('non-date formats pass through unchanged', function () {
    expect(normalizeDateTime('2026-05-14T14:39:50.795+00:00', 'uuid'))
      .to.equal('2026-05-14T14:39:50.795+00:00');
  });

  it('time format with no TZ gets Z appended (no Date round-trip)', function () {
    // time format intentionally skips the new Date(...) canonicalization
    // because JS Date doesn't parse standalone time strings.
    expect(normalizeDateTime('14:39:50.795', 'time')).to.equal('14:39:50.795Z');
  });

  describe('template integrity', function () {
    const templates = [
      path.join(
        __dirname,
        '../../src/main/resources/api-client/models.mustache',
      ),
      path.join(
        __dirname,
        '../../src/main/resources/hub-module/models.mustache',
      ),
    ];

    for (const tmplPath of templates) {
      it(`${path.basename(path.dirname(tmplPath))}/models.mustache still contains the normalization markers`, function () {
        const tmpl = fs.readFileSync(tmplPath, 'utf-8');
        // These three substrings together fingerprint the patched block.
        // If a future template change drops any of them, this test fails
        // and we know to also update normalizeDateTime() above.
        expect(tmpl).to.include(
          "format === 'date-time' || format === 'time' || format === 'timestamp'",
        );
        expect(tmpl).to.include('[+-]\\d{2}:?\\d{2}');
        expect(tmpl).to.include('d.toISOString()');
      });
    }
  });
});
