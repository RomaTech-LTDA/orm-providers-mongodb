'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { getSelectorField, parsePredicate } = require('@romatech/orm');
const { MongoDbProvider } = require('../dist');

function queryObject(predicates, orderings = [], extra = {}) {
  return {
    includes: [],
    predicates,
    whereExpressions: predicates.map(p => parsePredicate(p)).filter(Boolean),
    orderings: orderings.map(selector => ({ selector, direction: 'asc' })),
    orderByExpressions: orderings
      .map(selector => ({ field: getSelectorField(selector), direction: 'asc' }))
      .filter(e => e.field),
    ...extra
  };
}

/** Provider wired to an in-memory fake collection that records the filters it receives. */
function fakeProvider(docs) {
  const calls = [];
  const collection = {
    find(filter, options) {
      const call = { op: 'find', filter, options, sort: undefined, skip: undefined, limit: undefined };
      calls.push(call);
      const cursor = {
        sort(s) { call.sort = s; return cursor; },
        skip(n) { call.skip = n; return cursor; },
        limit(n) { call.limit = n; return cursor; },
        // Like a server, honour skip/limit (the filter is not evaluated: the
        // fake plays a server whose filter matched every document given).
        async toArray() {
          const start = call.skip ?? 0;
          const end = call.limit ? start + call.limit : undefined;
          return docs.slice(start, end).map(d => ({ ...d }));
        }
      };
      return cursor;
    },
    async findOne(filter, options) { calls.push({ op: 'findOne', filter, options }); return null; },
    async deleteOne(filter, options) { calls.push({ op: 'deleteOne', filter, options }); },
    async insertOne(doc) { calls.push({ op: 'insertOne', doc }); }
  };
  const provider = new MongoDbProvider({ database: 'unit' });
  provider._db = { collection: () => collection };
  return { provider, calls };
}

/**
 * Minimal evaluator for the filter operators the provider emits, following
 * MongoDB semantics (array fields match when any element matches, typed
 * comparisons, `$eq: null` matches missing fields, path traversal into arrays).
 */
function valuesAt(doc, path) {
  let current = [doc];
  for (const key of path.split('.')) {
    const next = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        for (const element of value) if (element && typeof element === 'object') next.push(element[key]);
      } else if (value && typeof value === 'object') {
        next.push(value[key]);
      } else {
        next.push(undefined);
      }
    }
    current = next;
  }
  return current;
}
function candidates(values) {
  const out = [];
  for (const value of values) {
    out.push(value);
    if (Array.isArray(value)) out.push(...value);
  }
  return out;
}
function sameType(a, b) {
  const kind = v => (v instanceof Date ? 'date' : typeof v);
  return a !== null && a !== undefined && b !== null && b !== undefined && kind(a) === kind(b);
}
function eq(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  return a === b;
}
function matchCondition(values, condition) {
  const all = candidates(values);
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case '$eq': return all.some(v => eq(v, arg));
      case '$ne': return !all.some(v => eq(v, arg));
      case '$nin': return !all.some(v => arg.some(a => eq(v, a)));
      case '$gt': return all.some(v => sameType(v, arg) && v > arg);
      case '$gte': return all.some(v => sameType(v, arg) && v >= arg);
      case '$lt': return all.some(v => sameType(v, arg) && v < arg);
      case '$lte': return all.some(v => sameType(v, arg) && v <= arg);
      case '$regex': return all.some(v => typeof v === 'string' && arg.test(v));
      case '$not': return !all.some(v => typeof v === 'string' && arg.test(v));
      case '$type': return arg === 'array' && values.some(v => Array.isArray(v));
      default: throw new Error(`fake server: unsupported operator ${op}`);
    }
  });
}
function matchFilter(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return condition.every(part => matchFilter(doc, part));
    if (key === '$or') return condition.some(part => matchFilter(doc, part));
    return matchCondition(valuesAt(doc, key), condition);
  });
}
function evaluatingProvider(docs) {
  const calls = [];
  const collection = {
    find(filter) {
      const call = { filter, sort: undefined, limit: undefined };
      calls.push(call);
      const cursor = {
        sort(s) { call.sort = s; return cursor; },
        limit(n) { call.limit = n; return cursor; },
        async toArray() {
          const matched = docs.filter(d => matchFilter(d, filter));
          return (call.limit ? matched.slice(0, call.limit) : matched).map(d => ({ ...d }));
        }
      };
      return cursor;
    }
  };
  const provider = new MongoDbProvider({ database: 'unit' });
  provider._db = { collection: () => collection };
  return { provider, calls };
}

