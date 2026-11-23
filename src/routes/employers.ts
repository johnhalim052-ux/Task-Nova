import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.ts';
import {
  TASK_CATEGORIES,
  employers,
  notifications,
  taskSubmissions,
  tasks,
  transactions,
  users,
} from '../db/schema.ts';
import { type AuthRequest, requireAuth } from '../middleware/auth.ts';
import { getClientIp } from '../lib/security.ts';
import {
  PaymentProviderConfigError,
  PaymentProviderExecutionError,
  capturePayPalEmployerOrder,
  createPayPalEmployerOrder,
} from '../services/payments.ts';
import { approveSubmissionInTx, ensureWalletTx, rejectSubmissionInTx } from '../services/wallet.ts';

const router = Router();

const applyEmployerSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  website: z.string().trim().max(240).default(''),
  businessDescription: z.string().trim().min(10).max(800),
});

const createTaskSchema = z.object({
  title: z.string().trim().min(4).max(120),
  category: z.enum(TASK_CATEGORIES),
  description: z.string().trim().min(15).max(1500),
  instructions: z.string().trim().min(15).max(3000),
  proofRequirements: z.string().trim().min(8).max(1000),
  rewardUsd: z.number().min(0.1).max(250),
  maxQuantity: z.number().int().min(1).max(10000),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).default('Easy'),
  estimatedMinutes: z.number().int().min(1).max(240).default(10),
});

const fundingIntentSchema = z.object({
  method: z.enum(['paypal', 'usdt', 'vodafone_cash']),
  amountUsd: z.number().min(5).max(25000),
  externalReference: z.string().trim().min(4).max(180),
});

router.get('/overview', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.authUser!.id;
    const [employer] = await db.select().from(employers).where(eq(employers.userId, userId));
    if (!employer) {
      return res.json({ employer: null, tasks: [], submissions: [], fundingHistory: [] });
    }

    const employerTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.employerId, employer.id))
      .orderBy(desc(tasks.createdAt));

    const taskIds = employerTasks.map((t) => t.id);
    const submissions =
      taskIds.length > 0
        ? await db
            .select({
              id: taskSubmissions.id,
              taskId: taskSubmissions.taskId,
              userId: taskSubmissions.userId,
              status: taskSubmissions.status,
              textProof: taskSubmissions.textProof,
              screenshotPath: taskSubmissions.screenshotPath,
              rewardCentsSnapshot: taskSubmissions.rewardCentsSnapshot,
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
            .where(inArray(taskSubmissions.taskId, taskIds))
            .orderBy(desc(taskSubmissions.submittedAt))
        : [];

    const fundingHistory = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.type, [
            'employer_deposit_intent',
            'employer_deposit_verified',
            'campaign_allocation',
          ])
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(30);

    res.json({
      employer,
      tasks: employerTasks,
      submissions,
      fundingHistory,
    });
  } catch (err) {
    console.error('Employer overview failed:', err);
    res.status(500).json({ error: 'Unable to load employer dashboard.' });
  }
});

router.post('/apply', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = applyEmployerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid employer application.' });
    }

    const userId = req.authUser!.id;
    const employer = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(employers).where(eq(employers.userId, userId));
      if (existing) {
        const [updated] = await tx
          .update(employers)
          .set({
            companyName: parsed.data.companyName,
            website: parsed.data.website,
            businessDescription: parsed.data.businessDescription,
            verificationStatus: existing.verificationStatus === 'verified' ? 'verified' : 'pending',
            updatedAt: new Date(),
          })
          .where(eq(employers.id, existing.id))
          .returning();
        return updated;
      }

      if (req.authUser!.role === 'worker') {
        await tx.update(users).set({ role: 'employer', updatedAt: new Date() }).where(eq(users.id, userId));
      }

      const [created] = await tx
        .insert(employers)
        .values({
          userId,
          companyName: parsed.data.companyName,
          website: parsed.data.website,
          businessDescription: parsed.data.businessDescription,
          verificationStatus: 'pending',
        })
        .returning();

      await tx.insert(notifications).values({
        userId,
        type: 'info',
        title: 'Employer Application Submitted',
        message: 'An administrator will verify your company profile before campaign publishing is enabled.',
      });

      return created;
    });

    res.status(201).json({ employer });
  } catch (err) {
    console.error('Employer apply failed:', err);
    res.status(500).json({ error: 'Unable to submit employer profile.' });
  }
});

