# Changelog

All notable changes to @romatech/orm-providers-mongodb will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.1.0] - 2026-11-11

### Security
- **Queries ignored `where` (cross-tenant data exposure).** The filter translator expected an expression shape the ORM never produces, so every `where(...)` became `{}`: queries returned the whole collection and `skip`/`take` paged unfiltered data. Predicates are now translated to MongoDB filters (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, anchored and escaped `$regex` for `includes`/`startsWith`/`endsWith`, `$and`/`$or`), and every predicate, ordering, paging and projection is re-applied in memory, so results follow the JavaScript semantics of the query. The server filter is built to match a superset of what JavaScript accepts: bare members (`u.active`, `!u.deletedAt`) are sent as truthy/falsy tests (`$nin: [false, null]`, `$ne: true`) instead of `$eq: true/false`; negations (`!==`, `!includes`) also keep array fields; `x.length`, loose `==`/`!=`, relational comparisons with numeric-string, boolean or `null` literals, and multi-statement function bodies are evaluated in memory only; a relational comparison that JavaScript satisfies with `null` (`u.score < 10`, `u.score >= 0`, since `null` compares as 0) also matches `null` fields (`$or` with `$eq: null`); an untranslatable conjunct of an `&&` is evaluated in memory while the rest still filters on the server.
- **Operator injection through ids.** An id such as `{ $ne: null }` or `{ $gt: 0 }` (e.g. taken from a JSON body) made `find`/`update`/`remove` match, replace or delete an arbitrary document. Object and array ids are rejected with `TypeError: Invalid id`, lookups use `$eq`, and parsed field names starting with `$` are never sent to the server.

### Fixed
- **Transactions were never committed.** `Transaction.commit()/rollback()` call `executeQuery('COMMIT'|'ROLLBACK')`, which was a no-op. `BEGIN`/`COMMIT`/`ROLLBACK` now start, commit and abort the session transaction, and reads (`find`, `getAll`, queries) join the active transaction. A nested `beginTransaction()` throws. Transactions need a replica set or sharded cluster, as in MongoDB itself.
- **Paging with server-side matches that JavaScript rejects.** MongoDB can match more than the JavaScript predicate (a regex or `$eq` on an array field matches any element). Paging such a superset on the server returned the wrong page (e.g. `[]` instead of `[2]`). The server now applies only `limit(skip + take)`, the rows before the page are checked in memory too, and if any of them is a false match the query is fetched again without a limit. `skip` is no longer sent to the server.
- `saveChanges` clears its queue before running, so a failure no longer replays already-applied writes on the next call (E11000 on retry).
- The database name is read from the connection-string path only (`mongodb://h/shop?x=1` gave `shop?x=1`; `mongodb://h:27017` gave `h:27017`); without one, the driver default applies.
- `getColumnsForTable` reports `_id` as the `id` primary key, matching how documents are mapped to entities.

### Changed
- **Behaviour change:** raw SQL other than `BEGIN`/`COMMIT`/`ROLLBACK` throws instead of silently returning `[]`.
- **Behaviour change:** `createTable`/`dropTable` only ignore "namespace exists" (code 48) and "namespace not found" (code 26); other errors (authorization, network) are no longer swallowed.
- `addRange([])`/`removeRange([])` are no-ops (an empty `insertMany` was rejected by the driver).
- Server-side paging fetches the skipped rows as well (`limit(skip + take)`), which transfers more documents for deep pages.
- Standardized `index.html` landing page (GitHub Pages; not part of the npm package).

### Build / CI
- `package-lock.json` re-synced with `package.json` (it still pinned `@romatech/orm@1.2.0`, so `npm ci` failed).
- CI runs `npm ci`, build, tests, `npm audit --omit=dev` and `npm pack --dry-run` on Node 22 and 24, with read-only `contents` permission.
- The publish workflow installs with `npm ci` on Node 22 and no longer rewrites the `@romatech/orm` range in `package.json` at publish time.
- Added `npm test` (Node test runner, runs against `dist/`, so build first). Integration tests run when `MONGODB_TEST_URI` points to a replica set.

## [2.0.0] - 2026-06-26

### Changed
- Requires `@romatech/orm` `^2.0.0` (peer dependency). The details of this release were not recorded in this changelog at the time.

## [1.3.0] - 2026-06-18

### Added
- First release recorded in this changelog (this section was previously labelled 1.2.0, a version of this package that was never published).
- Full CRUD operations
- Transaction support (replica set)
- Migration history tracking
- Scaffold from existing collections
