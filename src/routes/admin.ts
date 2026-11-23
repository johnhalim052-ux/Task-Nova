import { count, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import {
  adminLogs,
  employers,
  notifications,
  taskSubmissions,
  tasks,
  transactions,
  users,
  wallets,
  withdrawals,
} from '../db/schema.ts';
import { type AuthRequest, requireAuth, requireRole } from '../middleware/auth.ts';
import { getClientIp } from '../lib/security.ts';
import {
  PaymentProviderConfigError,
  PaymentProviderExecutionError,
  executeRealProviderPayout,
  getPaymentProvidersStatus,
} from '../services/payments.ts';
import {
  approveSubmissionInTx,
  ensureWalletTx,
  lockWalletTx,
  rejectSubmissionInTx,
} from '../services/wallet.ts';

const router = Router();

router.use(requireAuth, requireRole('admin'));

router.get('/overview', async (_req, res) => {
  try {
    const [userTotal] = await db.select({ value: count() }).from(users);
    const [employerTotal] = await db.select({ value: count() }).from(employers);
    const [taskTotal] = await db.select({ value: count() }).from(tasks);
    const [pendingProofs] = await db
      .select({ value: count() })
      .from(taskSubmissions)
      .where(eq(taskSubmissions.status, 'submitted'));
    const [pendingWithdrawals] = await db
      .select({ value: count() })
      .from(withdrawals)
      .where(eq(withdrawals.status, 'pending'));

    const walletAgg = await db.execute(
      sql`SELECT COALESCE(SUM(available_cents), 0) AS total_available, COALESCE(SUM(pending_cents), 0) AS total_pending, COALESCE(SUM(total_earned_cents), 0) AS total_earned, COALESCE(SUM(total_withdrawn_cents), 0) AS total_withdrawn FROM wallets`
    );
    const walletRow = walletAgg.rows[0] as Record<string, unknown>;

    // Fraud signals: shared submission IPs & accounts with elevated failed logins or rejections
    const sharedIps = await db.execute(
      sql`SELECT submission_ip, COUNT(DISTINCT user_id) AS distinct_users, COUNT(*) AS submission_count FROM task_submissions WHERE submission_ip IS NOT NULL GROUP BY submission_ip HAVING COUNT(DISTINCT user_id) > 1 ORDER BY distinct_users DESC LIMIT 10`
    );
    const highRejectWorkers = await db.execute(
      sql`SELECT u.id, u.email, u.name, COUNT(*) FILTER (WHERE ts.status = 'rejected') AS rejected_count, COUNT(*) AS total_count FROM task_submissions ts JOIN users u ON u.id = ts.user_id GROUP BY u.id, u.email, u.name HAVING COUNT(*) FILTER (WHERE ts.status = 'rejected') >= 2 ORDER BY rejected_count DESC LIMIT 10`
    );
    const failedLoginSpikes = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        failedLoginCount: users.failedLoginCount,
        lastLoginIp: users.lastLoginIp,
      })
      .from(users)
      .where(sql`${users.failedLoginCount} >= 3`)
      .orderBy(desc(users.failedLoginCount))
      .limit(10);

    res.json({
      analytics: {
        usersCount: Number(userTotal?.value || 0),
        employersCount: Number(employerTotal?.value || 0),
        tasksCount: Number(taskTotal?.value || 0),
        pendingProofsCount: Number(pendingProofs?.value || 0),
        pendingWithdrawalsCount: Number(pendingWithdrawals?.value || 0),
        totalAvailableCents: Number(walletRow?.total_available || 0),
        totalPendingCents: Number(walletRow?.total_pending || 0),
        totalEarnedCents: Number(walletRow?.total_earned || 0),
        totalWithdrawnCents: Number(walletRow?.total_withdrawn || 0),
      },
      fraudSignals: {
        sharedSubmissionIps: sharedIps.rows,
        highRejectWorkers: highRejectWorkers.rows,
        failedLoginSpikes,
      },
      providers: getPaymentProvidersStatus(),
    });
  } catch (err) {
    console.error('Admin overview failed:', err);
    res.status(500).json({ error: 'Unable to load admin analytics.' });
  }
});