router.post('/funding-intent', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = fundingIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid funding reference.' });
    }

    const userId = req.authUser!.id;
    const amountCents = Math.round(parsed.data.amountUsd * 100);

    const record = await db.transaction(async (tx) => {
      const [employer] = await tx.select().from(employers).where(eq(employers.userId, userId));
      if (!employer) {
        throw new Error('NO_EMPLOYER');
      }
      if (employer.verificationStatus !== 'verified') {
        throw new Error('UNVERIFIED_EMPLOYER');
      }

      const wallet = await ensureWalletTx(tx, userId);
      const [txRow] = await tx
        .insert(transactions)
        .values({
          walletId: wallet.id,
          userId,
          type: 'employer_deposit_intent',
          status: 'pending_verification',
          amountCents,
          balanceAfterAvailableCents: wallet.availableCents,
          balanceAfterPendingCents: wallet.pendingCents,
          referenceType: 'employer',
          referenceId: employer.id,
          externalReference: parsed.data.externalReference,
          idempotencyKey: `emp_intent_${employer.id}_${parsed.data.method}_${parsed.data.externalReference}`,
          description: `Pending ${parsed.data.method.toUpperCase()} deposit verification ($${(amountCents / 100).toFixed(2)}) - Ref: ${parsed.data.externalReference}`,
        })
        .returning();

      return txRow;
    });

    res.status(201).json({
      fundingIntent: record,
      message: 'Payment reference logged for authorized provider/admin settlement verification.',
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message === 'NO_EMPLOYER') return res.status(404).json({ error: 'Employer profile not found.' });
      if (err.message === 'UNVERIFIED_EMPLOYER') {
        return res.status(403).json({ error: 'Employer account must be verified by an admin before funding campaigns.' });
      }
    }
    console.error('Funding intent failed:', err);
    res.status(500).json({ error: 'Unable to log campaign funding reference.' });
  }
});

router.post('/funding-order/paypal', requireAuth, async (req: AuthRequest, res) => {
  try {
    const amountUsd = Number(req.body?.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd < 5 || amountUsd > 25000) {
      return res.status(400).json({ error: 'Provide a funding amount between $5.00 and $25,000.00.' });
    }

    const [employer] = await db.select().from(employers).where(eq(employers.userId, req.authUser!.id));
    if (!employer || employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: 'Verified employer profile required.' });
    }

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const order = await createPayPalEmployerOrder(
      Math.round(amountUsd * 100),
      employer.id,
      `${appUrl}/?paypal_funding=return`,
      `${appUrl}/?paypal_funding=cancel`
    );

    res.json({ order });
  } catch (err) {
    if (err instanceof PaymentProviderConfigError) {
      return res.status(err.statusCode).json({
        error: err.message,
        provider: err.provider,
        requirements: err.requirements,
      });
    }
    if (err instanceof PaymentProviderExecutionError) {
      return res.status(err.statusCode).json({ error: err.message, provider: err.provider });
    }
    console.error('PayPal order init failed:', err);
    res.status(500).json({ error: 'Unable to initialize PayPal checkout order.' });
  }
});

