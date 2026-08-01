/**
 * test_api.js — the demo build's API surface, against the real Postgres
 * (docker compose up -d postgres; npm run db:seed must have run first).
 *
 * Spawns the server on PORT=3998, then checks:
 *   auth        — demo login works, any other account is refused, register is gone
 *   collections — readable, and create/delete are gone
 *   documents   — listable, and upload/delete are gone
 *   chats       — create / read / rename / delete still work (chat is the only
 *                 writable surface), and they are shared on the demo account
 *
 * The RAG answer itself is NOT exercised here: it needs a reachable model and a
 * collection with indexed chunks, neither of which this test can assume.
 *
 * Run: node tests/test_api.js
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const DEMO_EMAIL    = (process.env.DEMO_EMAIL || 'demo@gmail.com').trim().toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo123';

const prisma = new PrismaClient();
let failures = 0;
const createdChatIds = [];

function check(name, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[test_api] ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(token, method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/auth/me`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up on port ' + PORT);
}

const server = spawn(process.execPath, ['backend/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  await waitForServer();

  // ── Auth: demo account only, no registration ──
  const noAuth = await api(null, 'GET', '/api/collections');
  check('not logged in rejected (401)', noAuth.status === 401);

  const meAnonymous = await api(null, 'GET', '/api/auth/me');
  check('/me without token returns user: null', meAnonymous.body.user === null);

  const register = await api(null, 'POST', '/api/auth/register',
    { email: 'someone@example.com', password: 'secret1' });
  check('register route is gone (404)', register.status === 404);

  const foreignLogin = await api(null, 'POST', '/api/auth/login',
    { email: 'someone@example.com', password: 'secret1' });
  check('non-demo account refused (403)', foreignLogin.status === 403);

  const badLogin = await api(null, 'POST', '/api/auth/login',
    { email: DEMO_EMAIL, password: 'wrong-password' });
  check('wrong demo password rejected (401)', badLogin.status === 401);

  const login = await api(null, 'POST', '/api/auth/login',
    { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  check('demo login returns token', login.status === 200 && !!login.body.token,
    login.body.error ?? '');
  const token = login.body.token;
  if (!token) throw new Error(`demo login failed — has "npm run db:seed" run? (${login.body.error})`);

  // ── Collections: read-only ──
  const collections = await api(token, 'GET', '/api/collections');
  check('collections listed', collections.status === 200 && Array.isArray(collections.body.collections));
  const demoCollections = collections.body.collections ?? [];
  check('demo account has at least one collection', demoCollections.length > 0,
    'restore the demo corpus dump if this fails');

  const create = await api(token, 'POST', '/api/collections', { name: 'nope' });
  check('collection create is gone (404)', create.status === 404);

  const collectionId = demoCollections[0]?.id;
  if (collectionId) {
    const remove = await api(token, 'DELETE', `/api/collections/${collectionId}`);
    check('collection delete is gone (404)', remove.status === 404);

    // ── Documents: read-only ──
    const docs = await api(token, 'GET', `/api/collections/${collectionId}/documents`);
    check('documents listed', docs.status === 200 && Array.isArray(docs.body.documents));

    const upload = await api(token, 'POST', `/api/collections/${collectionId}/documents`, {});
    check('document upload is gone (404)', upload.status === 404);

    const docId = docs.body.documents?.[0]?.docId;
    if (docId) {
      const deleteDoc = await api(token, 'DELETE',
        `/api/collections/${collectionId}/documents/${encodeURIComponent(docId)}`);
      check('document delete is gone (404)', deleteDoc.status === 404);
    }

    const pipeline = await api(token, 'POST', `/api/collections/${collectionId}/pipeline/run`, {});
    check('pipeline routes are gone (404)', pipeline.status === 404);

    // ── Chats: the one writable surface ──
    const chat = await api(token, 'POST', '/api/chats', { collectionId });
    check('chat opens on a collection with its orb color',
      chat.status === 201 && chat.body.chat.collection?.id === collectionId
      && !!chat.body.chat.collection?.color);
    const chatId = chat.body.chat.id;
    if (chatId) createdChatIds.push(chatId);

    const renamed = await api(token, 'PATCH', `/api/chats/${chatId}`, { title: 'renamed' });
    check('chat rename', renamed.status === 200 && renamed.body.chat.title === 'renamed');

    const listed = await api(token, 'GET', '/api/chats');
    check('chat appears in the shared history',
      listed.body.chats?.some((other) => other.id === chatId));

    const removedChat = await api(token, 'DELETE', `/api/chats/${chatId}`);
    check('chat delete', removedChat.status === 200);
    if (removedChat.status === 200) createdChatIds.pop();

    const afterDelete = await api(token, 'GET', `/api/chats/${chatId}`);
    check('deleted chat is gone (404)', afterDelete.status === 404);
  }

  // ── Model settings went with the pipeline ──
  const models = await api(token, 'GET', '/api/corpus/models');
  check('models routes are gone (404)', models.status === 404);
} catch (err) {
  failures++;
  console.error('[test_api] ERROR:', err.message);
} finally {
  // Only chats this run created and failed to delete — the demo corpus itself
  // is never touched.
  if (createdChatIds.length) {
    await prisma.chat.deleteMany({ where: { id: { in: createdChatIds } } }).catch(() => {});
  }
  await prisma.$disconnect();
  server.kill();
}

console.log(failures === 0 ? '[test_api] all checks passed' : `[test_api] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
