/**
 * db.js — shared PrismaClient singleton (one connection pool per process).
 *
 * Connections go through node-postgres via Prisma's driver adapter, NOT the
 * Rust query engine's built-in TCP/TLS stack. Measured on Render: every TLS
 * setting — require, no-verify, prefer, accept_invalid_certs, and even
 * disable — failed identically with "Error opening a TLS connection: OpenSSL
 * error". `disable` failing that way is the tell: the engine cannot do TLS in
 * that image at all, because its debian-openssl-3.0.x build links the system
 * OpenSSL and Render's is 3.5. No connection string can fix that.
 *
 * node-postgres uses Node's own OpenSSL (3.5.7 there), which works. The same
 * code path runs locally against the dev container, so there is one behaviour
 * to reason about rather than two.
 *
 * TLS is enabled for remote hosts with rejectUnauthorized:false — Supabase's
 * pooler presents a certificate for *.supabase.com that will not verify against
 * the pooler hostname, and the credential protecting this database is the
 * password, not the certificate chain. Localhost gets no TLS: the dev container
 * serves none.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * One line at boot describing what we are about to connect with. Exists because
 * "Error opening a TLS connection: OpenSSL error" names neither the endpoint nor
 * the engine, and on a host you cannot shell into that leaves nothing to reason
 * from. Credentials are never printed — host, port and query flags only.
 */
export function connectionDiagnostics(url = connectionUrl() ?? process.env.DATABASE_URL ?? '') {
  const engineDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.prisma', 'client');
  let engines = [];
  try {
    engines = fs.readdirSync(engineDir).filter((f) => f.startsWith('libquery_engine'));
  } catch { /* not generated here (e.g. a different node_modules root) */ }

  let endpoint = '(unset)';
  let flags = '(none)';
  try {
    const parsed = new URL(url);
    endpoint = `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
    flags = parsed.search || '(none)';
  } catch { /* malformed or absent — that itself is the finding */ }

  return {
    endpoint,                     // host:port/db — no credentials
    flags,                        // query string, to confirm sslmode/pgbouncer
    nodeOpenssl: process.versions.openssl,
    platform: `${process.platform}/${process.arch}`,
    engines,                      // which libquery_engine files exist on disk
    databaseUrlSet: Boolean((process.env.DATABASE_URL || '').trim()),
  };
}

function logConnectionDiagnostics(url) {
  const d = connectionDiagnostics(url);
  console.log(`[db] endpoint ${d.endpoint}  query ${d.flags}`);
  console.log(`[db] node openssl ${d.nodeOpenssl}  platform ${d.platform}`);
  console.log(`[db] prisma engines present: ${d.engines.length ? d.engines.join(', ') : '(none found)'}`);
}

function connectionUrl() {
  return (process.env.DATABASE_URL || '').trim() || undefined;
}

const isLocal = (url) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url || '');

const url = connectionUrl();

logConnectionDiagnostics(url ?? '');

// pg parses sslmode from the connection string, but an explicit `ssl` option
// wins and is unambiguous — the string carries pgbouncer=true for Prisma's
// benefit and we do not want pg reinterpreting the rest of it.
const adapter = new PrismaPg({
  connectionString: url,
  ssl: isLocal(url) ? false : { rejectUnauthorized: false },
  // Transaction-mode pgbouncer hands out a different backend per transaction,
  // so a large client-side pool buys nothing and just occupies pooler slots.
  max: parseInt(process.env.DB_POOL_MAX || '5', 10),
});

export const prisma = new PrismaClient({ adapter });
