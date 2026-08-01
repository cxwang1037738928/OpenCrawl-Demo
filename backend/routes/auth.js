/**
 * routes/auth.js — /api/auth (demo build)
 *
 *   POST /login {email, password} — verify credentials, return {token, user}
 *   GET  /me                      — current user (requires Bearer token)
 *
 * This is the public demo: registration is gone and the ONE account anyone can
 * log into is the seeded demo user (DEMO_EMAIL, default demo@gmail.com, seeded
 * by prisma/seed.js). Everybody therefore lands in the same account and shares
 * its collections and chat history by design — the demo corpus is pre-indexed
 * and read-only, so there is nothing per-visitor to keep apart.
 *
 * Passwords are still bcrypt-hashed and checked; the account being public does
 * not mean the password check is skipped.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { DEMO_EMAIL, signToken, userFromRequest } from '../middleware/auth.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicUser = (user) => ({ id: user.id, email: user.email, isAdmin: user.isAdmin });

export const authRouter = Router();

authRouter.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  // Rejected before the password is even checked: a non-demo account may exist
  // in the database (a leftover admin, say) but is not reachable from here.
  if (email.trim().toLowerCase() !== DEMO_EMAIL) {
    return res.status(403).json({
      error: `This demo only accepts the ${DEMO_EMAIL} account`,
    });
  }
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Soft check: {user: null} for visitors and expired tokens — never a 401, so
// the app can boot straight to the login screen instead of erroring.
authRouter.get('/me', wrap(async (req, res) => {
  const tokenUser = userFromRequest(req);
  if (!tokenUser) return res.json({ user: null });
  const user = await prisma.user.findUnique({ where: { id: tokenUser.id } });
  // A token minted for some other account (or before the demo email changed)
  // is treated as no session at all.
  res.json({ user: user && user.email === DEMO_EMAIL ? publicUser(user) : null });
}));
