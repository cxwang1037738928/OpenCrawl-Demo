/**
 * routes/documents.js — per-collection PDFs, mounted at
 * /api/collections/:collectionId/documents (req.collection is set by the
 * collections router).
 *
 * READ-ONLY in the demo build — the corpus ships pre-indexed, so uploading and
 * deleting are gone along with the extraction pipeline that gave them a point.
 *
 *   GET /                — list the collection's documents
 *   GET /:docId/pdf-url  — where to fetch the PDF from (the citation
 *                          deep-links in Chat open it in the viewer)
 *
 * Deployed, /pdf-url returns a short-lived Supabase Storage signed URL and the
 * browser fetches the bytes directly — see storage.js for why the bytes are not
 * proxied through here. With Supabase unconfigured it falls back to streaming
 * the file off local disk, so local development is unchanged.
 */

import 'dotenv/config';
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../db.js';
import { storageConfigured, signedPdfUrl, basename } from '../storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const documentsRouter = Router();

documentsRouter.get('/', wrap(async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { collectionId: req.collection.id },
    orderBy: { createdAt: 'asc' },
    select: {
      docId: true, filename: true, title: true, authors: true,
      status: true, pageCount: true, extractedAt: true, createdAt: true,
    },
  });
  res.json({ documents: docs });
}));

documentsRouter.get('/:docId/pdf-url', wrap(async (req, res) => {
  const doc = await prisma.document.findFirst({
    where: { collectionId: req.collection.id, docId: req.params.docId },
  });
  if (!doc) throw httpError(404, `Unknown document "${req.params.docId}"`);

  if (storageConfigured()) {
    return res.json({ url: await signedPdfUrl(doc) });
  }
  // Local dev: no Supabase, serve from disk through the route below.
  res.json({ url: `/api/collections/${req.collection.id}` +
                  `/documents/${encodeURIComponent(doc.docId)}/pdf` });
}));

/**
 * Local-disk fallback, used only when Supabase Storage is unconfigured.
 * Resolves the file the same way the uploader keys it — uploads/<collectionId>/
 * <basename> — because the stored filePath is an absolute path from whichever
 * machine ingested the corpus and does not exist here (see storage.js).
 */
documentsRouter.get('/:docId/pdf', wrap(async (req, res) => {
  if (storageConfigured()) {
    throw httpError(404, 'PDFs are served from object storage; use /pdf-url');
  }
  const doc = await prisma.document.findFirst({
    where: { collectionId: req.collection.id, docId: req.params.docId },
  });
  if (!doc) throw httpError(404, `Unknown document "${req.params.docId}"`);

  const local = path.join(ROOT, 'uploads', String(req.collection.id), basename(doc.filePath));
  const candidates = [local, path.resolve(doc.filePath)];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      res.type('application/pdf');
      return res.sendFile(candidate);
    } catch { /* try the next one */ }
  }
  throw httpError(404, `Source PDF missing on disk: ${doc.filename}`);
}));
