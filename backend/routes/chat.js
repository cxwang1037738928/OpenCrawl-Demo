/**
 * routes/chat.js — /api/chats/:chatId/chat  (req.chat with its collection
 * included, and req.user, set upstream)
 *
 * RAG chat over the chat's collection. The frontend embeds the user's
 * question in the browser (same MiniLM model as the corpus) and sends the
 * vector along; retrieval + Ollama answering happen here (retriever/).
 *
 * POST /
 *   Request:  { content: string, queryEmbedding: number[] }
 *   Response: { reply, model, sources: [{chunkId, docId, filename, heading, pages, sim, boost, score, quotes}] }
 *             sources[n-1] is what a [n] citation marker in reply refers to;
 *             quotes = verbatim spans in reply that this source grounds (the
 *             PDF viewer highlights exactly these when the citation is clicked)
 *   Errors:   400 bad payload · 502 Ollama failure · 503 missing corpus/model
 *
 * The conversation persists on the Chat row: both the user message and the
 * assistant reply (with sources) are appended to Chat.conversation. Everyone
 * shares the demo account, so everyone shares that history.
 */

import { Router } from 'express';
import { retrieve, retrieveFacts, answer } from '../retriever/retriever.js';
import { isAllowedChatModel, defaultChatModel } from '../chat_models.js';
import { prisma } from '../db.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const chatRouter = Router();

chatRouter.post('/', wrap(async (req, res) => {
  const { content, queryEmbedding, model: requestedModel } = req.body ?? {};

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: '"content" must be a non-empty string' });
  }
  if (!Array.isArray(queryEmbedding)
      || queryEmbedding.some((component) => typeof component !== 'number')) {
    return res.status(400).json({ error: '"queryEmbedding" must be a number array (computed in the browser)' });
  }
  // Checked against the allowlist, not merely sanitised: the id is what selects
  // the provider (chatProvider in retriever.js), so an arbitrary value from the
  // browser would choose where this request is sent.
  if (requestedModel !== undefined && !isAllowedChatModel(requestedModel)) {
    return res.status(400).json({ error: `Model "${requestedModel}" is not available` });
  }
  // Per request, deliberately: every visitor shares the demo account, so a
  // stored global setting would let one of them switch models underneath another.
  const chatModel = requestedModel ?? defaultChatModel();

  // LLM history = stored conversation (roles + text only) + the new question.
  const conversation = Array.isArray(req.chat.conversation) ? req.chat.conversation : [];
  const messages = [
    ...conversation.map(({ role, content: text }) => ({ role, content: text })),
    { role: 'user', content },
  ];

  const chunks = await retrieve(req.chat.collection, queryEmbedding, content);
  // Graph facts are additive: chunk retrieval is untouched, and a collection
  // with no graph (or a question naming no known entity) answers exactly as before.
  const { facts } = await retrieveFacts(req.chat.collection, content);
  const { reply, model, quotesByChunk } = await answer(messages, chunks, facts, { model: chatModel });

  // Full text + embedding stay server-side (text is large; embedding is a
  // grounding artifact the browser has no use for).
  const sources = chunks.map(({ text, embedding, ...sourceMeta }, chunkIdx) =>
    ({ ...sourceMeta, quotes: quotesByChunk[chunkIdx] }));

  await prisma.chat.update({
    where: { id: req.chat.id },
    data: {
      conversation: [
        ...conversation,
        { role: 'user', content },
        { role: 'assistant', content: reply, sources },
      ],
      // First exchange titles the chat after the question.
      ...(conversation.length === 0 && req.chat.title === 'New chat'
        ? { title: content.trim().slice(0, 60) }
        : {}),
    },
  });

  res.json({ reply, model, sources });
}));
