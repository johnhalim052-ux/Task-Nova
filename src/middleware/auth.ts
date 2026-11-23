import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { users, wallets } from '../db/schema.ts';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifyAuthToken } from '../lib/security.ts';

export interface AuthenticatedUser {
  id: number;
  uid: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  accountVerified: boolean;
  accountStatus: string;
}

export interface AuthRequest extends Request {
  authUser?: AuthenticatedUser;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing Bearer token.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty Bearer token.' });
  }

  // 1. Try TaskNova signed JWT first
  try {
    const payload = verifyAuthToken(token);
    const [user] = await db.select().from(users).where(eq(users.id, payload.sub));
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Account no longer exists.' });
    }
    if (user.accountStatus !== 'active') {
      return res.status(403).json({ error: `Account is currently ${user.accountStatus}.` });
    }
    req.authUser = {
      id: user.id,
      uid: user.uid,
      email: user.email,
      name: user.name,
      role: user.role,
      emailVerified: user.emailVerified,
      accountVerified: user.accountVerified,
      accountStatus: user.accountStatus,
    };
    return next();
  } catch {
    // Not a local TaskNova JWT; fall through to Firebase ID Token verification
  }

  // 2. Verify Firebase ID token via firebase-admin (Cloud SQL Step 4 requirement)
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const email = (decoded.email || `${decoded.uid}@firebase.local`).toLowerCase();
    const displayName = decoded.name || email.split('@')[0] || 'TaskNova Member';

    const upserted = await db.transaction(async (tx) => {
      const [existingByEmail] = await tx.select().from(users).where(eq(users.email, email));
      let userRow;
      if (existingByEmail) {
        const [updated] = await tx
          .update(users)
          .set({
            uid: decoded.uid,
            emailVerified: Boolean(decoded.email_verified || existingByEmail.emailVerified),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingByEmail.id))
          .returning();
        userRow = updated;
      } else {
        const [inserted] = await tx
          .insert(users)
          .values({
            uid: decoded.uid || `fb_${crypto.randomUUID()}`,
            email,
            name: displayName,
            role: 'worker',
            emailVerified: Boolean(decoded.email_verified),
          })
          .onConflictDoUpdate({
            target: users.uid,
            set: { email, updatedAt: new Date() },
          })
          .returning();
        userRow = inserted;
      }

      await tx.insert(wallets).values({ userId: userRow.id }).onConflictDoNothing({ target: wallets.userId });
      return userRow;
    });

    if (upserted.accountStatus !== 'active') {
      return res.status(403).json({ error: `Account is currently ${upserted.accountStatus}.` });
    }

    req.authUser = {
      id: upserted.id,
      uid: upserted.uid,
      email: upserted.email,
      name: upserted.name,
      role: upserted.role,
      emailVerified: upserted.emailVerified,
      accountVerified: upserted.accountVerified,
      accountStatus: upserted.accountStatus,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token.' });
  }
}

export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!allowedRoles.includes(req.authUser.role)) {
      return res.status(403).json({ error: `Forbidden: Requires role (${allowedRoles.join(' or ')}).` });
    }
    return next();
  };
}
