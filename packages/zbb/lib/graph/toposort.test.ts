import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toposort, getTransitiveDependents } from './toposort.js';

interface Node {
  id: string;
  deps: string[];
}

const node = (id: string, deps: string[] = []): Node => ({ id, deps });
const getId = (n: Node) => n.id;
const getDeps = (n: Node) => n.deps;

describe('toposort', () => {
  it('sorts a linear chain (A → B → C)', () => {
    const items = [node('A', ['B']), node('B', ['C']), node('C')];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(cycles.length, 0);
    const ids = sorted.map(n => n.id);
    // C before B, B before A
    assert.ok(ids.indexOf('C') < ids.indexOf('B'));
    assert.ok(ids.indexOf('B') < ids.indexOf('A'));
  });

  it('sorts a diamond (A → B+C, B → D, C → D)', () => {
    const items = [
      node('A', ['B', 'C']),
      node('B', ['D']),
      node('C', ['D']),
      node('D'),
    ];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(cycles.length, 0);
    const ids = sorted.map(n => n.id);
    assert.ok(ids.indexOf('D') < ids.indexOf('B'));
    assert.ok(ids.indexOf('D') < ids.indexOf('C'));
    assert.ok(ids.indexOf('B') < ids.indexOf('A'));
    assert.ok(ids.indexOf('C') < ids.indexOf('A'));
  });

  it('detects a cycle (A → B → C → A)', () => {
    const items = [
      node('A', ['B']),
      node('B', ['C']),
      node('C', ['A']),
    ];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(sorted.length, 0);
    assert.equal(cycles.length, 3);
    const cycleIds = cycles.map(n => n.id);
    assert.ok(cycleIds.includes('A'));
    assert.ok(cycleIds.includes('B'));
    assert.ok(cycleIds.includes('C'));
  });

  it('handles a single item with no deps', () => {
    const items = [node('A')];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(cycles.length, 0);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].id, 'A');
  });

  it('handles disconnected items (no deps between them)', () => {
    const items = [node('A'), node('B'), node('C')];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(cycles.length, 0);
    assert.equal(sorted.length, 3);
    const ids = sorted.map(n => n.id);
    assert.ok(ids.includes('A'));
    assert.ok(ids.includes('B'));
    assert.ok(ids.includes('C'));
  });

  it('ignores deps not in the item set', () => {
    const items = [node('A', ['EXTERNAL']), node('B')];
    const { sorted, cycles } = toposort(items, getId, getDeps);
    assert.equal(cycles.length, 0);
    assert.equal(sorted.length, 2);
  });
});

describe('getTransitiveDependents', () => {
  it('finds all transitive dependents', () => {
    // C depends on B, B depends on A → dependents of A = {B, C}
    const items = [
      node('A'),
      node('B', ['A']),
      node('C', ['B']),
    ];
    const result = getTransitiveDependents(items, getId, getDeps, 'A');
    assert.ok(result.has('B'));
    assert.ok(result.has('C'));
    assert.equal(result.size, 2);
  });

  it('returns empty set for leaf nodes', () => {
    const items = [node('A', ['B']), node('B')];
    const result = getTransitiveDependents(items, getId, getDeps, 'A');
    assert.equal(result.size, 0);
  });
});
