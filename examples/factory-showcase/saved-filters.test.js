import test from 'node:test';
import assert from 'node:assert/strict';
import { saveFilter } from './saved-filters.js';

test('saves a named filter', () => {
  assert.deepEqual(saveFilter([], { name: 'Open bugs', query: 'is:open label:bug' }), [
    { name: 'Open bugs', query: 'is:open label:bug' },
  ]);
});

test('rejects duplicate names without changing existing filters', () => {
  const existing = [{ name: 'Open bugs', query: 'is:open label:bug' }];
  assert.throws(
    () => saveFilter(existing, { name: 'open BUGS', query: 'is:open' }),
    /already exists/,
  );
  assert.equal(existing.length, 1);
});
