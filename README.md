# @romatech/orm-providers-mongodb

[![npm](https://img.shields.io/npm/v/%40romatech%2Form-providers-mongodb)](https://www.npmjs.com/package/@romatech/orm-providers-mongodb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RomaTech-LTDA/orm-providers-mongodb/blob/main/LICENSE)

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM – MongoDB Provider" />
</p>

MongoDB (NoSQL) provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm).

---

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-mongodb reflect-metadata
```

---

## Quick Start

```ts
import 'reflect-metadata';
import { DbContext, DbContextOptions, Entity, PrimaryKey, Column } from '@romatech/orm';
import { MongoDbProvider } from '@romatech/orm-providers-mongodb';

@Entity('users')
class User {
    @PrimaryKey() id!: string;
    @Column() name!: string;
    @Column() email!: string;
    @Column() age!: number;
}

class AppDbContext extends DbContext {
    users = this.set(User);

    constructor() {
        super(
            new DbContextOptions().useProvider(
                new MongoDbProvider({
                    uri: 'mongodb://localhost:27017',
                    database: 'myapp',
                })
            )
        );
    }
}

// Usage
const db = new AppDbContext();

db.users.add({ id: 'abc123', name: 'Alice', email: 'alice@example.com', age: 30 });
await db.saveChanges();

const users = await db.users.ToList();
console.log(users);
```

---

## Configuration

### Object-style (recommended)

```ts
new MongoDbProvider({
    uri: 'mongodb://localhost:27017',
    database: 'myapp',
    clientOptions: {
        // Any MongoClient options
    }
})
```

### Connection string

```ts
new MongoDbProvider('mongodb://localhost:27017/myapp')
```

---

## Transactions

MongoDB supports multi-document transactions (requires replica set):

```ts
const tx = await db.beginTransaction();
try {
    db.users.add(newUser);
    db.orders.add(newOrder);
    await db.saveChanges();
    await tx.commit();
} catch (err) {
    await tx.rollback();
    throw err;
}
```

> **Note:** Transactions require MongoDB 4.0+ with a replica set or sharded cluster.

---

## How It Works

| ORM Concept | MongoDB Mapping |
|-------------|-----------------|
| Entity | Document |
| Table | Collection |
| Primary Key (`id`) | `_id` field |
| Column | Document field |
| Migration | Tracked in `__roma_migrations` collection |
| Schema changes | No-op (MongoDB is schema-less) |

---

## Supported Features

- Full CRUD (add, addRange, update, remove, removeRange, find, getAll)
- QueryBuilder (client-side evaluation for complex predicates)
- Ordering via MongoDB `sort()`
- Skip/Take pagination
- Transaction support (replica set required)
- Migration history tracking
- Scaffold (infer entity types from sample documents)
- Collection listing

---

## Differences from SQL Providers

| Aspect | MongoDB Provider | SQL Providers |
|--------|-----------------|---------------|
| Schema | Schema-less | Schema-based |
| Migrations | Track only (no DDL) | Full DDL |
| Joins | Not supported natively | Supported |
| Transactions | Replica set required | Built-in |
| Query evaluation | Client-side for complex predicates | Server-side SQL |

---

## Type Mappings

| TypeScript Type | MongoDB Storage |
|-----------------|-----------------|
| `string` | String |
| `number` | Number (Double/Int) |
| `boolean` | Boolean |
| `Date` | Date |
| `object` | Embedded document |
| `array` | Array |

---

## Requirements

- Node.js >= 18
- MongoDB 4.0+ (transactions require replica set)
- The [`mongodb`](https://www.npmjs.com/package/mongodb) npm package (installed automatically)

---

## License

MIT © RomaTech / Leandro Romanelli
