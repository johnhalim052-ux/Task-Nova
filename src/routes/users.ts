import bcrypt from 'bcryptjs';
import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { notifications, taskSubmissions, tasks, users, wallets } from '../db/schema.ts';
import { type AuthRequest, requireAuth } from '../middleware/auth.ts';

const router = Router();

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(100),
  bio: z.string().trim().max(500).default(''),
  country: z.string().trim().max(80).default(''),
  payoutPreference: z.enum(['paypal', 'usdt', 'vodafone_cash']).default('paypal'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

router.get('/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.authUser!.id;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const submissions = await db
      .select({
        id: taskSubmissions.id,
        status: taskSubmissions.status,
        rewardCentsSnapshot: taskSubmissions.rewardCentsSnapshot,
        acceptedAt: taskSubmissions.acceptedAt,
        submittedAt: taskSubmissions.submittedAt,
        reviewedAt: taskSubmissions.reviewedAt,
        taskTitle: tasks.title,
        taskCategory: tasks.category,
      })
      .from(taskSubmissions)
      .innerJoin(tasks, eq(taskSubmissions.taskId, tasks.id))
      .where(eq(taskSubmissions.userId, userId))
      .orderBy(desc(taskSubmissions.acceptedAt))
      .limit(20);

    const approvedCount = submissions.filter((s) => s.status === 'approved').length;
    const rejectedCount = submissions.filter((s) => s.status === 'rejected').length;
    const pendingReviewCount = submissions.filter((s) => s.status === 'submitted').length;
    const activeCount = submissions.filter((s) => s.status === 'accepted').length;
    const reviewedTotal = approvedCount + rejectedCount;
    const successRate = reviewedTotal > 0 ? Math.round((approvedCount / reviewedTotal) * 100) : 100;

    res.json({
      wallet: wallet || {
        availableCents: 0,
        pendingCents: 0,
        totalEarnedCents: 0,
        totalWithdrawnCents: 0,
      },
      stats: {
        approvedCount,
        rejectedCount,
        pendingReviewCount,
        activeCount,
        successRate,
      },
      recentSubmissions: submissions.slice(0, 8),
    });
  } catch (err) {
    console.error('Worker dashboard query failed:', err);
    res.status(500).json({ error: 'Unable to load dashboard metrics.' });
  }
});

router.patch('/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid profile fields.' });
    }

    const [updated] = await db
      .update(users)
      .set({
        name: parsed.data.name,
        bio: parsed.data.bio,
        country: parsed.data.country,
        payoutPreference: parsed.data.payoutPreference,
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.authUser!.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        bio: users.bio,
        country: users.country,
        payoutPreference: users.payoutPreference,
      });

    res.json({ user: updated });
  } catch (err) {
    console.error('Update profile failed:', err);
    res.status(500).json({ error: 'Unable to update profile settings.' });
  }
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid password input.' });
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.authUser!.id));
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: 'Password changes are only available for email/password accounts.' });
    }

    const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const nextHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await db
      .update(users)
      .set({ passwordHash: nextHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    res.json({ ok: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Change password failed:', err);
    res.status(500).json({ error: 'Unable to update password.' });
  }
});

router.post('/request-verification', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.authUser!.id;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    if (user.accountVerified) {
      return res.json({ ok: true, message: 'Your account is already identity-verified.' });
    }

    await db.insert(notifications).values({
      userId,
      type: 'info',
      title: 'Identity Verification Queued',
      message: 'Your account verification request has been logged for admin review.',
    });

    res.json({ ok: true, message: 'Verification request submitted for compliance review.' });
  } catch (err) {
    console.error('Account verification request failed:', err);
    res.status(500).json({ error: 'Unable to submit verification request.' });
  }
});

router.get('/notifications', requireAuth, async (req: AuthRequest, res) => {
  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.authUser!.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    res.json({ notifications: rows });
  } catch (err) {
    console.error('Notifications fetch failed:', err);
    res.status(500).json({ error: 'Unable to fetch notifications.' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid notification ID.' });
    }

    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, req.authUser!.id)));

    res.json({ ok: true });
  } catch (err) {
    console.error('Notification mark-read failed:', err);
    res.status(500).json({ error: 'Unable to update notification.' });
  }
});

router.post('/notifications/read-all', requireAuth, async (req: AuthRequest, res) => {
  try {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.userId, req.authUser!.id));

    res.json({ ok: true });
  } catch (err) {
    console.error('Notifications mark-all-read failed:', err);
    res.status(500).json({ error: 'Unable to mark notifications read.' });
  }
});

export default router;
