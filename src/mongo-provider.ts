import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { applyClientSideQuery } from '@romatech/orm';
import type { IDbProvider, TableColumnInfo } from '@romatech/orm';
import type { QueryExpression, QueryObject } from '@romatech/orm';

/**
 * Configuration options for the MongoDB provider.
 */
export interface MongoDbProviderOptions {
  /** MongoDB connection URI. Example: mongodb://localhost:27017 */
  uri?: string;
  /** Database name. When omitted, the database in the URI (or `test`) is used. */
  database: string;
  /** Additional MongoClient options. */
  clientOptions?: Record<string, unknown>;
}

/**
 * MongoDB provider for RomaTech ORM.
 *
 * Maps ORM entities to MongoDB collections. Each entity class maps to a
 * collection (table name = collection name). Documents are stored as-is
 * with the primary key field mapped to `_id`.
 *
 * Queries: predicates the ORM could parse are translated to a MongoDB filter;
 * every predicate, ordering, skip/take and projection is then also applied in
 * memory, so results always match the JavaScript semantics of the query.
 *
 * Transactions (`DbContext.beginTransaction()`) need a replica set or sharded
 * cluster, as in MongoDB itself.
 *
 * @example
 * ```ts
 * import { MongoDbProvider } from '@romatech/orm-providers-mongodb';
 *
 * class AppDbContext extends DbContext {
 *     users = this.set(User);
 *
 *     constructor() {
 *         super(
 *             new DbContextOptions().useProvider(
 *                 new MongoDbProvider({
 *                     uri: 'mongodb://localhost:27017',
 *                     database: 'myapp',
 *                 })
 *             )
 *         );
 *     }
 * }
 * ```
 */
export class MongoDbProvider implements IDbProvider {
  private _client: MongoClient | null = null;
  private _db: Db | null = null;
  private _session: any = null;
  private readonly _options: { uri?: string; database?: string; clientOptions?: Record<string, unknown> };
  private readonly _pendingOps: Array<() => Promise<void>> = [];
  private readonly _migrationCollection = '__roma_migrations';

  readonly supportsTransactions = true;

  constructor(optionsOrUri: MongoDbProviderOptions | string) {
    if (typeof optionsOrUri === 'string') {
      this._options = {
        uri: optionsOrUri,
        database: databaseFromUri(optionsOrUri),
      };
    } else {
      this._options = optionsOrUri;
    }
  }

  // ─── Connection ──────────────────────────────────────────────────────────────

  async connect(connectionString: string): Promise<void> {
    const uri = connectionString || this._options.uri || 'mongodb://localhost:27017';
    this._client = new MongoClient(uri, this._options.clientOptions as any);
    await this._client.connect();
    // `undefined` lets the driver use the database named in the URI (or `test`).
    this._db = this._client.db(this._options.database || undefined);
  }

  async disconnect(): Promise<void> {
    if (this._client) {
      await this.endSession();
      await this._client.close();
      this._client = null;
      this._db = null;
    }
  }

  private getCollection(name: string): Collection {
    if (!this._db) throw new Error('Not connected. Call connect() first.');
    return this._db.collection(name);
  }

  /** Options shared by every operation so they join the active transaction. */
  private get sessionOptions(): { session?: any } {
    return this._session ? { session: this._session } : {};
  }

  // ─── Transactions ────────────────────────────────────────────────────────────

  async beginTransaction(): Promise<void> {
    if (!this._client) throw new Error('Not connected');
    if (this._session) throw new Error('A transaction is already active.');
    this._session = this._client.startSession();
    this._session.startTransaction();
  }