router.post('/funding-order/paypal/capture', requireAuth, async (req: AuthRequest, res) => {
  try {
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
    if (!orderId) {
      return res.status(400).json({ error: 'PayPal orderId is required.' });
    }

    const [employer] = await db.select().from(employers).where(eq(employers.userId, req.authUser!.id));
    if (!employer || employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: 'Verified employer profile required.' });
    }

    const capture = (await capturePayPalEmployerOrder(orderId)) as {
      status?: string;
      purchase_units?: Array<{ payments?: { captures?: Array<{ amount?: { value?: string }; id?: string }> } }>;
    };

    if (capture.status !== 'COMPLETED') {
      return res.status(402).json({ error: `PayPal order status is '${capture.status || 'UNKNOWN'}', not COMPLETED.` });
    }

    const capturedValue = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
    const captureId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId;
    const amountCents = Math.round(Number(capturedValue || 0) * 100);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid captured PayPal amount.' });
    }

    const updatedEmployer = await db.transaction(async (tx) => {
      const empRes = await tx.execute(
        sql`SELECT id, total_funded_cents, available_campaign_balance_cents FROM employers WHERE id = ${employer.id} FOR UPDATE`
      );
      const locked = empRes.rows[0] as {
        id: number;
        total_funded_cents: number;
        available_campaign_balance_cents: number;
      };
      const wallet = await ensureWalletTx(tx, req.authUser!.id);

      await tx.insert(transactions).values({
        walletId: wallet.id,
        userId: req.authUser!.id,
        type: 'employer_deposit_verified',
        status: 'completed',
        amountCents,
        balanceAfterAvailableCents: wallet.availableCents,
        balanceAfterPendingCents: wallet.pendingCents,
        referenceType: 'employer',
        referenceId: employer.id,
        externalReference: captureId,
        idempotencyKey: `paypal_capture_${captureId}`,
        description: `Verified PayPal deposit ($${(amountCents / 100).toFixed(2)}) - Capture ${captureId}`,
      });

      const [updated] = await tx
        .update(employers)
        .set({
          totalFundedCents: Number(locked.total_funded_cents) + amountCents,
          availableCampaignBalanceCents: Number(locked.available_campaign_balance_cents) + amountCents,
          updatedAt: new Date(),
        })
        .where(eq(employers.id, employer.id))
        .returning();

      return updated;
    });

    res.json({ employer: updatedEmployer, captureId });
  } catch (err) {
    if (err instanceof PaymentProviderConfigError || err instanceof PaymentProviderExecutionError) {
      return res.status(err.statusCode).json({ error: err.message, provider: err.provider });
    }
    console.error('PayPal capture failed:', err);
    res.status(500).json({ error: 'Unable to capture PayPal funding order.' });
  }
});

router.post('/tasks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid task definition.' });
    }

    const [employer] = await db.select().from(employers).where(eq(employers.userId, req.authUser!.id));
    if (!employer) {
      return res.status(403).json({ error: 'Create an employer profile before creating tasks.' });
    }
    if (employer.verificationStatus !== 'verified') {
      return res.status(403).json({ error: 'Your employer account must be verified by an admin first.' });
    }

    const rewardCents = Math.round(parsed.data.rewardUsd * 100);
    const [created] = await db
      .insert(tasks)
      .values({
        employerId: employer.id,
        title: parsed.data.title,
        category: parsed.data.category,
        description: parsed.data.description,
        instructions: parsed.data.instructions,
        proofRequirements: parsed.data.proofRequirements,
        rewardCents,
        maxQuantity: parsed.data.maxQuantity,
        difficulty: parsed.data.difficulty,
        estimatedMinutes: parsed.data.estimatedMinutes,
        fundingStatus: 'unfunded',
        status: 'draft',
      })
      .returning();

    res.status(201).json({ task: created });
  } catch (err) {
    console.error('Create task failed:', err);
    res.status(500).json({ error: 'Unable to create task campaign.' });
  }
});

