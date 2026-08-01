/**
 * corpus.js — corpus data for the frontend, read from Postgres.
 *
 * collectionCorpusRouter — mounted at /api/collections/:collectionId/corpus
 * (req.collection set by the collections router):
 *   GET /embedding-map   — the collection's document points projected to 3D
 *         and 2D (UMAP over Collection.docVectors) plus mutual-kNN edges with
 *         cosine similarities. The frontend re-runs union-find over these
 *         edges as the threshold slider moves, reproducing the backend
 *         clustering exactly with no server round-trip.
 *   GET /graph           — Collection.knowledgeGraph passthrough (kg-gen
 *         entities/edges/relations).
 *   GET /graph/view      — kg-gen's standalone interactive page, as HTML.
 *   GET /chunks/:chunkId — one indexed chunk (text, pages, prefixLen) so the
 *         viewer can locate and highlight it in the PDF.
 *
 * All read-only: the demo ships these artifacts pre-built, and the stages that
 * produced them are not part of this build.
 */

import 'dotenv/config';
import express from 'express';
import { UMAP } from 'umap-js';
import { prisma } from '../db.js';

const MUTUAL_K = parseInt(process.env.CATEGORIES_MUTUAL_K || '10', 10);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Embedding map
// ---------------------------------------------------------------------------

// Vectors are L2-normalized (generate_categories.js), so dot = cosine.
function dot(vecA, vecB) {
  let sum = 0;
  for (let componentIdx = 0; componentIdx < vecA.length; componentIdx++) {
    sum += vecA[componentIdx] * vecB[componentIdx];
  }
  return sum;
}

// Deterministic PRNG (mulberry32) so the UMAP layout is stable across
// requests and reloads instead of reshuffling on every fetch.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-axis min-max scale to [-1, 1] so the scene size is data-independent. */
function normalizeCoords(coords) {
  const dims = coords[0].length;
  for (let axis = 0; axis < dims; axis++) {
    let min = Infinity, max = -Infinity;
    for (const point of coords) {
      min = Math.min(min, point[axis]);
      max = Math.max(max, point[axis]);
    }
    const span = max - min || 1;
    for (const point of coords) point[axis] = ((point[axis] - min) / span) * 2 - 1;
  }
  return coords;
}

function project(vectors, nComponents, seed) {
  const docCount = vectors.length;
  if (docCount === 1) return [nComponents === 3 ? [0, 0, 0] : [0, 0]];
  // umap-js requires nNeighbors < docCount — impossible with 2 points, so
  // place them apart directly instead of crashing the embedding map.
  if (docCount === 2) {
    return nComponents === 3 ? [[-1, 0, 0], [1, 0, 0]] : [[-1, 0], [1, 0]];
  }
  const umap = new UMAP({
    nComponents,
    // UMAP requires nNeighbors < docCount; 15 is the library default sweet spot.
    nNeighbors: Math.max(2, Math.min(15, docCount - 1)),
    minDist: 0.15,
    random: mulberry32(seed),
  });
  return normalizeCoords(umap.fit(vectors));
}

/** Mutual-kNN pairs with cosine sims — the same gate generate_categories.js
 * clusters with, so browser-side union-find over these edges reproduces the
 * backend clustering at any threshold. O(n²) sims, O(n·K) shipped. */
function mutualKnnEdges(vectors, k) {
  const docCount = vectors.length;
  const nearestNeighbours = [];
  for (let docIdx = 0; docIdx < docCount; docIdx++) {
    const sims = [];
    for (let otherIdx = 0; otherIdx < docCount; otherIdx++) {
      if (otherIdx !== docIdx) sims.push([otherIdx, dot(vectors[docIdx], vectors[otherIdx])]);
    }
    sims.sort((simA, simB) => simB[1] - simA[1]);
    nearestNeighbours.push(new Map(sims.slice(0, k)));
  }
  const edges = [];
  for (let docIdx = 0; docIdx < docCount; docIdx++) {
    for (const [otherIdx, sim] of nearestNeighbours[docIdx]) {
      if (otherIdx > docIdx && nearestNeighbours[otherIdx].has(docIdx)) {
        edges.push({ i: docIdx, j: otherIdx, sim: Math.round(sim * 10000) / 10000 });
      }
    }
  }
  return edges;
}

export const collectionCorpusRouter = express.Router();

// Projection is the expensive part — memoize per collection on the vectors'
// generatedAt stamp so repeat requests are free until the corpus changes.
const mapCacheByCollection = new Map();

collectionCorpusRouter.get('/embedding-map', wrap(async (req, res) => {
  const docVectors = req.collection.docVectors;
  if (!docVectors?.docs?.length) {
    throw httpError(404, 'This collection has no embedding map');
  }

  const cached = mapCacheByCollection.get(req.collection.id);
  if (cached?.generatedAt !== docVectors.generatedAt) {
    const vectors = docVectors.docs.map((doc) => doc.vector);
    const p3 = project(vectors, 3, 1337);
    const p2 = project(vectors, 2, 1337);
    mapCacheByCollection.set(req.collection.id, {
      generatedAt: docVectors.generatedAt,
      mutualK: MUTUAL_K,
      defaultThreshold: parseFloat(process.env.CATEGORIES_SIMILARITY || '0.75'),
      points: docVectors.docs.map((doc, docIdx) => ({
        docId:    doc.docId,
        filename: doc.filename,
        title:    doc.title || doc.filename,
        p3:       p3[docIdx].map((coord) => Math.round(coord * 1000) / 1000),
        p2:       p2[docIdx].map((coord) => Math.round(coord * 1000) / 1000),
      })),
      edges: mutualKnnEdges(vectors, MUTUAL_K),
    });
  }
  res.json(mapCacheByCollection.get(req.collection.id));
}));

collectionCorpusRouter.get('/graph', wrap(async (req, res) => {
  if (!req.collection.knowledgeGraph) {
    throw httpError(404, 'This collection has no knowledge graph');
  }
  res.json(req.collection.knowledgeGraph);
}));

// kg-gen's standalone page. Sent as text, not a static file: collections are
// per-user, and an iframe src can't carry the auth header this route needs.
collectionCorpusRouter.get('/graph/view', wrap(async (req, res) => {
  // Not on req.collection — loadOwnedCollection omits it (see collections.js).
  const { knowledgeGraphHtml } = await prisma.collection.findUniqueOrThrow({
    where:  { id: req.collection.id },
    select: { knowledgeGraphHtml: true },
  });
  if (!knowledgeGraphHtml) {
    throw httpError(404, 'This collection has no knowledge graph');
  }
  res.type('html').send(knowledgeGraphHtml);
}));

collectionCorpusRouter.get('/chunks/:chunkId', wrap(async (req, res) => {
  const chunk = await prisma.chunk.findFirst({
    where: { collectionId: req.collection.id, chunkId: req.params.chunkId },
  });
  if (!chunk) throw httpError(404, `Unknown chunk "${req.params.chunkId}"`);
  res.json({
    id:           chunk.chunkId,
    docId:        chunk.docId,
    filename:     chunk.filename,
    pages:        chunk.pages,
    prefixLen:    chunk.prefixLen,
    chunkIndex:   chunk.chunkIndex,
    heading:      chunk.heading,
    sectionIndex: chunk.sectionIndex,
    chunkType:    chunk.chunkType,
    text:         chunk.text,
  });
}));
