/**
 * routes/chats.js — /api/chats (login required; server.js applies
 * `requireAuth` first). A chat belongs to a collection; ownership is checked
 * through the collection's owner.
 *
 *   GET    /            — the owner's chats (newest activity first), each
 *                         with its collection's {id, name, color, crawler}
 *   POST   /            — create a chat {collectionId (required), title?}
 *   GET    /:chatId     — one chat incl. conversation
 *   PATCH  /:chatId     — {title?} rename · {conversation?} rewrite (the UI
 *                         uses the latter to persist deleted Q/A pairs)
 *   DELETE /:chatId     — delete the chat (its collection stays)
 *   POST   /:chatId/chat — RAG chat (chat.js)
 */

import 'dotenv/config';
import { Router } from 'express';
import { prisma } from '../db.js';
import { chatRouter } from './chat.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const chatSummary = (chat) => ({
  id:         chat.id,
  title:      chat.title,
  collection: chat.collection
    ? {
        id:      chat.collection.id,
        name:    chat.collection.name,
        color:   chat.collection.color,
        crawler: chat.collection.crawler,
      }
    : undefined,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

/**
 * Exactly the fields chatSummary reads. NOT `include: { collection: true }`:
 * that pulls the collection's docVectors, knowledgeGraph and knowledgeGraphHtml
 * — 5.2 MB for the 192-document collection — and Prisma deserializes a separate
 * copy per chat row. Since every visitor shares the demo account's chat list and
 * can create chats, that cost grows without bound: ~16 MB at 3 chats, ~260 MB at
 * 50, ~1 GB at 200, for a payload chatSummary reduces to about 150 bytes.
 * Selecting also drops each chat's own `conversation` JSON, which the list
 * discards but which grows with every message sent.
 */
const CHAT_SUMMARY_SELECT = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  collection: { select: { id: true, name: true, color: true, crawler: true } },
};

export const chatsRouter = Router();

chatsRouter.get('/', wrap(async (req, res) => {
  const chats = await prisma.chat.findMany({
    where: { collection: { userId: req.user.id } },
    orderBy: { updatedAt: 'desc' },
    select: CHAT_SUMMARY_SELECT,
  });
  res.json({ chats: chats.map(chatSummary) });
}));

chatsRouter.post('/', wrap(async (req, res) => {
  const { collectionId, title } = req.body ?? {};
  if (!Number.isInteger(collectionId)) throw httpError(400, '"collectionId" is required');
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: req.user.id },
  });
  if (!collection) throw httpError(404, `No collection ${collectionId}`);
  const chat = await prisma.chat.create({
    data: {
      title: typeof title === 'string' && title.trim() ? title.trim() : 'New chat',
      collectionId: collection.id,
    },
    select: CHAT_SUMMARY_SELECT,
  });
  res.status(201).json({ chat: chatSummary(chat) });
}));

/** Everything below /:chatId is ownership-checked (via the collection) here;
 * req.chat carries the chat row with its collection included. */
const loadOwnedChat = wrap(async (req, res, next) => {
  const chatId = parseInt(req.params.chatId, 10);
  if (!Number.isInteger(chatId)) throw httpError(400, 'chatId must be an integer');
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, collection: { userId: req.user.id } },
    // The conversation is needed here (chat.js appends to it), but of the
    // collection only what retrieval reads: corpusUpdatedAt is the corpus
    // cache key, categories drives the keyword boost, embeddingsMeta checks
    // the query's dimensions. docVectors/knowledgeGraph/knowledgeGraphHtml are
    // 5.2 MB on the big collection and none of them are read on this path —
    // loadCorpus fetches knowledgeGraph itself, once per corpus, not per message.
    include: {
      collection: {
        select: {
          id: true, name: true, color: true, crawler: true,
          corpusUpdatedAt: true, categories: true, embeddingsMeta: true,
        },
      },
    },
  });
  if (!chat) throw httpError(404, `No chat ${chatId}`);
  req.chat = chat;
  next();
});

chatsRouter.use('/:chatId', loadOwnedChat);

chatsRouter.get('/:chatId', (req, res) => {
  res.json({ chat: { ...chatSummary(req.chat), conversation: req.chat.conversation } });
});

chatsRouter.patch('/:chatId', wrap(async (req, res) => {
  const { title, conversation } = req.body ?? {};
  const data = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw httpError(400, '"title" must be a non-empty string');
    data.title = title.trim();
  }
  if (conversation !== undefined) {
    const isMessage = (message) =>
      message && typeof message.role === 'string' && typeof message.content === 'string';
    if (!Array.isArray(conversation) || !conversation.every(isMessage)) {
      throw httpError(400, '"conversation" must be an array of {role, content} messages');
    }
    data.conversation = conversation;
  }
  if (Object.keys(data).length === 0) throw httpError(400, 'Nothing to update');
  const chat = await prisma.chat.update({
    where: { id: req.chat.id },
    data,
    select: CHAT_SUMMARY_SELECT,
  });
  res.json({ chat: chatSummary(chat) });
}));

chatsRouter.delete('/:chatId', wrap(async (req, res) => {
  await prisma.chat.delete({ where: { id: req.chat.id } });
  res.json({ ok: true, id: req.chat.id });
}));

chatsRouter.use('/:chatId/chat', chatRouter);
