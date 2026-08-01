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
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET       = (process.env.SUPABASE_PDF_BUCKET || 'pdfs').trim();
// Long enough for a reader to page through a document, short enough that a
// leaked URL is not a permanent handle on the corpus.
const SIGNED_URL_TTL = parseInt(process.env.SUPABASE_SIGNED_URL_TTL || '3600', 10);

export const storageConfigured = () => Boolean(SUPABASE_URL && SERVICE_KEY);

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
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(
      `Supabase Storage could not sign "${key}" (HTTP ${response.status})` +
      `${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.status = response.status === 404 ? 404 : 502;
    throw err;
  }
  // The API returns a path relative to /storage/v1, not an absolute URL.
  const { signedURL, signedUrl } = await response.json();
  return `${SUPABASE_URL}/storage/v1${signedURL ?? signedUrl}`;
}

/** Upload one PDF. Used only by scripts/upload_pdfs.mjs, not the request path. */
export async function uploadPdf(key, bytes, { upsert = true } = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`,
    {
      method: upsert ? 'PUT' : 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
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
