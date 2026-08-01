/**
 * routes/collections.js — /api/collections (login required; server.js
 * applies `requireAuth` before this router).
 *
 * READ-ONLY in the demo build. The corpus ships pre-indexed, so there is no
 * create, no delete and no pipeline: the visitor picks one of the demo
 * account's existing collections and chats against it.
 *
 *   GET /  — the demo account's collections
 *
 * Sub-resources (ownership-checked by loadOwnedCollection → req.collection):
 *   /:collectionId/documents — list PDFs / stream one           (documents.js)
 *   /:collectionId/corpus    — embedding map / graph / chunks    (corpus.js)
 */

import 'dotenv/config';
import { Router } from 'express';
import { prisma } from '../db.js';
import { documentsRouter } from './documents.js';
import { collectionCorpusRouter } from './corpus.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** List/summary shape — leaves out the heavy JSON artifacts. */
const collectionSummary = (collection) => ({
  id:        collection.id,
  name:      collection.name,
  color:     collection.color,
  crawler:   collection.crawler,
  createdAt: collection.createdAt,
  documents: collection._count?.documents ?? undefined,
});

export const collectionsRouter = Router();

collectionsRouter.get('/', wrap(async (req, res) => {
  const collections = await prisma.collection.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { documents: true } } },
  });
  res.json({ collections: collections.map(collectionSummary) });
}));

/** Everything below /:collectionId is ownership-checked here. */
const loadOwnedCollection = wrap(async (req, res, next) => {
  const collectionId = parseInt(req.params.collectionId, 10);
  if (!Number.isInteger(collectionId)) throw httpError(400, 'collectionId must be an integer');
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: req.user.id },
    // The rendered graph page is ~60KB and only one route wants it; that route
    // reads it directly rather than making every sub-resource carry it.
    omit: { knowledgeGraphHtml: true },
  });
  if (!collection) throw httpError(404, `No collection ${collectionId}`);
  req.collection = collection;
  next();
});

collectionsRouter.use('/:collectionId', loadOwnedCollection);

collectionsRouter.use('/:collectionId/documents', documentsRouter);
collectionsRouter.use('/:collectionId/corpus', collectionCorpusRouter);