  async commitTransaction(): Promise<void> {
    if (this._session) {
      try {
        await this._session.commitTransaction();
      } finally {
        await this.endSession();
      }
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (this._session) {
      try {
        await this._session.abortTransaction();
      } finally {
        await this.endSession();
      }
    }
  }

  private async endSession(): Promise<void> {
    const session = this._session;
    this._session = null;
    if (session) {
      await session.endSession();
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const doc = this.toDocument(entity);
      await col.insertOne(doc, this.sessionOptions);
    });
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    if (entities.length === 0) return; // insertMany rejects an empty batch
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const docs = entities.map((e) => this.toDocument(e));
      await col.insertMany(docs, this.sessionOptions);
    });
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const id = this.toObjectId(this.entityId(entity));
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const doc = this.toDocument(entity);
      await col.replaceOne({ _id: { $eq: id } }, doc, this.sessionOptions);
    });
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const id = this.toObjectId(this.entityId(entity));
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      await col.deleteOne({ _id: { $eq: id } }, this.sessionOptions);
    });
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    if (entities.length === 0) return;
    const ids = entities.map((e) => this.toObjectId(this.entityId(e)));
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      await col.deleteMany({ _id: { $in: ids } }, this.sessionOptions);
    });
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const col = this.getCollection(tableName);
    const id = this.toObjectId(this.entityId(entity));
    const doc = await col.findOne({ _id: { $eq: id } }, this.sessionOptions);
    return doc ? this.fromDocument<T>(doc) : undefined;
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    const col = this.getCollection(tableName);
    const docs = await col.find({}, this.sessionOptions).toArray();
    return docs.map((d) => this.fromDocument<T>(d));
  }

  // ─── Unit of Work ────────────────────────────────────────────────────────────

  /**
   * Runs the queued writes in order. The queue is cleared before running, so
   * a failure never causes already-applied writes to be replayed later (the
   * same contract as `DbSet.flushChanges()`).
   */
  async saveChanges(): Promise<void> {
    const ops = this._pendingOps.splice(0);
    for (const op of ops) {
      await op();
    }
  }

  // ─── Query Execution ─────────────────────────────────────────────────────────

  async executeQuery<T = any>(queryOrEntityName: string, paramsOrQuery?: any[] | QueryObject<any, any>): Promise<T[]> {
    if (Array.isArray(paramsOrQuery) || paramsOrQuery === undefined) {
      // The core drives transactions through raw BEGIN/COMMIT/ROLLBACK
      // (see Transaction.commit()/rollback()); anything else is SQL that
      // MongoDB cannot run, so fail loudly instead of returning nothing.
      switch (queryOrEntityName.trim().replace(/;\s*$/, '').toUpperCase()) {
        case 'BEGIN':
        case 'BEGIN TRANSACTION':
        case 'START TRANSACTION':
          await this.beginTransaction();
          return [];
        case 'COMMIT':
        case 'COMMIT TRANSACTION':
          await this.commitTransaction();
          return [];
        case 'ROLLBACK':
        case 'ROLLBACK TRANSACTION':
          await this.rollbackTransaction();
          return [];
        default:
          throw new Error('MongoDbProvider does not support raw SQL queries; use the query API (where/orderBy/...) instead.');
      }
    }

    const entityName = queryOrEntityName;
    const query = paramsOrQuery as QueryObject<any, any>;
    const col = this.getCollection(entityName);

    const filter = this.buildMongoFilter(query);
    const sort = this.buildMongoSort(query);
    let cursor = col.find(filter ?? {}, this.sessionOptions);
    if (sort && Object.keys(sort).length > 0) {
      cursor = cursor.sort(sort);
    }

    // A server-side limit is only safe when the server already applied the
    // complete filter and ordering; otherwise it would cut the wrong rows.
    // The skipped rows are fetched too (limit = skip + take, no server skip):
    // MongoDB can match more than the JavaScript predicate (a regex or $eq on
    // an array field matches any element), so every row before the page must
    // be checked in memory, or a false match would be counted by `skip`.
    const serverPaging = filter !== undefined && sort !== undefined;
    const serverLimit = serverPaging && query.take !== undefined ? (query.skip ?? 0) + query.take : undefined;
    if (serverLimit !== undefined && serverLimit > 0) {
      cursor = cursor.limit(serverLimit);
    }

    const docs = await cursor.toArray();
    const results = docs.map((d) => this.fromDocument<any>(d));

    // If the in-memory predicates drop any of the limited rows, the window
    // was computed over the wrong set: fetch again without a limit.
    if (serverLimit !== undefined && serverLimit > 0
      && applyClientSideQuery(results, { ...query, skip: undefined, take: undefined, selector: undefined }).length !== results.length) {
      let retry = col.find(filter ?? {}, this.sessionOptions);
      if (sort && Object.keys(sort).length > 0) retry = retry.sort(sort);
      const all = (await retry.toArray()).map((d) => this.fromDocument<any>(d));
      return applyClientSideQuery(all, query) as T[];
    }

    // Re-apply predicates, ordering, paging and projection in memory: this
    // covers predicates that could not be translated and keeps JavaScript
    // semantics (e.g. case-sensitive matching) for the ones that were.
    return applyClientSideQuery(results, query) as T[];
  }

  // ─── Migrations ──────────────────────────────────────────────────────────────

  async addMigration(migrationName: string, _migrationScript: string): Promise<void> {
    const col = this.getCollection(this._migrationCollection);
    await col.insertOne({ name: migrationName, appliedAt: new Date() });
  }

  async removeMigration(migrationName: string): Promise<void> {
    const col = this.getCollection(this._migrationCollection);
    await col.deleteOne({ name: { $eq: migrationName } });
  }

  async applyMigrations(): Promise<void> {
    // No-op for MongoDB — schema-less
  }

  async getMigrations(): Promise<string[]> {
    return this.getMigrationHistory();
  }

  async getMigrationHistory(): Promise<string[]> {
    const col = this.getCollection(this._migrationCollection);
    const docs = await col.find({}).sort({ appliedAt: 1 }).toArray();
    return docs.map((d) => d.name);
  }

  async updateDatabase(_targetMigration?: string): Promise<void> {
    // MongoDB is schema-less — migrations are tracked but don't alter schema
  }

  async downgradeDatabase(_targetMigration?: string): Promise<void> {
    // MongoDB is schema-less
  }

  // ─── Schema Management ───────────────────────────────────────────────────────

  async createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void> {
    // Create collection (MongoDB creates on first insert, but explicit creation supports validators)
    if (!this._db) throw new Error('Not connected');
    try {
      await this._db.createCollection(input.tableName);
    } catch (error: any) {
      // 48 = NamespaceExists: the collection is already there.
      if (error?.code !== 48) throw error;
    }
  }

  async dropTable(tableName: string): Promise<void> {
    const col = this.getCollection(tableName);
    try {
      await col.drop();
    } catch (error: any) {
      // 26 = NamespaceNotFound (older servers); newer servers succeed silently.
      if (error?.code !== 26) throw error;
    }
  }

  async addColumn(_tableName: string, _column: TableColumnInfo): Promise<void> {
    // No-op for MongoDB — schema-less
  }

  async removeColumn(_tableName: string, _columnName: string): Promise<void> {
    // No-op for MongoDB — schema-less
  }

  // ─── Scaffold ────────────────────────────────────────────────────────────────

  async scaffold(_connectionString: string): Promise<void> {
    // Scaffold reads collections and infers types from sample documents
  }

  async getTables(): Promise<string[]> {
    if (!this._db) throw new Error('Not connected');
    const collections = await this._db.listCollections().toArray();
    return collections
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.') && n !== this._migrationCollection);
  }

  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    const col = this.getCollection(table);
    const sample = await col.findOne({});
    if (!sample) return [];

    // `_id` is exposed to entities as `id` (see fromDocument), and is the key.
    return Object.entries(sample).map(([key, value]) => key === '_id'
      ? { name: 'id', primaryKey: true, tsType: value instanceof ObjectId ? 'string' : this.inferTsType(value) }
      : { name: key, primaryKey: false, tsType: this.inferTsType(value) });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private entityId(entity: any): unknown {
    return entity?.id ?? entity?._id;
  }

  private toDocument(entity: any): any {
    const doc = { ...entity };
    if (doc.id !== undefined) {
      doc._id = this.toObjectId(doc.id);
      delete doc.id;
    }
    return doc;
  }

  private fromDocument<T>(doc: any): T {
    const entity = { ...doc };
    if (entity._id !== undefined) {
      entity.id = entity._id instanceof ObjectId ? entity._id.toHexString() : entity._id;
      delete entity._id;
    }
    return entity as T;
  }

  /**
   * Normalises a key value. Plain objects are rejected: a value such as
   * `{ $ne: null }` coming from user input would otherwise act as a query
   * operator and match (or delete) arbitrary documents.
   */
  private toObjectId(id: any): any {
    if (id instanceof ObjectId) return id;
    if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
    if (id !== null && typeof id === 'object' && !(id instanceof Date)) {
      throw new TypeError('Invalid id: expected a string, number, Date or ObjectId.');
    }
    return id; // numeric or other scalar types used as-is
  }

  /**
   * Translates the parsed predicates into a MongoDB filter that matches a
   * SUPERSET of the rows the JavaScript predicates accept (the caller always
   * re-applies them in memory, but cannot recover rows the server dropped).
   * Conjuncts that cannot be expressed that way are left out (a smaller `$and`
   * is still a superset). Returns `undefined` when the parsed expressions
   * cannot be matched to their predicates; the caller then filters in memory.
   */
  private buildMongoFilter(query: QueryObject<any, any>): Record<string, any> | undefined {
    const predicates = query.predicates ?? [];
    const expressions = query.whereExpressions ?? [];
    if (predicates.length === 0) return {};
    if (predicates.length !== expressions.length) return undefined;

    const conditions: Record<string, any>[] = [];
    expressions.forEach((expr, index) => {
      // The ORM parser maps loose `==`/`!=` to strict equality and reads only
      // the first `return` of a block body; neither is safe to send.
      if (!isTranslatablePredicate(predicates[index])) return;
      const condition = this.translateExpression(expr);
      if (condition) conditions.push(condition);
    });
    if (conditions.length === 0) return {};
    return conditions.length === 1 ? conditions[0] : { $and: conditions };
  }

  /** Builds the server-side sort, or `undefined` if some ordering was not parsed. */
  private buildMongoSort(query: QueryObject<any, any>): Record<string, 1 | -1> | undefined {
    const orderings = query.orderings ?? [];
    const expressions = query.orderByExpressions ?? [];
    if (orderings.length !== expressions.length) return undefined;

    const sort: Record<string, 1 | -1> = {};
    for (const expr of expressions) {
      const field = this.toFieldPath(expr.field);
      if (!field) return undefined;
      sort[field] = expr.direction === 'desc' ? -1 : 1;
    }
    return sort;
  }

  /**
   * Translates one parsed expression into a filter that matches at least
   * every document the JavaScript expression accepts, or `null` when no such
   * filter is known (the expression is then evaluated in memory only).
   *
   * MongoDB differs from JavaScript in ways that would otherwise drop rows:
   * comparisons are typed (`'7'` never equals `7`), a condition on an array
   * field is tested against each element, and `$ne`/`$not` exclude a document
   * when ANY element matches. Bare members (`u.flag`, `!u.flag`) arrive as
   * `= true`/`= false` but mean truthy/falsy in JavaScript.
   */
  private translateExpression(expr: QueryExpression): Record<string, any> | null {
    if (expr.kind === 'logical') {
      const parts = expr.expressions.map((part) => this.translateExpression(part));
      if (expr.operator === 'or') {
        return parts.length > 0 && parts.every(Boolean) ? { $or: parts } : null;
      }
      // Leaving out an untranslatable conjunct keeps the filter a superset.
      const known = parts.filter((part): part is Record<string, any> => part !== null);
      if (known.length === 0) return null;
      return known.length === 1 ? known[0] : { $and: known };
    }

    const field = this.toFieldPath(expr.field);
    if (!field) return null;
    const value = field === '_id' ? this.toFilterId(expr.value) : expr.value;
    if (value === INVALID) return null;
    // Through an array of sub-documents a dotted path is undefined in
    // JavaScript but matches element values in MongoDB: negations would drop
    // documents JavaScript keeps.
    const dotted = field.includes('.');
    // A whole-array value always satisfies these negations in JavaScript.
    const orArray = (condition: Record<string, any>) => field === '_id'
      ? { [field]: condition }
      : { $or: [{ [field]: condition }, { [field]: { $type: 'array' } }] };

    switch (expr.operator) {
      case '=':
        // Truthy: everything except false, null and missing (arrays are truthy).
        if (value === true) return orArray({ $nin: [false, null] });
        // Falsy (`!u.flag`, `=== false`, `== false`): everything except true.
        if (value === false) return dotted ? null : { [field]: { $ne: true } };
        return { [field]: { $eq: value ?? null } };
      case '!=':
        // `$ne: null` would also drop documents missing the field, which JS keeps.
        if (value === null || value === undefined || dotted) return null;
        return orArray({ $ne: value });
      case '>': case '>=': case '<': case '<=': {
        if (!isOrderedLiteral(value)) return null;
        const range = { [field]: { [RELATIONAL[expr.operator]]: value } };
        // JavaScript converts null to 0 (`null < 10`, `null >= 0` are true);
        // MongoDB's typed comparison never matches null, so add those rows.
        return nullSatisfies(expr.operator, value) ? { $or: [range, { [field]: { $eq: null } }] } : range;
      }
      case 'like': {
        const pattern = typeof value === 'string' ? likeToRegExp(value) : undefined;
        return pattern ? { [field]: { $regex: pattern } } : null;
      }
      case 'notLike': {
        const pattern = typeof value === 'string' && !dotted ? likeToRegExp(value) : undefined;
        return pattern ? orArray({ $not: pattern }) : null;
      }
      default: return null;
    }
  }

  /** Maps an entity property path to a document path (`id` → `_id`). */
  private toFieldPath(field: string): string | undefined {
    const segments = field ? field.split('.') : [];
    // Never let a parsed name turn into an operator such as `$where`, and
    // never send `x.length`: in JavaScript it is the string/array length, in
    // MongoDB a (missing) sub-field, which would filter or sort wrongly.
    if (segments.length === 0
      || segments.some((segment) => segment === '' || segment.startsWith('$'))
      || segments.slice(1).includes('length')) {
      return undefined;
    }
    return field === 'id' ? '_id' : field;
  }

  private toFilterId(value: unknown): unknown {
    try {
      return this.toObjectId(value);
    } catch {
      return INVALID;
    }
  }

  private inferTsType(value: any): string {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (value instanceof Date) return 'Date';
    if (Array.isArray(value)) return 'unknown';
    if (typeof value === 'object') return 'unknown';
    return 'string';
  }
}