router.get('/users', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        emailVerified: users.emailVerified,
        accountVerified: users.accountVerified,
        accountStatus: users.accountStatus,
        failedLoginCount: users.failedLoginCount,
        lastLoginIp: users.lastLoginIp,
        createdAt: users.createdAt,
        availableCents: wallets.availableCents,
        pendingCents: wallets.pendingCents,
        totalEarnedCents: wallets.totalEarnedCents,
      })
      .from(users)
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .orderBy(desc(users.createdAt))
      .limit(100);

    res.json({ users: rows });
  } catch (err) {
    console.error('Admin users failed:', err);
    res.status(500).json({ error: 'Unable to list users.' });
  }
});

const patchUserSchema = z.object({
  accountStatus: z.enum(['active', 'suspended', 'pending_review']).optional(),
  accountVerified: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
});

router.patch('/users/:id', async (req: AuthRequest, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }
    const parsed = patchUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid user update fields.' });
    }
    if (targetId === req.authUser!.id && parsed.data.accountStatus === 'suspended') {
      return res.status(400).json({ error: 'You cannot suspend your own active admin account.' });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({
          ...(parsed.data.accountStatus !== undefined ? { accountStatus: parsed.data.accountStatus } : {}),
          ...(parsed.data.accountVerified !== undefined ? { accountVerified: parsed.data.accountVerified } : {}),
          ...(parsed.data.emailVerified !== undefined ? { emailVerified: parsed.data.emailVerified } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetId))
        .returning({
          id: users.id,
          email: users.email,
          role: users.role,
          accountStatus: users.accountStatus,
          accountVerified: users.accountVerified,
          emailVerified: users.emailVerified,
        });

      if (!row) {
        throw new Error('NOT_FOUND');
      }

      await tx.insert(adminLogs).values({
        adminId: req.authUser!.id,
        action: 'UPDATE_USER',
        targetType: 'user',
        targetId: String(targetId),
        details: JSON.stringify(parsed.data),
        ipAddress: getClientIp(req),
      });

      return row;
    });

    res.json({ user: updated });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'User not found.' });
    }
    console.error('Admin patch user failed:', err);
    res.status(500).json({ error: 'Unable to update user.' });
  }
});

router.get('/employers', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: employers.id,
        userId: employers.userId,
        companyName: employers.companyName,
        website: employers.website,
        businessDescription: employers.businessDescription,
        verificationStatus: employers.verificationStatus,
        totalFundedCents: employers.totalFundedCents,
        availableCampaignBalanceCents: employers.availableCampaignBalanceCents,
        totalSpentCents: employers.totalSpentCents,
        createdAt: employers.createdAt,
        ownerEmail: users.email,
        ownerName: users.name,
      })
      .from(employers)
      .innerJoin(users, eq(employers.userId, users.id))
      .orderBy(desc(employers.createdAt));

    res.json({ employers: rows });
  } catch (err) {
    console.error('Admin employers list failed:', err);
    res.status(500).json({ error: 'Unable to list employers.' });
  }
});

router.post('/employers/:id/verify', async (req: AuthRequest, res) => {
  try {
    const employerId = Number(req.params.id);
    const status = req.body?.status === 'rejected' ? 'rejected' : 'verified';
    if (!Number.isInteger(employerId) || employerId <= 0) {
      return res.status(400).json({ error: 'Invalid employer ID.' });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(employers)
        .set({
          verificationStatus: status,
          verifiedBy: req.authUser!.id,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(employers.id, employerId))
        .returning();

      if (!row) {
        throw new Error('NOT_FOUND');
      }

      await tx.insert(notifications).values({
        userId: row.userId,
        type: status === 'verified' ? 'reward' : 'warning',
        title: status === 'verified' ? 'Employer Account Verified' : 'Employer Verification Rejected',
        message:
          status === 'verified'
            ? `Your employer profile (${row.companyName}) is verified. You can now fund and publish task campaigns.`
            : `Your employer application (${row.companyName}) was not approved. Review your business details and re-apply.`,
      });

      await tx.insert(adminLogs).values({
        adminId: req.authUser!.id,
        action: `EMPLOYER_${status.toUpperCase()}`,
        targetType: 'employer',
        targetId: String(employerId),
        details: `Set verificationStatus=${status} for ${row.companyName}`,
        ipAddress: getClientIp(req),
      });

      return row;
    });

    res.json({ employer: updated });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Employer not found.' });
    }
    console.error('Admin verify employer failed:', err);
    res.status(500).json({ error: 'Unable to update employer verification.' });
  }
});

