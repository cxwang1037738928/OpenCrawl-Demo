/**
 * seed.js — creates the demo account (demo@gmail.com / demo123), the only
 * account this build can log into (see backend/middleware/auth.js).
 * Run: npm run db:seed (idempotent — upserts by email).
 *
 * The demo corpus itself is not seeded here: collections, documents, chunks and
 * graph artifacts are restored from a database dump, since the pipeline that
 * would build them is not part of this build.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_EMAIL    = (process.env.DEMO_EMAIL || 'demo@gmail.com').trim().toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo123';

async function main() {
  // Reset the password on every run so a rotated demo credential always matches
  // what the login screen advertises.
  const password = await bcrypt.hash(DEMO_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where:  { email: DEMO_EMAIL },
    update: { password },
    create: { email: DEMO_EMAIL, password },
  });
  console.log(`[seed] demo user ready (id=${user.id}, email=${user.email})`);
}

main()
  .catch((err) => { console.error('[seed]', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
