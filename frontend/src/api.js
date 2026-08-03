// Thin fetch wrappers over the Express API. Every request (except login)
// carries the JWT from localStorage; a 401 clears the token and reloads so the
// app lands back on the login page.
//
// Demo build: the corpus is pre-indexed and read-only, so there is no register,
// no collection create/delete, no upload/delete and no pipeline here. Chats are
// the only thing the UI writes.

const TOKEN_KEY = 'opencrawl_token';

export const getToken   = () => localStorage.getItem(TOKEN_KEY);
export const setToken   = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Authorization header — also used by pdf.js when fetching PDFs. */
export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (response.status === 401 && getToken()) {
    clearToken();
    window.location.reload();   // expired token → login page
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

/** Same auth/401 handling as request(), for routes that return HTML. */
async function requestText(url) {
  const response = await fetch(url, { headers: authHeaders() });
  if (response.status === 401 && getToken()) {
    clearToken();
    window.location.reload();
  }
  const body = await response.text();
  if (!response.ok) {
    // Errors come back as JSON even though success is HTML.
    let message = `HTTP ${response.status}`;
    try { message = JSON.parse(body).error ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return body;
}

const postJson = (url, payload) =>
  request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

// ── Auth ─────────────────────────────────────────────────────────────────────

export const login  = (email, password) => postJson('/api/auth/login', { email, password });
export const getMe  = () => request('/api/auth/me');

// ── Collections (read-only) ──────────────────────────────────────────────────

export const getCollections = () => request('/api/collections');

// ── Chats (each bound to a collection) ───────────────────────────────────────

export const getChats   = () => request('/api/chats');
export const createChat = (collectionId) => postJson('/api/chats', { collectionId });
export const getChat    = (chatId) => request(`/api/chats/${chatId}`);
export const deleteChat = (chatId) => request(`/api/chats/${chatId}`, { method: 'DELETE' });
export const updateChat = (chatId, fields) =>
  request(`/api/chats/${chatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });

// ── Documents (per collection, read-only) ────────────────────────────────────

export const getDocuments = (collectionId) => request(`/api/collections/${collectionId}/documents`);

/** Where to fetch a PDF from: a Supabase signed URL in deployment, a local
 *  API path in development. Async because the signed URL is minted per view. */
export const getPdfUrl = (collectionId, docId) =>
  request(`/api/collections/${collectionId}/documents/${encodeURIComponent(docId)}/pdf-url`)
    .then((response) => response.url);

// ── Corpus (per collection) ──────────────────────────────────────────────────

export const getEmbeddingMap = (collectionId) => request(`/api/collections/${collectionId}/corpus/embedding-map`);
export const getGraph        = (collectionId) => request(`/api/collections/${collectionId}/corpus/graph`);
export const getGraphHtml    = (collectionId) => requestText(`/api/collections/${collectionId}/corpus/graph/view`);
export const getChunk        = (collectionId, chunkId) =>
  request(`/api/collections/${collectionId}/corpus/chunks/${encodeURIComponent(chunkId)}`);

// ── Chat (RAG) ───────────────────────────────────────────────────────────────

/** Models this deployment can answer with, plus the one used when none is sent. */
export const getChatModels = () => request('/api/models');

export const postChat = (chatId, payload) => postJson(`/api/chats/${chatId}/chat`, payload);