const INVALID = Symbol('invalid');

const RELATIONAL = { '>': '$gt', '>=': '$gte', '<': '$lt', '<=': '$lte' } as const;

/**
 * Literals whose relational comparison means the same in MongoDB and in
 * JavaScript for fields of the same type. JavaScript converts a numeric string
 * (`'7'`), a boolean or `null` to a number before comparing, which MongoDB's
 * typed comparison never does, so those are evaluated in memory only.
 */
function isOrderedLiteral(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'bigint' || value instanceof Date) return true;
  return typeof value === 'string' && value.trim() !== '' && Number.isNaN(Number(value));
}

/** Whether `null <operator> value` is true in JavaScript (null compares as 0). */
function nullSatisfies(operator: keyof typeof RELATIONAL, value: unknown): boolean {
  const nothing: any = null;
  switch (operator) {
    case '>': return nothing > (value as any);
    case '>=': return nothing >= (value as any);
    case '<': return nothing < (value as any);
    default: return nothing <= (value as any);
  }
}

/**
 * Whether the parsed form of a predicate can be trusted. The ORM parser maps
 * loose `==`/`!=` to strict equality (but `7 == '7'` in JavaScript) and, for a
 * block body, reads only the first `return`. Such predicates run in memory.
 */
function isTranslatablePredicate(predicate: unknown): boolean {
  if (typeof predicate !== 'function') return false;
  const source = Function.prototype.toString.call(predicate).trim();
  if (/(^|[^=!<>])[=!]=(?!=)/.test(source)) return false;
  const arrow = source.indexOf('=>');
  const isArrow = arrow !== -1 && !/^(async\s+)?function\b/.test(source);
  const body = isArrow ? source.slice(arrow + 2).trim() : source.slice(source.indexOf('{'));
  if (isArrow && !body.startsWith('{')) return true;
  // A block body is accepted only when it is a single return statement.
  return /^\{\s*return\b[^;]*;?\s*\}$/.test(body);
}

/**
 * Extracts the database name from a connection string path, e.g.
 * `mongodb://host:27017/shop?retryWrites=true` → `shop`. Returns `undefined`
 * when the URI has no database, so the driver default applies.
 */
function databaseFromUri(uri: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/i.exec(uri);
  const name = match?.[1] ? decodeURIComponent(match[1]) : '';
  return name || undefined;
}

/**
 * Converts the LIKE patterns produced by the ORM parser (`%x%`, `x%`, `%x`
 * for includes/startsWith/endsWith) into an anchored, case-sensitive regular
 * expression with the literal part escaped. Patterns with wildcards inside
 * the literal are ambiguous and are left to in-memory filtering.
 */
function likeToRegExp(pattern: string): RegExp | undefined {
  const leading = pattern.startsWith('%');
  const trailing = pattern.length > 1 && pattern.endsWith('%');
  const literal = pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  if (/[%_]/.test(literal)) return undefined;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${leading ? '' : '^'}${escaped}${trailing ? '' : '$'}`);
}
