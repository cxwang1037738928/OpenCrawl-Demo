/**
 * middleware/auth.js — JWT auth. Login is required to use the app.
 *
 * DEMO_EMAIL           — the single account this build serves (see routes/auth.js).
 * signToken(user)      — issues a token carrying {sub, email, isAdmin}.
 * userFromRequest(req) — the user in the Bearer token, or null.
 * requireAuth          — 401 unless a valid DEMO token is present; attaches
 *                        req.user = {id, email, isAdmin}.
 *
 * The demo-account check lives here rather than only at login so a token minted
 * for some other account — by an earlier build, or against a database that
 * still holds one — cannot reach anyone else's collections.
 */

import 'dotenv/config';
import jwt from 'jsonwebtoken';

// The dev fallback is a PUBLIC string in a public repo — anyone could forge a
// token with it. Fine on localhost, never in a deployment, and .env is
// gitignored so forgetting to set it on the host is the easy mistake. Fail at
// boot instead of silently serving forgeable sessions.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production — refusing to start with the dev fallback');
}
const JWT_SECRET = process.env.JWT_SECRET || 'opencrawl-local-dev-secret';
const TOKEN_TTL  = process.env.JWT_TTL || '7d';

export const DEMO_EMAIL = (process.env.DEMO_EMAIL || 'demo@gmail.com').trim().toLowerCase();

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

/** The user carried by a Bearer token, or null (missing/expired/invalid/not the demo account). */
export function userFromRequest(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if ((payload.email || '').toLowerCase() !== DEMO_EMAIL) return null;
    return { id: payload.sub, email: payload.email, isAdmin: !!payload.isAdmin };
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  req.user = userFromRequest(req);
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