const verifyDepositSchema = z.object({
  amountUsd: z.number().min(5).max(50000),
  externalReference: z.string().trim().min(4).max(180),
  providerMethod: z.enum(['paypal', 'usdt', 'vodafone_cash']),
});

router.post('/employers/:id/credit-verified-deposit', async (req: AuthRequest, res) => {
  try {
    const employerId = Number(req.params.id);
    if (!Number.isInteger(employerId) || employerId <= 0) {
      return res.status(400).json({ error: 'Invalid employer ID.' });
    }
    const parsed = verifyDepositSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid deposit verification details.' });
    }

    const amountCents = Math.round(parsed.data.amountUsd * 100);
    const updated = await db.transaction(async (tx) => {
      const empRes = await tx.execute(
        sql`SELECT id, user_id, company_name, total_funded_cents, available_campaign_balance_cents FROM employers WHERE id = ${employerId} FOR UPDATE`
      );
      const emp = empRes.rows[0] as
        | {
            id: number;
            user_id: number;
            company_name: string;
            total_funded_cents: number;
            available_campaign_balance_cents: number;
          }
        | undefined;

      if (!emp) {
        throw new Error('NOT_FOUND');
      }

      const wallet = await ensureWalletTx(tx, Number(emp.user_id));

      await tx.insert(transactions).values({
        walletId: wallet.id,
        userId: Number(emp.user_id),
        type: 'employer_deposit_verified',
        status: 'completed',
        amountCents,
        balanceAfterAvailableCents: wallet.availableCents,
        balanceAfterPendingCents: wallet.pendingCents,
        referenceType: 'employer',
        referenceId: employerId,
        externalReference: parsed.data.externalReference,
        idempotencyKey: `admin_emp_dep_${employerId}_${parsed.data.providerMethod}_${parsed.data.externalReference}`,
        description: `Admin-verified ${parsed.data.providerMethod.toUpperCase()} campaign deposit ($${(amountCents / 100).toFixed(2)}) - Ref: ${parsed.data.externalReference}`,
      });

      const [row] = await tx
        .update(employers)
        .set({
          totalFundedCents: Number(emp.total_funded_cents) + amountCents,
          availableCampaignBalanceCents: Number(emp.available_campaign_balance_cents) + amountCents,
          updatedAt: new Date(),
        })
        .where(eq(employers.id, employerId))
        .returning();

      await tx.insert(notifications).values({
        userId: Number(emp.user_id),
        type: 'wallet',
        title: 'Campaign Deposit Verified',
        message: `Your verified ${parsed.data.providerMethod.toUpperCase()} deposit of $${(amountCents / 100).toFixed(2)} (Ref: ${parsed.data.externalReference}) is now available for task funding.`,
      });

      await tx.insert(adminLogs).values({
        adminId: req.authUser!.id,
        action: 'CREDIT_VERIFIED_EMPLOYER_DEPOSIT',
        targetType: 'employer',
        targetId: String(employerId),
        details: `Verified $${(amountCents / 100).toFixed(2)} via ${parsed.data.providerMethod} (Ref: ${parsed.data.externalReference})`,
        ipAddress: getClientIp(req),
      });

      return row;
    });

    res.json({ employer: updated });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Employer not found.' });
    }
    console.error('Credit verified deposit failed:', err);
    res.status(500).json({ error: 'Unable to credit verified employer deposit.' });
  }
});

router.get('/tasks', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        category: tasks.category,
        rewardCents: tasks.rewardCents,
        maxQuantity: tasks.maxQuantity,
        approvedCount: tasks.approvedCount,
        fundingStatus: tasks.fundingStatus,
        status: tasks.status,
        createdAt: tasks.createdAt,
        companyName: employers.companyName,
      })
      .from(tasks)
      .innerJoin(employers, eq(tasks.employerId, employers.id))
      .orderBy(desc(tasks.createdAt))
      .limit(100);

    res.json({ tasks: rows });
  } catch (err) {
    console.error('Admin tasks list failed:', err);
    res.status(500).json({ error: 'Unable to load tasks.' });
  }
});

