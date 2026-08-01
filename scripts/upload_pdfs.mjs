/**
 * upload_pdfs.mjs — one-off: push uploads/ into the Supabase Storage bucket.
 *
 * Keys mirror the local layout, which is also what storage.js derives at read
 * time:   uploads/<collectionId>/<file>  →  <collectionId>/<file>
 *
 * The Document.filePath column is NOT used as the key. Those rows hold absolute
 * Windows paths from the machines that ingested the corpus (several different
 * project folders), so only the basename is meaningful — see storage.js.
 *
 * Idempotent: re-running upserts, so an interrupted run just resumes.
 * Verifies every Document row has a matching file before uploading anything, so
 * a partial corpus fails loudly here rather than as 404s in the viewer.
 *
 * Run: node scripts/upload_pdfs.mjs [--dry-run] [--limit N]
 *
 * --limit N uploads only the first N — use it to prove one file lands in the
 * bucket before committing to the full 688 MB.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../backend/db.js';
import { storageConfigured, uploadPdf, basename } from '../backend/storage.js';

const ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DRY_RUN     = process.argv.includes('--dry-run');
const LIMIT_ARG   = process.argv.indexOf('--limit');
const LIMIT       = LIMIT_ARG === -1 ? Infinity : parseInt(process.argv[LIMIT_ARG + 1], 10);

if (!storageConfigured()) {
  console.error('[upload] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const docs = await prisma.document.findMany({
  select: { collectionId: true, filePath: true, filename: true },
});

// Pre-flight: every row must have a local file.
const planned = [];
const missing = [];
for (const doc of docs) {
  const key   = `${doc.collectionId}/${basename(doc.filePath)}`;
  const local = path.join(UPLOADS_DIR, String(doc.collectionId), basename(doc.filePath));
  try {
    const { size } = await fs.stat(local);
    planned.push({ key, local, size });
  } catch {
    missing.push({ key, filename: doc.filename });
  }
}

if (missing.length) {
  console.error(`[upload] ${missing.length} of ${docs.length} documents have no local file:`);
  for (const m of missing.slice(0, 10)) console.error(`  ${m.key}  (${m.filename})`);
  if (missing.length > 10) console.error(`  …and ${missing.length - 10} more`);
  process.exit(1);
}

// Pre-flight validated the whole corpus above; --limit only caps what is sent,
// so a partial run is still proof the whole set is present locally.
const batch = Number.isFinite(LIMIT) ? planned.slice(0, LIMIT) : planned;
const total = batch.reduce((sum, item) => sum + item.size, 0);
console.log(`[upload] ${batch.length} of ${planned.length} PDFs, ${mb(total)}` +
  `${DRY_RUN ? '  (dry run — nothing will be sent)' : ''}`);

let done = 0;
let sent = 0;
for (const { key, local, size } of batch) {
  if (!DRY_RUN) {
    const bytes = await fs.readFile(local);       // one at a time: 4.6 MB peaks, not 688 MB
    await uploadPdf(key, bytes);
  }
  done++;
  sent += size;
  const pct = ((sent / total) * 100).toFixed(0);
  process.stdout.write(`\r[upload] ${String(done).padStart(4)}/${batch.length}  ` +
    `${mb(sent)} / ${mb(total)}  (${pct}%)   ${key.slice(0, 48).padEnd(48)}`);
}
process.stdout.write('\n');
console.log(DRY_RUN ? '[upload] dry run complete' : '[upload] done');

await prisma.$disconnect();
