/**
 * prune_collections.mjs — keep only the named collections; delete the rest.
 *
 * Deletes from the DATABASE and from Supabase Storage, so the two cannot drift:
 * a collection row removed without its PDFs leaves orphaned objects paying for
 * storage, and PDFs removed without the row leaves a collection whose documents
 * 404 in the viewer.
 *
 * Deleting a Collection cascades to its Documents, Chunks and Chats (see
 * schema.prisma), so the children do not need deleting explicitly — but they
 * are counted and reported first, because "11 collections" understates what is
 * actually going away.
 *
 * Refuses to touch localhost: the dev database is shared with another app.
 * Requires --yes to delete anything; without it, reports and exits.
 *
 * Run:
 *   TARGET_DATABASE_URL=... node scripts/prune_collections.mjs --keep 26
 *   TARGET_DATABASE_URL=... node scripts/prune_collections.mjs --keep 26 --yes
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { storageConfigured, listObjects, pruneForeignFolders } from '../backend/storage.js';

const TARGET = (process.env.TARGET_DATABASE_URL || process.env.SUPA_DIRECT || '').trim();
const CONFIRMED = process.argv.includes('--yes');
const DEMO_EMAIL = (process.env.DEMO_EMAIL || 'demo@gmail.com').trim().toLowerCase();

const keepArg = process.argv.indexOf('--keep');
const KEEP = keepArg === -1
  ? []
  : String(process.argv[keepArg + 1] || '').split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger);

const die = (msg) => { console.error(`[prune] ${msg}`); process.exit(1); };

if (!TARGET) die('TARGET_DATABASE_URL (or SUPA_DIRECT) is required');
if (!KEEP.length) die('--keep <id[,id...]> is required — refusing to delete everything');
if (/localhost|127\.0\.0\.1/.test(TARGET)) {
  die('TARGET looks like localhost. That database is shared with another app; refusing.');
}

const db = new PrismaClient({ datasourceUrl: TARGET });

const user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
if (!user) die(`no user ${DEMO_EMAIL} in the target database`);

const all = await db.collection.findMany({
  where: { userId: user.id },
  select: { id: true, name: true, _count: { select: { documents: true, chunks: true, chats: true } } },
  orderBy: { id: 'asc' },
});

const missing = KEEP.filter((id) => !all.some((c) => c.id === id));
if (missing.length) die(`--keep names collection(s) not owned by ${DEMO_EMAIL}: ${missing.join(', ')}`);

const keeping = all.filter((c) => KEEP.includes(c.id));
const dropping = all.filter((c) => !KEEP.includes(c.id));

const sum = (rows, field) => rows.reduce((t, c) => t + c._count[field], 0);

console.log(`\nKEEP (${keeping.length}):`);
for (const c of keeping) {
  console.log(`  [${String(c.id).padStart(2)}] ${c.name.slice(0, 44).padEnd(46)}` +
    `${String(c._count.documents).padStart(4)} docs ${String(c._count.chunks).padStart(6)} chunks ` +
    `${c._count.chats} chats`);
}
console.log(`\nDELETE (${dropping.length}):`);
for (const c of dropping) {
  console.log(`  [${String(c.id).padStart(2)}] ${c.name.slice(0, 44).padEnd(46)}` +
    `${String(c._count.documents).padStart(4)} docs ${String(c._count.chunks).padStart(6)} chunks ` +
    `${c._count.chats} chats`);
}
console.log(`\ncascade totals: ${sum(dropping, 'documents')} documents, ` +
  `${sum(dropping, 'chunks')} chunks, ${sum(dropping, 'chats')} chats`);

// Storage folders that will be orphaned by the delete.
if (storageConfigured()) {
  const folders = (await listObjects('')).filter((f) => !f.id);
  const doomed = folders.filter((f) => !KEEP.includes(Number(f.name)));
  let bytes = 0;
  let files = 0;
  for (const f of doomed) {
    for (const file of await listObjects(`${f.name}/`)) { files++; bytes += file.metadata?.size ?? 0; }
  }
  console.log(`storage to prune: ${files} object(s), ${(bytes / 1024 / 1024).toFixed(1)} MB ` +
    `from folder(s) ${doomed.map((f) => f.name).join(', ') || '(none)'}`);
} else {
  console.log('storage: SUPABASE_URL/SECRET_KEY not set — PDFs will NOT be pruned');
}

if (!CONFIRMED) {
  console.log('\nNothing deleted. Re-run with --yes to apply.');
  await db.$disconnect();
  process.exit(0);
}

console.log('\napplying…');
const { count } = await db.collection.deleteMany({
  where: { userId: user.id, id: { notIn: KEEP } },
});
console.log(`  deleted ${count} collection(s) (documents, chunks and chats cascaded)`);

if (storageConfigured()) {
  const removed = await pruneForeignFolders(KEEP);
  console.log(`  pruned ${removed.length} storage object(s)`);
}

const left = await db.collection.findMany({
  where: { userId: user.id },
  select: { id: true, name: true, _count: { select: { documents: true, chunks: true, chats: true } } },
});
console.log('\nremaining:');
for (const c of left) {
  console.log(`  [${c.id}] ${c.name} — ${c._count.documents} docs, ` +
    `${c._count.chunks} chunks, ${c._count.chats} chats`);
}
await db.$disconnect();