router.patch('/tasks/:id/status', async (req: AuthRequest, res) => {
  try {
    const taskId = Number(req.params.id);
    const status = req.body?.status;
    if (!Number.isInteger(taskId) || !['active', 'paused', 'removed'].includes(status)) {
      return res.status(400).json({ error: 'Valid task ID and status (active/paused/removed) required.' });
    }

    const [updated] = await db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    await db.insert(adminLogs).values({
      adminId: req.authUser!.id,
      action: 'SET_TASK_STATUS',
      targetType: 'task',
      targetId: String(taskId),
      details: `Changed task "${updated.title}" status to ${status}`,
      ipAddress: getClientIp(req),
    });

    res.json({ task: updated });
  } catch (err) {
    console.error('Admin task status update failed:', err);
    res.status(500).json({ error: 'Unable to update task status.' });
  }
});

router.get('/submissions', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: taskSubmissions.id,
        taskId: taskSubmissions.taskId,
        userId: taskSubmissions.userId,
        status: taskSubmissions.status,
        textProof: taskSubmissions.textProof,
        screenshotPath: taskSubmissions.screenshotPath,
        rewardCentsSnapshot: taskSubmissions.rewardCentsSnapshot,
        submissionIp: taskSubmissions.submissionIp,
        reviewerNote: taskSubmissions.reviewerNote,
        submittedAt: taskSubmissions.submittedAt,
        reviewedAt: taskSubmissions.reviewedAt,
        workerName: users.name,
        workerEmail: users.email,
        taskTitle: tasks.title,
      })
      .from(taskSubmissions)
      .innerJoin(users, eq(taskSubmissions.userId, users.id))
      .innerJoin(tasks, eq(taskSubmissions.taskId, tasks.id))
      .orderBy(desc(taskSubmissions.submittedAt))
      .limit(100);

    res.json({ submissions: rows });
  } catch (err) {
    console.error('Admin submissions list failed:', err);
    res.status(500).json({ error: 'Unable to load submissions.' });
  }
});

router.post('/submissions/:id/approve', async (req: AuthRequest, res) => {
  try {
    const submissionId = Number(req.params.id);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission ID.' });
    }

    const outcome = await approveSubmissionInTx({
      submissionId,
      reviewerId: req.authUser!.id,
      reviewerNote: typeof req.body?.note === 'string' ? req.body.note : 'Approved by admin review.',
      isAdminOverride: true,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, outcome });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to approve submission.' });
  }
});

router.post('/submissions/:id/reject', async (req: AuthRequest, res) => {
  try {
    const submissionId = Number(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!Number.isInteger(submissionId) || submissionId <= 0 || note.length < 4) {
      return res.status(400).json({ error: 'Valid submission ID and rejection reason (4+ chars) required.' });
    }

    const outcome = await rejectSubmissionInTx({
      submissionId,
      reviewerId: req.authUser!.id,
      reviewerNote: note,
      isAdminOverride: true,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, outcome });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to reject submission.' });
  }
});

router.get('/withdrawals', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: withdrawals.id,
        userId: withdrawals.userId,
        method: withdrawals.method,
        destinationAccount: withdrawals.destinationAccount,
        amountCents: withdrawals.amountCents,
        netAmountCents: withdrawals.netAmountCents,
        status: withdrawals.status,
        providerName: withdrawals.providerName,
        providerReference: withdrawals.providerReference,
        providerError: withdrawals.providerError,
        reviewNote: withdrawals.reviewNote,
        requestedIp: withdrawals.requestedIp,
        createdAt: withdrawals.createdAt,
        processedAt: withdrawals.processedAt,
        workerName: users.name,
        workerEmail: users.email,
      })
      .from(withdrawals)
      .innerJoin(users, eq(withdrawals.userId, users.id))
      .orderBy(desc(withdrawals.createdAt))
      .limit(100);

    res.json({ withdrawals: rows });
  } catch (err) {
    console.error('Admin withdrawals list failed:', err);
    res.status(500).json({ error: 'Unable to load withdrawal requests.' });
  }
});

