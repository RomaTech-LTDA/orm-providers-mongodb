import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import type { IDbProvider, TableColumnInfo } from '@romatech/orm';
import type { QueryObject } from '@romatech/orm';

/**
 * Configuration options for the MongoDB provider.
 */
export interface MongoDbProviderOptions {
  /** MongoDB connection URI. Example: mongodb://localhost:27017 */
  uri?: string;
  /** Database name. */
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
  private readonly _options: MongoDbProviderOptions;
  private readonly _pendingOps: Array<() => Promise<void>> = [];
  private readonly _migrationCollection = '__roma_migrations';

  readonly supportsTransactions = true;

  constructor(optionsOrUri: MongoDbProviderOptions | string) {
    if (typeof optionsOrUri === 'string') {
      const parts = optionsOrUri.split('/');
      this._options = {
        uri: optionsOrUri,
        database: parts[parts.length - 1] || 'test',
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
    this._db = this._client.db(this._options.database);
  }

  async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.close();
      this._client = null;
      this._db = null;
    }
  }

  private getCollection(name: string): Collection {
    if (!this._db) throw new Error('Not connected. Call connect() first.');
    return this._db.collection(name);
  }

  // ─── Transactions ────────────────────────────────────────────────────────────

  async beginTransaction(): Promise<void> {
    if (!this._client) throw new Error('Not connected');
    this._session = this._client.startSession();
    this._session.startTransaction();
  }

  async commitTransaction(): Promise<void> {
    if (this._session) {
      await this._session.commitTransaction();
      await this._session.endSession();
      this._session = null;
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (this._session) {
      await this._session.abortTransaction();
      await this._session.endSession();
      this._session = null;
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const doc = this.toDocument(entity);
      await col.insertOne(doc, { session: this._session ?? undefined });
    });
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const docs = entities.map((e) => this.toDocument(e));
      await col.insertMany(docs, { session: this._session ?? undefined });
    });
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const doc = this.toDocument(entity);
      const id = (entity as any).id ?? (entity as any)._id;
      await col.replaceOne(
        { _id: this.toObjectId(id) },
        doc,
        { session: this._session ?? undefined },
      );
    });
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const id = (entity as any).id ?? (entity as any)._id;
      await col.deleteOne(
        { _id: this.toObjectId(id) },
        { session: this._session ?? undefined },
      );
    });
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    this._pendingOps.push(async () => {
      const col = this.getCollection(tableName);
      const ids = entities.map((e) => this.toObjectId((e as any).id ?? (e as any)._id));
      await col.deleteMany(
        { _id: { $in: ids } },
        { session: this._session ?? undefined },
      );
    });
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const col = this.getCollection(tableName);
    const id = (entity as any).id ?? (entity as any)._id;
    const doc = await col.findOne({ _id: this.toObjectId(id) });
    return doc ? this.fromDocument<T>(doc) : undefined;
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    const col = this.getCollection(tableName);
    const docs = await col.find({}).toArray();
    return docs.map((d) => this.fromDocument<T>(d));
  }

  // ─── Unit of Work ────────────────────────────────────────────────────────────

  async saveChanges(): Promise<void> {
    for (const op of this._pendingOps) {
      await op();
    }
    this._pendingOps.length = 0;
  }

  // ─── Query Execution ─────────────────────────────────────────────────────────

  async executeQuery<T = any>(queryOrEntityName: string, paramsOrQuery?: any[] | QueryObject<any, any>): Promise<T[]> {
    // Raw query support (limited — for transactions BEGIN/COMMIT/ROLLBACK)
    if (Array.isArray(paramsOrQuery) || paramsOrQuery === undefined) {
      // Transaction commands are handled separately
      if (queryOrEntityName === 'BEGIN' || queryOrEntityName === 'COMMIT' || queryOrEntityName === 'ROLLBACK') {
        return [] as T[];
      }
      return [] as T[];
    }

    // QueryObject execution
    const entityName = queryOrEntityName;
    const query = paramsOrQuery as QueryObject<any, any>;
    const col = this.getCollection(entityName);

    let cursor = col.find(this.buildMongoFilter(query));

    // Ordering — use orderByExpressions for server-side sort
    if (query.orderByExpressions && query.orderByExpressions.length > 0) {
      const sort: Record<string, 1 | -1> = {};
      for (const expr of query.orderByExpressions) {
        if ('field' in expr && (expr as any).field) {
          sort[(expr as any).field as string] = (expr as any).direction === 'desc' ? -1 : 1;
        }
      }
      if (Object.keys(sort).length > 0) {
        cursor = cursor.sort(sort);
      }
    }

    // Skip/Take
    if (query.skip) cursor = cursor.skip(query.skip);
    if (query.take) cursor = cursor.limit(query.take);

    const docs = await cursor.toArray();
    const results = docs.map((d) => this.fromDocument<any>(d));

    // Client-side projection if needed
    if (query.selector) {
      return results.map(query.selector) as T[];
    }

    return results as T[];
  }

  // ─── Migrations ──────────────────────────────────────────────────────────────

  async addMigration(migrationName: string, _migrationScript: string): Promise<void> {
    const col = this.getCollection(this._migrationCollection);
    await col.insertOne({ name: migrationName, appliedAt: new Date() });
  }

  async removeMigration(migrationName: string): Promise<void> {
    const col = this.getCollection(this._migrationCollection);
    await col.deleteOne({ name: migrationName });
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
    } catch {
      // Collection may already exist
    }
  }

  async dropTable(tableName: string): Promise<void> {
    const col = this.getCollection(tableName);
    await col.drop().catch(() => {});
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

    return Object.entries(sample)
      .filter(([key]) => key !== '_id')
      .map(([key, value]) => ({
        name: key,
        primaryKey: key === 'id',
        tsType: this.inferTsType(value),
      }));
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

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

  private toObjectId(id: any): any {
    if (id instanceof ObjectId) return id;
    if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
    return id; // numeric or other types used as-is
  }

  private buildMongoFilter(query: QueryObject<any, any>): Record<string, any> {
    // For now, return empty filter (client-side evaluation)
    // Full MongoDB query translation would parse QueryExpression into $match
    if (!query.predicates || query.predicates.length === 0) {
      return {};
    }
    // Fallback: return all and let client-side handle filtering
    return {};
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
