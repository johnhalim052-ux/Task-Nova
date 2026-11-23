import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { adminLogs, employers, notifications, users, wallets } from '../db/schema.ts';
import { type AuthRequest, requireAuth } from '../middleware/auth.ts';
import { generateRandomToken, getClientIp, hashToken, signAuthToken } from '../lib/security.ts';
import { isSmtpConfigured, sendPasswordResetEmail, sendVerificationEmail } from '../services/mailer.ts';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 35,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests. Please try again in 15 minutes.' },
});

const registerSchema = z.object({
  email: z.string().trim().email().max(180),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(2).max(100),
  role: z.enum(['worker', 'employer']).default('worker'),
  companyName: z.string().trim().max(120).optional(),
  website: z.string().trim().max(240).optional(),
  businessDescription: z.string().trim().max(600).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(180),
  password: z.string().min(1).max(128),
});

const setupAdminSchema = z.object({
  email: z.string().trim().email().max(180),
  password: z.string().min(10).max(128),
  name: z.string().trim().min(2).max(100),
  bootstrapKey: z.string().optional(),
});

router.get('/status', async (_req, res) => {
  try {
    const [adminCountRow] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.role, 'admin'));

    res.json({
      hasAdmin: Number(adminCountRow?.value || 0) > 0,
      requiresBootstrapKey: Boolean(process.env.ADMIN_BOOTSTRAP_KEY?.trim()),
      smtpConfigured: isSmtpConfigured(),
      googleAuthConfigured: true,
    });
  } catch (err) {
    console.error('Auth status check failed:', err);
    res.status(500).json({ error: 'Unable to read authentication status.' });
  }
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' });
    }

    const email = parsed.data.email.toLowerCase();
    if (parsed.data.role === 'employer' && (!parsed.data.companyName || parsed.data.companyName.length < 2)) {
      return res.status(400).json({ error: 'Company name is required for employer accounts.' });
    }

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const rawVerifyToken = generateRandomToken(24);
    const verifyTokenHash = hashToken(rawVerifyToken);
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const uid = `tn_${crypto.randomUUID()}`;

    const createdUser = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          uid,
          email,
          passwordHash,
          name: parsed.data.name,
          role: parsed.data.role,
          emailVerified: false,
          accountVerified: false,
          accountStatus: 'active',
          verificationTokenHash: verifyTokenHash,
          verificationExpiresAt: verifyExpires,
          lastLoginIp: getClientIp(req),
          lastLoginAt: new Date(),
        })
        .returning();

      await tx.insert(wallets).values({ userId: user.id });

      if (parsed.data.role === 'employer') {
        await tx.insert(employers).values({
          userId: user.id,
          companyName: parsed.data.companyName || parsed.data.name,
          website: parsed.data.website || '',
          businessDescription: parsed.data.businessDescription || '',
          verificationStatus: 'pending',
        });
      }

      await tx.insert(notifications).values({
        userId: user.id,
        type: 'info',
        title: 'Welcome to TaskNova',
        message:
          parsed.data.role === 'employer'
            ? 'Your employer profile is pending admin verification before publishing paid campaigns.'
            : 'Verify your email address and complete your profile to start earning on TaskNova.',
      });

      return user;
    });

    const emailDispatch = await sendVerificationEmail(email, createdUser.name, rawVerifyToken);
    const token = signAuthToken({
      sub: createdUser.id,
      uid: createdUser.uid,
      role: createdUser.role,
      email: createdUser.email,
    });

    res.status(201).json({
      token,
      emailDispatch,
      user: {
        id: createdUser.id,
        uid: createdUser.uid,
        email: createdUser.email,
        name: createdUser.name,
        role: createdUser.role,
        emailVerified: createdUser.emailVerified,
        accountVerified: createdUser.accountVerified,
        accountStatus: createdUser.accountStatus,
      },
    });
  } catch (err) {
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password are required.' });
    }

    const email = parsed.data.email.toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.accountStatus !== 'active') {
      return res.status(403).json({ error: `Account is currently ${user.accountStatus}. Contact support.` });
    }

    const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!valid) {
      await db
        .update(users)
        .set({ failedLoginCount: user.failedLoginCount + 1, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    await db
      .update(users)
      .set({
        failedLoginCount: 0,
        lastLoginIp: getClientIp(req),
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const token = signAuthToken({
      sub: user.id,
      uid: user.uid,
      role: user.role,
      email: user.email,
    });

    res.json({
      token,
      user: {
        id: user.id,
        uid: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: user.emailVerified,
        accountVerified: user.accountVerified,
        accountStatus: user.accountStatus,
      },
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Unable to sign in right now.' });
  }
});

router.post('/firebase', authLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    res.json({ user: req.authUser });
  } catch (err) {
    console.error('Firebase auth sync failed:', err);
    res.status(500).json({ error: 'Unable to synchronize Google account.' });
  }
});

router.post('/setup-admin', authLimiter, async (req, res) => {
  try {
    const parsed = setupAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid admin setup input.' });
    }

    const requiredKey = process.env.ADMIN_BOOTSTRAP_KEY?.trim();
    if (requiredKey) {
      const provided = parsed.data.bootstrapKey?.trim() || '';
      const a = Buffer.from(requiredKey);
      const b = Buffer.from(provided);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Invalid ADMIN_BOOTSTRAP_KEY.' });
      }
    }

    const email = parsed.data.email.toLowerCase();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const adminUser = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(982451653)`);
      const [adminCount] = await tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.role, 'admin'));

      if (Number(adminCount?.value || 0) > 0) {
        throw new Error('ALREADY_INITIALIZED');
      }

      const [existingEmail] = await tx.select().from(users).where(eq(users.email, email));
      if (existingEmail) {
        throw new Error('EMAIL_EXISTS');
      }

      const [inserted] = await tx
        .insert(users)
        .values({
          uid: `tn_admin_${crypto.randomUUID()}`,
          email,
          passwordHash,
          name: parsed.data.name,
          role: 'admin',
          emailVerified: true,
          accountVerified: true,
          accountStatus: 'active',
          lastLoginIp: getClientIp(req),
          lastLoginAt: new Date(),
        })
        .returning();

      await tx.insert(wallets).values({ userId: inserted.id });
      await tx.insert(adminLogs).values({
        adminId: inserted.id,
        action: 'INITIALIZE_ADMIN',
        targetType: 'user',
        targetId: String(inserted.id),
        details: `Initial admin account provisioned for ${inserted.email}`,
        ipAddress: getClientIp(req),
      });

      return inserted;
    });

    const token = signAuthToken({
      sub: adminUser.id,
      uid: adminUser.uid,
      role: adminUser.role,
      email: adminUser.email,
    });

    res.status(201).json({
      token,
      user: {
        id: adminUser.id,
        uid: adminUser.uid,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
        emailVerified: adminUser.emailVerified,
        accountVerified: adminUser.accountVerified,
        accountStatus: adminUser.accountStatus,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'ALREADY_INITIALIZED') {
      return res.status(409).json({ error: 'An administrator account already exists. Setup is locked.' });
    }
    if (err instanceof Error && err.message === 'EMAIL_EXISTS') {
      return res.status(409).json({ error: 'That email is already registered.' });
    }
    console.error('Admin setup failed:', err);
    res.status(500).json({ error: 'Unable to complete initial admin setup.' });
  }
});

router.post('/verify-email', authLimiter, async (req, res) => {
  try {
    const tokenRaw = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!tokenRaw) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }

    const tokenHash = hashToken(tokenRaw);
    const [matched] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.verificationTokenHash, tokenHash),
          gt(users.verificationExpiresAt, new Date())
        )
      );

    if (!matched) {
      return res.status(400).json({ error: 'Invalid or expired verification token.' });
    }

    await db
      .update(users)
      .set({
        emailVerified: true,
        verificationTokenHash: null,
        verificationExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, matched.id));

    res.json({ ok: true, message: 'Email address verified successfully.' });
  } catch (err) {
    console.error('Verify email failed:', err);
    res.status(500).json({ error: 'Unable to verify email token.' });
  }
});

router.post('/resend-verification', authLimiter, requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (req.authUser.emailVerified) {
      return res.json({ ok: true, alreadyVerified: true, message: 'Email is already verified.' });
    }

    const rawToken = generateRandomToken(24);
    await db
      .update(users)
      .set({
        verificationTokenHash: hashToken(rawToken),
        verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.authUser.id));

    const emailDispatch = await sendVerificationEmail(req.authUser.email, req.authUser.name, rawToken);
    res.json({
      ok: emailDispatch.sent,
      emailDispatch,
      message: emailDispatch.sent
        ? 'Verification email dispatched.'
        : 'SMTP is not configured on this server; verification email could not be sent.',
    });
  } catch (err) {
    console.error('Resend verification failed:', err);
    res.status(500).json({ error: 'Unable to resend verification email.' });
  }
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email));
    const smtpConfigured = isSmtpConfigured();

    if (user && user.passwordHash) {
      const rawToken = generateRandomToken(24);
      await db
        .update(users)
        .set({
          resetTokenHash: hashToken(rawToken),
          resetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await sendPasswordResetEmail(user.email, user.name, rawToken);
    }

    res.json({
      ok: true,
      smtpConfigured,
      message: smtpConfigured
        ? 'If an account matches that email, a password reset link has been sent.'
        : 'SMTP email delivery is not configured yet. Configure SMTP_* environment variables to send password reset emails.',
    });
  } catch (err) {
    console.error('Forgot password failed:', err);
    res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const tokenRaw = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!tokenRaw || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Valid reset token and password (8+ characters) are required.' });
    }

    const tokenHash = hashToken(tokenRaw);
    const [matched] = await db
      .select()
      .from(users)
      .where(and(eq(users.resetTokenHash, tokenHash), gt(users.resetExpiresAt, new Date())));

    if (!matched) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(users)
      .set({
        passwordHash,
        resetTokenHash: null,
        resetExpiresAt: null,
        failedLoginCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, matched.id));

    res.json({ ok: true, message: 'Password updated successfully. You may now sign in.' });
  } catch (err) {
    console.error('Reset password failed:', err);
    res.status(500).json({ error: 'Unable to reset password.' });
  }
});

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const authUser = req.authUser!;
    const [user] = await db.select().from(users).where(eq(users.id, authUser.id));
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, authUser.id));
    const [employer] = await db.select().from(employers).where(eq(employers.userId, authUser.id));
    const [unreadRow] = await db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, authUser.id), eq(notifications.isRead, false)));

    res.json({
      user: user
        ? {
            id: user.id,
            uid: user.uid,
            email: user.email,
            name: user.name,
            role: user.role,
            bio: user.bio,
            country: user.country,
            payoutPreference: user.payoutPreference,
            emailVerified: user.emailVerified,
            accountVerified: user.accountVerified,
            accountStatus: user.accountStatus,
            createdAt: user.createdAt,
          }
        : null,
      wallet: wallet || {
        availableCents: 0,
        pendingCents: 0,
        totalEarnedCents: 0,
        totalWithdrawnCents: 0,
      },
      employer: employer || null,
      unreadNotifications: Number(unreadRow?.value || 0),
    });
  } catch (err) {
    console.error('Load /me failed:', err);
    res.status(500).json({ error: 'Failed to load account context.' });
  }
});

export default router;
