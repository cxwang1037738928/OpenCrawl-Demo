/**
 * export_demo.mjs — copy ONLY the demo account's data into a fresh database.
 *
 * The local Postgres is shared with another app: it holds other users
 * (admin@gmail.com and friends, password hashes and all) and their collections.
 * A whole-database pg_dump would carry those into the public demo, so this
 * walks the demo user's rows instead and copies just those.
 *
 * It is also deliberately not a restore tool. The source client is wrapped so
 * that any write operation throws, and the target is refused if it looks like
 * the source or like localhost. Nothing here issues DDL, DROP or TRUNCATE
 * against anything — the schema is created on the target beforehand with
 * `prisma migrate deploy`.
 *
 * Collection ids are PRESERVED, because the PDF object keys in Supabase Storage
 * are <collectionId>/<basename> (see storage.js). Renumbering collections would
 * silently break every PDF in the viewer.
 *
 * Run:
 *   SOURCE_DATABASE_URL=postgresql://…localhost:5433/opencrawl \
 *   TARGET_DATABASE_URL=postgresql://…supabase.co:5432/postgres \
 *   node scripts/export_demo.mjs [--dry-run]
 */

import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

const SOURCE  = (process.env.SOURCE_DATABASE_URL || '').trim();
const TARGET  = (process.env.TARGET_DATABASE_URL || '').trim();
const DEMO    = (process.env.DEMO_EMAIL || 'demo@gmail.com').trim().toLowerCase();
const DRY_RUN = process.argv.includes('--dry-run');
const CHUNK_BATCH = parseInt(process.env.EXPORT_BATCH || '500', 10);

// ── Guards ───────────────────────────────────────────────────────────────────

const die = (message) => { console.error(`[export] ${message}`); process.exit(1); };

if (!SOURCE) die('SOURCE_DATABASE_URL is required (the shared local database)');
if (!TARGET) die('TARGET_DATABASE_URL is required (the new Supabase database)');
if (SOURCE === TARGET) die('SOURCE and TARGET are the same database — refusing');
if (!DRY_RUN && /localhost|127\.0\.0\.1/.test(TARGET)) {
  die('TARGET looks like localhost. This script only writes to a remote database.\n' +
      '        If you really mean to target a local database, do it by hand.');
}

/** Source client with every write operation blocked at the client level. */
function readOnlyClient(url) {
  const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update',
    'updateMany', 'upsert', 'delete', 'deleteMany']);
  return new PrismaClient({ datasourceUrl: url }).$extends({
    query: {
      $allModels: {
        async $allOperations({ operation, model, args, query }) {
          if (WRITES.has(operation)) {
            throw new Error(`refusing ${operation} on ${model}: the source database is read-only`);
          }
          return query(args);
        },
      },
    },
  });
}

const source = readOnlyClient(SOURCE);
const target = new PrismaClient({ datasourceUrl: TARGET });

// Prisma distinguishes JSON null from SQL NULL; a plain null on a Json? field
// would be written as the JSON value `null` instead of leaving the column NULL.
const json = (value) => (value === null || value === undefined ? Prisma.DbNull : value);

const count = (label, n) => console.log(`[export]   ${label.padEnd(12)} ${String(n).padStart(6)}`);

// ── Read (source) ────────────────────────────────────────────────────────────

const user = await source.user.findUnique({ where: { email: DEMO } });
if (!user) die(`no user ${DEMO} in the source database`);

const collections = await source.collection.findMany({ where: { userId: user.id },
  orderBy: { id: 'asc' } });
const collectionIds = collections.map((c) => c.id);
const documents = await source.document.findMany({
  where: { collectionId: { in: collectionIds } }, orderBy: { id: 'asc' } });
const chats = await source.chat.findMany({
  where: { collectionId: { in: collectionIds } }, orderBy: { id: 'asc' } });
const chunkCount = await source.chunk.count({ where: { collectionId: { in: collectionIds } } });

console.log(`[export] demo user id=${user.id} <${user.email}>`);
count('collections', collections.length);
count('documents', documents.length);
count('chunks', chunkCount);
count('chats', chats.length);

const otherUsers = await source.user.count({ where: { email: { not: DEMO } } });
console.log(`[export] leaving behind ${otherUsers} other user(s) and their collections`);

if (DRY_RUN) {
  console.log('[export] dry run — nothing written');
  await source.$disconnect(); await target.$disconnect();
  process.exit(0);
}

// ── Write (target) ───────────────────────────────────────────────────────────

console.log(`[export] writing to ${TARGET.replace(/:[^:@/]+@/, ':****@')}`);

await target.user.create({
  data: {
    id: user.id, email: user.email, password: user.password,
    isAdmin: user.isAdmin, createdAt: user.createdAt,
  },
});

for (const c of collections) {
  await target.collection.create({
    data: {
      id: c.id, name: c.name, color: c.color, crawler: c.crawler,
      categories: json(c.categories), docVectors: json(c.docVectors),
      embeddingsMeta: json(c.embeddingsMeta), knowledgeGraph: json(c.knowledgeGraph),
      knowledgeGraphHtml: c.knowledgeGraphHtml,
      corpusUpdatedAt: c.corpusUpdatedAt, userId: c.userId, createdAt: c.createdAt,
    },
  });
}
count('collections', collections.length);

for (const d of documents) {
  await target.document.create({
    data: {
      id: d.id, docId: d.docId, collectionId: d.collectionId, filename: d.filename,
      filePath: d.filePath, sha256: d.sha256, status: d.status, title: d.title,
      authors: d.authors ?? [], pageCount: d.pageCount, docling: json(d.docling),
      extractedAt: d.extractedAt, createdAt: d.createdAt,
    },
  });
}
count('documents', documents.length);

// Chunks stream in batches: 16k rows of 384-float embeddings is ~87 MB, which
// must not be held in one array on either side of the connection.
let copied = 0;
let cursor = null;
for (;;) {
  const batch = await source.chunk.findMany({
    where: { collectionId: { in: collectionIds } },
    orderBy: { id: 'asc' },
    take: CHUNK_BATCH,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  if (!batch.length) break;
  await target.chunk.createMany({
    data: batch.map((k) => ({
      id: k.id, chunkId: k.chunkId, collectionId: k.collectionId, documentId: k.documentId,
      docId: k.docId, filename: k.filename, chunkIndex: k.chunkIndex, text: k.text,
      heading: k.heading, chunkType: k.chunkType, sectionIndex: k.sectionIndex,
      pages: json(k.pages), prefixLen: k.prefixLen, category: k.category,
      embedding: k.embedding, ingestedAt: k.ingestedAt,
    })),
    skipDuplicates: true,
  });
  copied += batch.length;
  cursor = batch[batch.length - 1].id;
  process.stdout.write(`\r[export]   chunks       ${String(copied).padStart(6)} / ${chunkCount}`);
}
process.stdout.write('\n');

for (const c of chats) {
  await target.chat.create({
    data: {
      id: c.id, title: c.title, conversation: c.conversation ?? [],
      collectionId: c.collectionId, createdAt: c.createdAt, updatedAt: c.updatedAt,
    },
  });
}
count('chats', chats.length);

// Explicit ids were inserted, so the autoincrement sequences still sit at 1 and
// the next runtime insert would collide. Chat is the only table the demo writes
// to, but fix them all rather than leave a trap.
for (const table of ['User', 'Collection', 'Chat']) {
  await target.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${table}"), 1), true)`);
}
console.log('[export] id sequences advanced past the copied rows');
console.log('[export] done');

await source.$disconnect();
await target.$disconnect();
