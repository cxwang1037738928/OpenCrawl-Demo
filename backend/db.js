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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

/**
 * One line at boot describing what we are about to connect with. Exists because
 * "Error opening a TLS connection: OpenSSL error" names neither the endpoint nor
 * the engine, and on a host you cannot shell into that leaves nothing to reason
 * from. Credentials are never printed — host, port and query flags only.
 */
function logConnectionDiagnostics(url) {
  const engineDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.prisma', 'client');
  let engines = [];
  try {
    engines = fs.readdirSync(engineDir).filter((f) => f.startsWith('libquery_engine'));
  } catch { /* not generated here (e.g. a different node_modules root) */ }

  let endpoint = '(unset)';
  let flags = '';
  try {
    const parsed = new URL(url);
    endpoint = `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
    flags = parsed.search || '(none)';
  } catch { /* malformed or absent — that itself is the finding */ }

  console.log(`[db] endpoint ${endpoint}  query ${flags}`);
  console.log(`[db] node openssl ${process.versions.openssl}  platform ${process.platform}/${process.arch}`);
  console.log(`[db] prisma engines present: ${engines.length ? engines.join(', ') : '(none found)'}`);
}

function connectionUrl() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) return undefined;                       // let Prisma raise its own error
  if (/sslmode=/.test(url)) return url;             // caller has an opinion; respect it
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return url;
  return url.includes('?') ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const url = connectionUrl();

logConnectionDiagnostics(url ?? process.env.DATABASE_URL ?? '');

export const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