describe('query translation', () => {
  const docs = [
    { _id: 1, tenant: 'a', name: 'Ana' },
    { _id: 2, tenant: 'b', name: 'Bia' },
    { _id: 3, tenant: 'a', name: 'ana' }
  ];

  test('translates parsed predicates into a MongoDB filter and returns only matching rows', async () => {
    const { provider, calls } = fakeProvider(docs);
    const rows = await provider.executeQuery('users', queryObject([u => u.tenant === 'a' && u.id >= 1]));
    assert.deepEqual(calls[0].filter, { $and: [{ tenant: { $eq: 'a' } }, { _id: { $gte: 1 } }] });
    assert.deepEqual(rows.map(r => r.id), [1, 3]);
  });

  test('predicates that cannot be parsed are applied in memory and disable server paging', async () => {
    const { provider, calls } = fakeProvider(docs);
    const wanted = 'b';
    const rows = await provider.executeQuery('users', queryObject([u => u.tenant === wanted], [], { skip: 0, take: 1 }));
    assert.deepEqual(calls[0].filter, {});
    assert.equal(calls[0].limit, undefined);
    assert.deepEqual(rows.map(r => r.id), [2]);
  });

  test('string methods become anchored, escaped, case-sensitive regular expressions', async () => {
    const { provider, calls } = fakeProvider(docs);
    const rows = await provider.executeQuery('users', queryObject([u => u.name.startsWith('An')]));
    assert.deepEqual(calls[0].filter, { name: { $regex: /^An/ } });
    assert.deepEqual(rows.map(r => r.id), [1]);

    await provider.executeQuery('users', queryObject([u => u.name.includes('a.*(')]));
    assert.equal(calls[1].filter.name.$regex.source, 'a\\.\\*\\(');
  });

  test('ordering and a skip+take limit run on the server only when the whole query was translated', async () => {
    const { provider, calls } = fakeProvider(docs);
    await provider.executeQuery('users', queryObject([u => u.tenant === 'a'], [u => u.name], { skip: 1, take: 1 }));
    assert.deepEqual(calls[0].sort, { name: 1 });
    // The skipped rows are fetched too, so the in-memory predicates can check them.
    assert.equal(calls[0].skip, undefined);
    assert.equal(calls[0].limit, 2);
  });

  test('rows the server matches but JavaScript does not are not counted by skip', async () => {
    // Sorted by name, the server superset is [1, 2, 3]; only 2 and 3 really
    // match, so skip(1).take(1) must return 3. Skipping on the server would
    // skip the false match 1 and return 2.
    const tagged = [
      { _id: 1, tags: ['abc'], name: '0' },
      { _id: 2, tags: ['a'], name: 'a' },
      { _id: 3, tags: ['a'], name: 'b' }
    ];
    const { provider } = fakeProvider(tagged);
    const rows = await provider.executeQuery('items', queryObject([x => x.tags.includes('a')], [x => x.name], { skip: 1, take: 1 }));
    assert.deepEqual(rows.map(r => r.id), [3]);
  });

  test('a fully translated page without false matches is served by the first round trip', async () => {
    const sorted = [
      { _id: 1, tenant: 'a', name: 'a' },
      { _id: 2, tenant: 'a', name: 'b' },
      { _id: 3, tenant: 'a', name: 'c' }
    ];
    const { provider, calls } = fakeProvider(sorted);
    const rows = await provider.executeQuery('users', queryObject([u => u.tenant === 'a'], [u => u.name], { skip: 1, take: 1 }));
    assert.deepEqual(rows.map(r => r.id), [2]);
    assert.equal(calls.length, 1);
  });

  test('a server page that the in-memory predicates shrink is fetched again without server paging', async () => {
    // A regex matches any element of an array field, so the server returns a
    // superset of `tags.includes('a')`; paging that superset would lose rows.
    const tagged = [
      { _id: 1, tags: ['abc'], name: '0' },
      { _id: 2, tags: ['a'], name: 'a' }
    ];
    const { provider, calls } = fakeProvider(tagged);
    const rows = await provider.executeQuery('items', queryObject([x => x.tags.includes('a')], [x => x.name], { take: 1 }));
    assert.deepEqual(rows.map(r => r.id), [2]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].limit, undefined);
    assert.equal(calls[1].skip, undefined);
  });

  // The server filter must never be narrower than the JavaScript predicate:
  // rows it drops cannot be recovered by the in-memory re-filter. The fake
  // collection below evaluates the filter it receives, like a real server.
  describe('the server filter is never narrower than the JavaScript predicate', () => {
    const rows = [
      { _id: 1, deletedAt: null, active: 1, tags: ['ab'], items: [1], name: 'x', score: 5, address: [{ city: 'A' }] },
      { _id: 2, active: true, tags: [], items: [], name: 'y', score: 7, address: { city: 'B' } },
      { _id: 3, deletedAt: new Date(0), active: false, tags: ['a'], items: [1, 2], name: 'z', score: '7', address: { city: 'A' } }
    ];

    const cases = [
      ['falsy member (soft delete)', u => !u.deletedAt, [1, 2]],
      ['truthy member with a non-boolean value', u => u.active, [1, 2]],
      ['strict false', u => u.active === false, [3]],
      ['length of an array', u => u.items.length > 0, [1, 3]],
      ['negated includes on an array field', u => !u.tags.includes('a'), [1, 2]],
      ['!== on an array field', u => u.tags !== 'a', [1, 2, 3]],
      ['!== on a path through an array', u => u.address.city !== 'A', [1, 2]],
      ['loose equality with a numeric string', u => u.score == '7', [2, 3]],
      ['relational comparison with a numeric string', u => u.score > '6', [2, 3]],
      ['several statements in a function body', function (u) { if (u.score === 7) return u.name === 'q'; return u.name === 'x'; }, [1]],
      ['a translatable conjunct still reaches the server next to one that is not', u => u.name !== 'q' && !u.deletedAt, [1, 2]]
    ];

    for (const [name, predicate, expected] of cases) {
      test(name, async () => {
        const { provider, calls } = evaluatingProvider(rows);
        const result = await provider.executeQuery('users', queryObject([predicate]));
        assert.deepEqual(result.map(r => r.id), expected, JSON.stringify(calls[0].filter));
      });
    }

    test('a translatable conjunct is still sent to the server', async () => {
      const { provider, calls } = evaluatingProvider(rows);
      // The expression is given explicitly: whether the core parser emits it
      // depends on the @romatech/orm version, the translation must not.
      const query = queryObject([u => u.name === 'x' && u.items.length > 0]);
      query.whereExpressions = [{
        kind: 'logical',
        operator: 'and',
        expressions: [
          { kind: 'comparison', field: 'name', operator: '=', value: 'x' },
          { kind: 'comparison', field: 'items.length', operator: '>', value: 0 }
        ]
      }];
      const result = await provider.executeQuery('users', query);
      assert.deepEqual(calls[0].filter, { name: { $eq: 'x' } });
      assert.deepEqual(result.map(r => r.id), [1]);
    });

    test('ordering by a computed `length` is not sent to the server', async () => {
      const { provider, calls } = evaluatingProvider(rows);
      const result = await provider.executeQuery('users', queryObject([u => u.name !== 'q'], [u => u.tags.length], { take: 1 }));
      assert.equal(calls[0].sort, undefined);
      assert.equal(calls[0].limit, undefined);
      assert.deepEqual(result.map(r => r.id), [2]);
    });
  });

  test('an `id` comparison targets `_id` and converts ObjectId strings', async () => {
    const { provider, calls } = fakeProvider([]);
    const hex = new ObjectId().toHexString();
    await provider.executeQuery('users', queryObject([new Function('u', `return u.id === '${hex}'`)]));
    assert.ok(calls[0].filter._id.$eq instanceof ObjectId);
    assert.equal(calls[0].filter._id.$eq.toHexString(), hex);
  });
});