router.post('/withdrawals/:id/execute-payout', async (req: AuthRequest, res) => {
  try {
    const withdrawalId = Number(req.params.id);
    if (!Number.isInteger(withdrawalId) || withdrawalId <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal ID.' });
    }

    const [wd] = await db
      .select({
        id: withdrawals.id,
        userId: withdrawals.userId,
        walletId: withdrawals.walletId,
        method: withdrawals.method,
        destinationAccount: withdrawals.destinationAccount,
        amountCents: withdrawals.amountCents,
        netAmountCents: withdrawals.netAmountCents,
        status: withdrawals.status,
        workerEmail: users.email,
      })
      .from(withdrawals)
      .innerJoin(users, eq(withdrawals.userId, users.id))
      .where(eq(withdrawals.id, withdrawalId));

    if (!wd) {
      return res.status(404).json({ error: 'Withdrawal request not found.' });
    }
    if (!['pending', 'failed'].includes(wd.status)) {
      return res.status(409).json({ error: `Withdrawal cannot execute from status '${wd.status}'.` });
    }

    // Real provider execution — NEVER simulates payment success!
    const payoutResult = await executeRealProviderPayout({
      withdrawalId: wd.id,
      method: wd.method as 'paypal' | 'usdt' | 'vodafone_cash',
      destinationAccount: wd.destinationAccount,
      netAmountCents: wd.netAmountCents,
      recipientEmail: wd.workerEmail,
    });

    const updated = await db.transaction(async (tx) => {
      const wallet = await lockWalletTx(tx, wd.userId);
      await tx
        .update(wallets)
        .set({
          totalWithdrawnCents: wallet.totalWithdrawnCents + wd.amountCents,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));

      const [row] = await tx
        .update(withdrawals)
        .set({
          status: 'paid',
          providerReference: payoutResult.providerReference,
          providerError: null,
          reviewedBy: req.authUser!.id,
          reviewNote: `Executed via ${payoutResult.providerName} (${payoutResult.rawStatus})`,
          processedAt: new Date(),
        })
        .where(eq(withdrawals.id, wd.id))
        .returning();

      await tx.insert(transactions).values({
        walletId: wallet.id,
        userId: wd.userId,
        type: 'withdrawal_paid',
        status: 'completed',
        amountCents: wd.amountCents,
        balanceAfterAvailableCents: wallet.availableCents,
        balanceAfterPendingCents: wallet.pendingCents,
        referenceType: 'withdrawal',
        referenceId: wd.id,
        externalReference: payoutResult.providerReference,
        idempotencyKey: `wd_paid_${wd.id}`,
        description: `Paid via ${payoutResult.providerName} - Ref: ${payoutResult.providerReference}`,
      });

      await tx.insert(notifications).values({
        userId: wd.userId,
        type: 'wallet',
        title: 'Withdrawal Dispatched',
        message: `Your $${(wd.amountCents / 100).toFixed(2)} ${wd.method.toUpperCase()} payout was sent via ${payoutResult.providerName} (Ref: ${payoutResult.providerReference}).`,
      });

      await tx.insert(adminLogs).values({
        adminId: req.authUser!.id,
        action: 'EXECUTE_PAYOUT',
        targetType: 'withdrawal',
        targetId: String(wd.id),
        details: `Paid $${(wd.amountCents / 100).toFixed(2)} via ${payoutResult.providerName} (${payoutResult.providerReference})`,
        ipAddress: getClientIp(req),
      });

      return row;
    });

    res.json({ withdrawal: updated });
  } catch (err) {
    if (err instanceof PaymentProviderConfigError) {
      return res.status(err.statusCode).json({
        error: err.message,
        provider: err.provider,
        requirements: err.requirements,
      });
    }
    if (err instanceof PaymentProviderExecutionError) {
      await db
        .update(withdrawals)
        .set({
          status: 'failed',
          providerError: err.message,
          reviewedBy: req.authUser!.id,
        })
        .where(eq(withdrawals.id, Number(req.params.id)));
      return res.status(err.statusCode).json({ error: err.message, provider: err.provider });
    }
    console.error('Execute payout failed:', err);
    res.status(500).json({ error: 'Unable to execute payout.' });
  }
});