router.post('/tasks/:id/fund', requireAuth, async (req: AuthRequest, res) => {
  try {
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Invalid task ID.' });
    }

    const userId = req.authUser!.id;
    const result = await db.transaction(async (tx) => {
      const [employer] = await tx.select().from(employers).where(eq(employers.userId, userId));
      if (!employer) {
        throw new Error('NO_EMPLOYER');
      }
      if (employer.verificationStatus !== 'verified') {
        throw new Error('UNVERIFIED_EMPLOYER');
      }

      const empRes = await tx.execute(
        sql`SELECT id, available_campaign_balance_cents FROM employers WHERE id = ${employer.id} FOR UPDATE`
      );
      const lockedEmp = empRes.rows[0] as { id: number; available_campaign_balance_cents: number };

      const taskRes = await tx.execute(
        sql`SELECT id, employer_id, title, reward_cents, max_quantity, funded_budget_cents, funding_status FROM tasks WHERE id = ${taskId} FOR UPDATE`
      );
      const lockedTask = taskRes.rows[0] as
        | {
            id: number;
            employer_id: number;
            title: string;
            reward_cents: number;
            max_quantity: number;
            funded_budget_cents: number;
            funding_status: string;
          }
        | undefined;

      if (!lockedTask || Number(lockedTask.employer_id) !== employer.id) {
        throw new Error('TASK_NOT_FOUND');
      }
      if (lockedTask.funding_status === 'funded') {
        throw new Error('ALREADY_FUNDED');
      }

      const requiredCents = Number(lockedTask.reward_cents) * Number(lockedTask.max_quantity);
      if (Number(lockedEmp.available_campaign_balance_cents) < requiredCents) {
        throw new Error('INSUFFICIENT_CAMPAIGN_BALANCE');
      }

      await tx
        .update(employers)
        .set({
          availableCampaignBalanceCents: Number(lockedEmp.available_campaign_balance_cents) - requiredCents,
          updatedAt: new Date(),
        })
        .where(eq(employers.id, employer.id));

      const [updatedTask] = await tx
        .update(tasks)
        .set({
          fundedBudgetCents: requiredCents,
          fundingStatus: 'funded',
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
        .returning();

      const wallet = await ensureWalletTx(tx, userId);
      await tx.insert(transactions).values({
        walletId: wallet.id,
        userId,
        type: 'campaign_allocation',
        status: 'completed',
        amountCents: -requiredCents,
        balanceAfterAvailableCents: wallet.availableCents,
        balanceAfterPendingCents: wallet.pendingCents,
        referenceType: 'task',
        referenceId: taskId,
        idempotencyKey: `fund_task_${taskId}`,
        description: `Allocated $${(requiredCents / 100).toFixed(2)} to publish "${lockedTask.title}"`,
      });

      return updatedTask;
    });

    res.json({ task: result });
  } catch (err: unknown) {
    if (err instanceof Error) {
      const map: Record<string, [number, string]> = {
        NO_EMPLOYER: [404, 'Employer profile not found.'],
        UNVERIFIED_EMPLOYER: [403, 'Employer must be verified before funding campaigns.'],
        TASK_NOT_FOUND: [404, 'Task not found in your campaigns.'],
        ALREADY_FUNDED: [409, 'This task campaign is already funded.'],
        INSUFFICIENT_CAMPAIGN_BALANCE: [
          402,
          'Insufficient verified campaign balance. Fund your employer balance via verified payment before publishing.',
        ],
      };
      if (map[err.message]) {
        const [code, msg] = map[err.message];
        return res.status(code).json({ error: msg });
      }
    }
    console.error('Fund task failed:', err);
    res.status(500).json({ error: 'Unable to fund and publish task.' });
  }
});

router.post('/submissions/:id/approve', requireAuth, async (req: AuthRequest, res) => {
  try {
    const submissionId = Number(req.params.id);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission ID.' });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const outcome = await approveSubmissionInTx({
      submissionId,
      reviewerId: req.authUser!.id,
      reviewerNote: note,
      isAdminOverride: false,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, outcome });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unable to approve submission.';
    const status = msg.startsWith('Forbidden') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post('/submissions/:id/reject', requireAuth, async (req: AuthRequest, res) => {
  try {
    const submissionId = Number(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission ID.' });
    }
    if (note.length < 4) {
      return res.status(400).json({ error: 'Provide a clear rejection reason (at least 4 characters).' });
    }

    const outcome = await rejectSubmissionInTx({
      submissionId,
      reviewerId: req.authUser!.id,
      reviewerNote: note,
      isAdminOverride: false,
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true, outcome });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unable to reject submission.';
    const status = msg.startsWith('Forbidden') ? 403 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

export default router;