describe('operator injection through entity ids', () => {
  for (const method of ['find', 'remove', 'update']) {
    test(`${method}() rejects an object used as id`, async () => {
      const { provider, calls } = fakeProvider([]);
      await assert.rejects(() => provider[method]({ id: { $ne: null } }, 'users'), /Invalid id/);
      await provider.saveChanges();
      assert.deepEqual(calls, []);
    });
  }

  test('lookups use $eq so the value is always a literal', async () => {
    const { provider, calls } = fakeProvider([]);
    await provider.find({ id: 7 }, 'users');
    assert.deepEqual(calls[0].filter, { _id: { $eq: 7 } });
  });
});

describe('raw queries and unit of work', () => {
  test('raw SQL is rejected instead of silently returning nothing', async () => {
    const { provider } = fakeProvider([]);
    await assert.rejects(() => provider.executeQuery('DELETE FROM users', []), /does not support raw SQL/);
  });

  test('COMMIT/ROLLBACK issued by the core Transaction reach the session', async () => {
    const { provider } = fakeProvider([]);
    const events = [];
    provider._client = {
      startSession: () => ({
        startTransaction: () => events.push('start'),
        commitTransaction: async () => events.push('commit'),
        abortTransaction: async () => events.push('abort'),
        endSession: async () => events.push('end')
      })
    };
    await provider.beginTransaction();
    await provider.executeQuery('COMMIT', []);
    await provider.executeQuery('BEGIN', []);
    await provider.executeQuery('ROLLBACK', []);
    assert.deepEqual(events, ['start', 'commit', 'end', 'start', 'abort', 'end']);
  });

  test('a failed saveChanges does not replay already-applied writes', async () => {
    const { provider } = fakeProvider([]);
    let inserts = 0;
    provider._db = {
      collection: () => ({
        async insertOne() {
          inserts++;
          if (inserts === 2) throw Object.assign(new Error('duplicate'), { code: 11000 });
        }
      })
    };
    await provider.add({ id: 1 }, 'users');
    await provider.add({ id: 1 }, 'users');
    await assert.rejects(() => provider.saveChanges(), /duplicate/);
    await provider.saveChanges();
    assert.equal(inserts, 2);
  });

  test('addRange([]) is a no-op instead of an invalid empty insertMany', async () => {
    const { provider } = fakeProvider([]);
    await provider.addRange([], 'users');
    await provider.saveChanges();
  });
});

