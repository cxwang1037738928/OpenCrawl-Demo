/**
 * storage.js — the demo corpus's PDFs, in Supabase Storage.
 *
 * Render's filesystem is ephemeral, and Document.filePath holds absolute
 * WINDOWS paths from the machines the corpus was originally ingested on
 * (three different project folders, none of which exist in this repo). Neither
 * is usable in a deployment, so the object key is DERIVED rather than stored:
 *
 *     uploads/<collectionId>/<basename>   →   <collectionId>/<basename>
 *
 * That mapping was verified against all 240 rows — every one resolves, and no
 * file on disk lacks a row. `basename` splits on BOTH separators on purpose:
 * the paths were written on Windows and are read on Linux, where path.basename
 * would return the whole string and silently produce one giant bogus key.
 *
 * The bucket is private; the browser gets a short-lived signed URL and fetches
 * the bytes straight from Supabase. Deliberately NOT proxied through Express —
 * a 4.6 MB PDF streamed through Node costs the bandwidth twice and holds
 * buffers in a memory-constrained process, and pdf.js issues many range
 * requests per document.
 *
 * Unconfigured (no SUPABASE_URL), every export reports "not configured" so
 * local development keeps reading PDFs off disk — see routes/documents.js.
 */

import 'dotenv/config';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
// Supabase's current key scheme is publishable/secret (sb_secret_…); the older
// anon/service_role JWTs still work but are deprecated. Accept either name so a
// rotation to the new scheme is an env change, not a code change. Both grant
// full access — this key is backend-only and must never reach the bundle.
const SECRET_KEY = (process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET     = (process.env.SUPABASE_PDF_BUCKET || 'pdfs').trim();
// Long enough for a reader to page through a document, short enough that a
// leaked URL is not a permanent handle on the corpus.
const SIGNED_URL_TTL = parseInt(process.env.SUPABASE_SIGNED_URL_TTL || '3600', 10);

export const storageConfigured = () => Boolean(SUPABASE_URL && SECRET_KEY);

/**
 * Both headers on purpose. The legacy service_role JWT is accepted on
 * Authorization alone, but the newer sb_secret_… keys are validated against
 * `apikey` as well, and sending both is valid for either scheme.
 */
const authHeaders = () => ({
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
});

/** Last path segment, for paths written with either separator. */
export const basename = (filePath) => String(filePath).split(/[\\/]/).pop();

/** The bucket key for a Document row. */
export const objectKey = (doc) => `${doc.collectionId}/${basename(doc.filePath)}`;

/**
 * A time-limited URL the browser can fetch directly.
 * Throws with a 502 on transport/permission failures so the route reports a
 * real error instead of handing pdf.js an undefined URL.
 */
export async function signedPdfUrl(doc) {
  const key = objectKey(doc);
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(key)}`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // A missing object comes back as HTTP 400 with {"statusCode":"404",
    // "error":"not_found"} in the body, so the transport status alone would
    // report "storage is broken" for what is really "that PDF isn't uploaded".
    let missing = response.status === 404;
    try { missing ||= String(JSON.parse(detail).statusCode) === '404'; } catch { /* not JSON */ }
    const err = new Error(missing
      ? `PDF not in storage: "${key}"`
      : `Supabase Storage could not sign "${key}" (HTTP ${response.status})` +
        `${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.status = missing ? 404 : 502;
    throw err;
  }
  // The API returns a path relative to /storage/v1, not an absolute URL.
  const { signedURL, signedUrl } = await response.json();
  return `${SUPABASE_URL}/storage/v1${signedURL ?? signedUrl}`;
}

/** List every object under a prefix, paging past the API's per-call cap. */
export async function listObjects(prefix = '') {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 100, offset,
                             sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!response.ok) throw new Error(`list "${prefix}" failed (HTTP ${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) return out;
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/**
 * Delete every object under collection folders NOT in `keepCollectionIds`.
 * Whole folders only, keyed on the numeric collection id, so a half-uploaded
 * demo collection is never touched. Scripts-only, not the request path.
 */
export async function pruneForeignFolders(keepCollectionIds, { dryRun = false } = {}) {
  const keep = new Set(keepCollectionIds.map(Number));
  const folders = (await listObjects('')).filter((entry) => !entry.id);  // folders lack an id
  const doomed = [];
  for (const folder of folders) {
    if (keep.has(Number(folder.name))) continue;
    for (const file of await listObjects(`${folder.name}/`)) {
      doomed.push(`${folder.name}/${file.name}`);
    }
  }
  if (dryRun || doomed.length === 0) return doomed;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: doomed }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`prune failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return doomed;
}

/** Upload one PDF. Used only by scripts/upload_pdfs.mjs, not the request path. */
export async function uploadPdf(key, bytes, { upsert = true } = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`,
    {
      method: upsert ? 'PUT' : 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/pdf',
        'x-upsert': String(upsert),
      },
      body: bytes,
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`upload failed for "${key}" (HTTP ${response.status})` +
      `${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}
