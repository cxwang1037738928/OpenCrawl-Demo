/**
 * db.js — shared PrismaClient singleton (one connection pool per process).
 *
 * Remote connections get sslmode=require added when they don't specify one.
 * Prisma's default is `prefer`, which negotiates TLS and then fails outright if
 * the handshake does not go its way rather than falling back — and Supabase's
 * pooler requires TLS regardless, so being explicit costs nothing and removes a
 * failure mode that only shows up in deployment. Localhost is left alone: the
 * dev Postgres container serves no TLS at all.
 */

import { PrismaClient } from '@prisma/client';

function connectionUrl() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) return undefined;                       // let Prisma raise its own error
  if (/sslmode=/.test(url)) return url;             // caller has an opinion; respect it
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return url;
  return url.includes('?') ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const url = connectionUrl();

export const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