test('database name is read from the connection string path only', () => {
  assert.equal(new MongoDbProvider('mongodb://h:27017/shop?retryWrites=true')._options.database, 'shop');
  assert.equal(new MongoDbProvider('mongodb+srv://u:p@cluster.example.net/app')._options.database, 'app');
  assert.equal(new MongoDbProvider('mongodb://h:27017')._options.database, undefined);
  assert.equal(new MongoDbProvider('mongodb://h:27017/')._options.database, undefined);
});

// ─── Integration (needs a replica set: MONGODB_TEST_URI=mongodb://...) ────────

const uri = process.env.MONGODB_TEST_URI;

describe('integration with a real MongoDB', { skip: !uri && 'set MONGODB_TEST_URI to run' }, () => {
  test('filters, injection guard and transactions against the server', async () => {
    const database = `roma_test_${Date.now()}`;
    const provider = new MongoDbProvider({ uri, database });
    await provider.connect('');
    try {
      await provider.addRange([{ id: 1, tenant: 'a' }, { id: 2, tenant: 'b' }], 'users');
      await provider.saveChanges();

      const rows = await provider.executeQuery('users', queryObject([u => u.tenant === 'a']));
      assert.deepEqual(rows.map(r => r.id), [1]);
      await assert.rejects(() => provider.remove({ id: { $gt: 0 } }, 'users'), /Invalid id/);

      await provider.beginTransaction();
      await provider.add({ id: 3, tenant: 'tx' }, 'users');
      await provider.saveChanges();
      assert.ok(await provider.find({ id: 3 }, 'users'), 'reads inside the transaction see its writes');
      await provider.executeQuery('COMMIT', []);

      const other = new MongoDbProvider({ uri, database });
      await other.connect('');
      assert.ok(await other.find({ id: 3 }, 'users'), 'committed data is visible to other clients');
      await other.disconnect();

      // Same rows and predicates as the unit cases above, against the server.
      await provider.addRange([
        { id: 11, deletedAt: null, active: 1, tags: ['ab'], items: [1], name: 'x', score: 5, address: [{ city: 'A' }] },
        { id: 12, active: true, tags: [], items: [], name: 'y', score: 7, address: { city: 'B' } },
        { id: 13, deletedAt: new Date(0), active: false, tags: ['a'], items: [1, 2], name: 'z', score: '7', address: { city: 'A' } }
      ], 'mixed');
      await provider.saveChanges();
      const cases = [
        [u => !u.deletedAt, [11, 12]],
        [u => u.active, [11, 12]],
        [u => u.active === false, [13]],
        [u => u.items.length > 0, [11, 13]],
        [u => !u.tags.includes('a'), [11, 12]],
        [u => u.tags !== 'a', [11, 12, 13]],
        [u => u.address.city !== 'A', [11, 12]],
        [u => u.score == '7', [12, 13]],
        [u => u.score > '6', [12, 13]],
        [u => u.name !== 'q' && !u.deletedAt, [11, 12]]
      ];
      for (const [predicate, expected] of cases) {
        const found = await provider.executeQuery('mixed', queryObject([predicate], [x => x.name]));
        assert.deepEqual(found.map(r => r.id), expected, String(predicate));
      }
      const page = await provider.executeQuery('mixed', queryObject([u => u.tags.includes('a')], [x => x.name], { skip: 1, take: 1 }));
      assert.deepEqual(page.map(r => r.id), [], 'only id 13 really matches, so skip(1) leaves nothing');
    } finally {
      await provider._client.db(database).dropDatabase();
      await provider.disconnect();
    }
  });
});