router.post('/withdrawals/:id/reject', async (req: AuthRequest, res) => {
  try {
    const withdrawalId = Number(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!Number.isInteger(withdrawalId) || withdrawalId <= 0 || reason.length < 4) {
      return res.status(400).json({ error: 'Valid withdrawal ID and rejection reason (4+ chars) required.' });
    }

    const updated = await db.transaction(async (tx) => {
      const wdRes = await tx.execute(
        sql`SELECT id, user_id, amount_cents, status FROM withdrawals WHERE id = ${withdrawalId} FOR UPDATE`
      );
      const wd = wdRes.rows[0] as
        | { id: number; user_id: number; amount_cents: number; status: string }
        | undefined;

      if (!wd) {
        throw new Error('NOT_FOUND');
      }
      if (!['pending', 'failed'].includes(wd.status)) {
        throw new Error('INVALID_STATE');
      }

      const wallet = await lockWalletTx(tx, Number(wd.user_id));
      const nextAvailable = wallet.availableCents + Number(wd.amount_cents);

      await tx
        .update(wallets)
        .set({ availableCents: nextAvailable, updatedAt: new Date() })
        .where(eq(wallets.id, wallet.id));

      const [row] = await tx
        .update(withdrawals)
        .set({
          status: 'rejected',
          reviewedBy: req.authUser!.id,
          reviewNote: reason,
          processedAt: new Date(),
        })
        .where(eq(withdrawals.id, withdrawalId))
        .returning();

      await tx.insert(transactions).values({
        walletId: wallet.id,
        userId: Number(wd.user_id),
        type: 'withdrawal_refund',
        status: 'completed',
        amountCents: Number(wd.amount_cents),
        balanceAfterAvailableCents: nextAvailable,
        balanceAfterPendingCents: wallet.pendingCents,
        referenceType: 'withdrawal',
        referenceId: withdrawalId,
        idempotencyKey: `wd_refund_${withdrawalId}`,
        description: `Refunded rejected withdrawal #${withdrawalId}: ${reason}`,
      });

      await tx.insert(notifications).values({
        userId: Number(wd.user_id),
        type: 'warning',
        title: 'Withdrawal Rejected & Refunded',
        message: `Withdrawal #${withdrawalId} was rejected (${reason}). Funds have been returned to your available balance.`,
      });

      await tx.insert(adminLogs).values({
        adminId: req.authUser!.id,
        action: 'REJECT_WITHDRAWAL',
        targetType: 'withdrawal',
        targetId: String(withdrawalId),
        details: `Rejected & refunded $${(Number(wd.amount_cents) / 100).toFixed(2)}: ${reason}`,
        ipAddress: getClientIp(req),
      });

      return row;
    });

    res.json({ withdrawal: updated });
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Withdrawal not found.' });
      if (err.message === 'INVALID_STATE') {
        return res.status(409).json({ error: 'Only pending or failed withdrawals can be rejected.' });
      }
    }
    console.error('Reject withdrawal failed:', err);
    res.status(500).json({ error: 'Unable to reject withdrawal.' });
  }
});

router.get('/transactions', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: transactions.id,
        userId: transactions.userId,
        type: transactions.type,
        status: transactions.status,
        amountCents: transactions.amountCents,
        balanceAfterAvailableCents: transactions.balanceAfterAvailableCents,
        balanceAfterPendingCents: transactions.balanceAfterPendingCents,
        referenceType: transactions.referenceType,
        referenceId: transactions.referenceId,
        externalReference: transactions.externalReference,
        description: transactions.description,
        createdAt: transactions.createdAt,
        userEmail: users.email,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .orderBy(desc(transactions.createdAt))
      .limit(100);

    res.json({ transactions: rows });
  } catch (err) {
    console.error('Admin transactions failed:', err);
    res.status(500).json({ error: 'Unable to load financial transactions.' });
  }
});

router.get('/logs', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: adminLogs.id,
        adminId: adminLogs.adminId,
        action: adminLogs.action,
        targetType: adminLogs.targetType,
        targetId: adminLogs.targetId,
        details: adminLogs.details,
        ipAddress: adminLogs.ipAddress,
        createdAt: adminLogs.createdAt,
        adminEmail: users.email,
      })
      .from(adminLogs)
      .leftJoin(users, eq(adminLogs.adminId, users.id))
      .orderBy(desc(adminLogs.createdAt))
      .limit(100);

    res.json({ logs: rows });
  } catch (err) {
    console.error('Admin logs failed:', err);
    res.status(500).json({ error: 'Unable to load admin audit logs.' });
  }
});

export default router;
