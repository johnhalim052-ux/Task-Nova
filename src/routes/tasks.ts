import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
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
  wallets,
} from '../db/schema.ts';
import { type AuthRequest, requireAuth } from '../middleware/auth.ts';
import { UPLOAD_ROOT, getClientIp, resolveSafeUploadPath } from '../lib/security.ts';
import { lockWalletTx } from '../services/wallet.ts';

const router = Router();

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const allowedMimeToExt: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, UPLOAD_ROOT);
    },
    filename(_req, file, cb) {
      const ext = allowedMimeToExt[file.mimetype];
      if (!ext) {
        return cb(new Error('Unsupported screenshot format. Use PNG, JPEG, or WEBP.'), '');
      }
      cb(null, `proof_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    if (!allowedMimeToExt[file.mimetype]) {
      return cb(new Error('Only PNG, JPEG, or WEBP screenshots are allowed.'));
    }
    cb(null, true);
  },
});

const submitProofLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Submission rate limit reached. Please wait before submitting more proofs.' },
});

const submitProofSchema = z.object({
  textProof: z.string().trim().min(10, 'Provide detailed text proof (at least 10 characters).').max(2500),
});

router.get('/categories', (_req, res) => {
  res.json({ categories: TASK_CATEGORIES });
});

router.get('/', async (req, res) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const difficulty = typeof req.query.difficulty === 'string' ? req.query.difficulty.trim() : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'newest';

    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        category: tasks.category,
        description: tasks.description,
        instructions: tasks.instructions,
        proofRequirements: tasks.proofRequirements,
        rewardCents: tasks.rewardCents,
        maxQuantity: tasks.maxQuantity,
        acceptedCount: tasks.acceptedCount,
        approvedCount: tasks.approvedCount,
        fundedBudgetCents: tasks.fundedBudgetCents,
        spentBudgetCents: tasks.spentBudgetCents,
        fundingStatus: tasks.fundingStatus,
        status: tasks.status,
        difficulty: tasks.difficulty,
        estimatedMinutes: tasks.estimatedMinutes,
        createdAt: tasks.createdAt,
        employerCompany: employers.companyName,
        employerVerified: employers.verificationStatus,
      })
      .from(tasks)
      .innerJoin(employers, eq(tasks.employerId, employers.id))
      .where(and(eq(tasks.status, 'active'), eq(tasks.fundingStatus, 'funded')))
      .orderBy(sort === 'reward_desc' ? desc(tasks.rewardCents) : sort === 'reward_asc' ? asc(tasks.rewardCents) : desc(tasks.createdAt));

    const filtered = rows.filter((t) => {
      if (t.approvedCount >= t.maxQuantity) return false;
      if (category && t.category !== category) return false;
      if (difficulty && t.difficulty !== difficulty) return false;
      if (q) {
        const hay = `${t.title} ${t.description} ${t.category} ${t.employerCompany}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    res.json({ tasks: filtered });
  } catch (err) {
    console.error('Task marketplace list failed:', err);
    res.status(500).json({ error: 'Unable to load available tasks.' });
  }
});

router.get('/my-submissions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const rows = await db
      .select({
        id: taskSubmissions.id,
        taskId: taskSubmissions.taskId,
        status: taskSubmissions.status,
        textProof: taskSubmissions.textProof,
        screenshotPath: taskSubmissions.screenshotPath,
        rewardCentsSnapshot: taskSubmissions.rewardCentsSnapshot,
        reviewerNote: taskSubmissions.reviewerNote,
        acceptedAt: taskSubmissions.acceptedAt,
        submittedAt: taskSubmissions.submittedAt,
        reviewedAt: taskSubmissions.reviewedAt,
        taskTitle: tasks.title,
        taskCategory: tasks.category,
        taskInstructions: tasks.instructions,
        taskProofRequirements: tasks.proofRequirements,
        employerCompany: employers.companyName,
      })
      .from(taskSubmissions)
      .innerJoin(tasks, eq(taskSubmissions.taskId, tasks.id))
      .innerJoin(employers, eq(tasks.employerId, employers.id))
      .where(eq(taskSubmissions.userId, req.authUser!.id))
      .orderBy(desc(taskSubmissions.acceptedAt));

    res.json({ submissions: rows });
  } catch (err) {
    console.error('Load worker submissions failed:', err);
    res.status(500).json({ error: 'Unable to load your task submissions.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Invalid task ID.' });
    }

    const [task] = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        category: tasks.category,
        description: tasks.description,
        instructions: tasks.instructions,
        proofRequirements: tasks.proofRequirements,
        rewardCents: tasks.rewardCents,
        maxQuantity: tasks.maxQuantity,
        acceptedCount: tasks.acceptedCount,
        approvedCount: tasks.approvedCount,
        fundingStatus: tasks.fundingStatus,
        status: tasks.status,
        difficulty: tasks.difficulty,
        estimatedMinutes: tasks.estimatedMinutes,
        createdAt: tasks.createdAt,
        employerCompany: employers.companyName,
        employerVerified: employers.verificationStatus,
      })
      .from(tasks)
      .innerJoin(employers, eq(tasks.employerId, employers.id))
      .where(eq(tasks.id, taskId));

    if (!task) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    res.json({ task });
  } catch (err) {
    console.error('Task detail failed:', err);
    res.status(500).json({ error: 'Unable to load task details.' });
  }
});

router.post('/:id/accept', requireAuth, async (req: AuthRequest, res) => {
  try {
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Invalid task ID.' });
    }

    const userId = req.authUser!.id;
    const created = await db.transaction(async (tx) => {
      const taskRes = await tx.execute(
        sql`SELECT id, employer_id, title, reward_cents, max_quantity, approved_count, funded_budget_cents, spent_budget_cents, funding_status, status FROM tasks WHERE id = ${taskId} FOR UPDATE`
      );
      const task = taskRes.rows[0] as
        | {
            id: number;
            employer_id: number;
            title: string;
            reward_cents: number;
            max_quantity: number;
            approved_count: number;
            funded_budget_cents: number;
            spent_budget_cents: number;
            funding_status: string;
            status: string;
          }
        | undefined;

      if (!task) {
        throw new Error('NOT_FOUND');
      }
      if (task.status !== 'active' || task.funding_status !== 'funded') {
        throw new Error('NOT_ACTIVE');
      }
      if (Number(task.approved_count) >= Number(task.max_quantity)) {
        throw new Error('FULL');
      }
      if (Number(task.spent_budget_cents) + Number(task.reward_cents) > Number(task.funded_budget_cents)) {
        throw new Error('BUDGET_EXHAUSTED');
      }

      const [employer] = await tx.select().from(employers).where(eq(employers.id, Number(task.employer_id)));
      if (employer && employer.userId === userId) {
        throw new Error('SELF_TASK');
      }

      const [existing] = await tx
        .select()
        .from(taskSubmissions)
        .where(and(eq(taskSubmissions.taskId, taskId), eq(taskSubmissions.userId, userId)));

      if (existing) {
        throw new Error('DUPLICATE');
      }

      const [submission] = await tx
        .insert(taskSubmissions)
        .values({
          taskId,
          userId,
          status: 'accepted',
          rewardCentsSnapshot: Number(task.reward_cents),
          submissionIp: getClientIp(req),
        })
        .returning();

      await tx
        .update(tasks)
        .set({
          acceptedCount: sql`${tasks.acceptedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      return submission;
    });

    res.status(201).json({ submission: created });
  } catch (err: unknown) {
    if (err instanceof Error) {
      const map: Record<string, [number, string]> = {
        NOT_FOUND: [404, 'Task not found.'],
        NOT_ACTIVE: [400, 'This task campaign is not active or funded.'],
        FULL: [409, 'This task has reached its maximum completions.'],
        BUDGET_EXHAUSTED: [409, 'This task campaign budget is exhausted.'],
        SELF_TASK: [403, 'Employers cannot accept their own tasks.'],
        DUPLICATE: [409, 'You have already accepted or submitted this task.'],
      };
      if (map[err.message]) {
        const [code, msg] = map[err.message];
        return res.status(code).json({ error: msg });
      }
    }
    console.error('Accept task failed:', err);
    res.status(500).json({ error: 'Unable to accept task.' });
  }
});

router.post(
  '/submissions/:submissionId/submit',
  requireAuth,
  submitProofLimiter,
  (req, res, next) => {
    upload.single('screenshot')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Invalid screenshot upload.' });
      }
      next();
    });
  },
  async (req: AuthRequest, res) => {
    try {
      const submissionId = Number(req.params.submissionId);
      if (!Number.isInteger(submissionId) || submissionId <= 0) {
        return res.status(400).json({ error: 'Invalid submission ID.' });
      }

      const parsed = submitProofSchema.safeParse(req.body);
      if (!parsed.success) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid proof payload.' });
      }

      const userId = req.authUser!.id;
      const screenshotFilename = req.file ? path.basename(req.file.path) : null;
      const screenshotMime = req.file ? req.file.mimetype : null;

      const updated = await db.transaction(async (tx) => {
        const subRes = await tx.execute(
          sql`SELECT id, task_id, user_id, status, reward_cents_snapshot FROM task_submissions WHERE id = ${submissionId} FOR UPDATE`
        );
        const sub = subRes.rows[0] as
          | {
              id: number;
              task_id: number;
              user_id: number;
              status: string;
              reward_cents_snapshot: number;
            }
          | undefined;

        if (!sub) {
          throw new Error('NOT_FOUND');
        }
        if (Number(sub.user_id) !== userId) {
          throw new Error('FORBIDDEN');
        }
        if (sub.status !== 'accepted') {
          throw new Error('ALREADY_SUBMITTED');
        }

        const [task] = await tx.select().from(tasks).where(eq(tasks.id, Number(sub.task_id)));
        if (!task) {
          throw new Error('NOT_FOUND');
        }

        const wallet = await lockWalletTx(tx, userId);
        const reward = Number(sub.reward_cents_snapshot);
        const nextPending = wallet.pendingCents + reward;

        await tx
          .update(wallets)
          .set({ pendingCents: nextPending, updatedAt: new Date() })
          .where(eq(wallets.id, wallet.id));

        const [row] = await tx
          .update(taskSubmissions)
          .set({
            status: 'submitted',
            textProof: parsed.data.textProof,
            screenshotPath: screenshotFilename,
            screenshotMime,
            submissionIp: getClientIp(req),
            submittedAt: new Date(),
          })
          .where(eq(taskSubmissions.id, submissionId))
          .returning();

        await tx.insert(transactions).values({
          walletId: wallet.id,
          userId,
          type: 'task_pending',
          status: 'completed',
          amountCents: reward,
          balanceAfterAvailableCents: wallet.availableCents,
          balanceAfterPendingCents: nextPending,
          referenceType: 'submission',
          referenceId: submissionId,
          idempotencyKey: `pending_sub_${submissionId}`,
          description: `Pending review reward: ${task.title}`,
        });

        const [employer] = await tx.select().from(employers).where(eq(employers.id, task.employerId));
        if (employer) {
          await tx.insert(notifications).values({
            userId: employer.userId,
            type: 'submission',
            title: 'New Proof Submitted',
            message: `${req.authUser!.name} submitted proof for "${task.title}".`,
          });
        }

        return row;
      });

      res.json({ submission: updated });
    } catch (err: unknown) {
      if (req.file) fs.unlink(req.file.path, () => {});
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Submission not found.' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'Forbidden.' });
        if (err.message === 'ALREADY_SUBMITTED') {
          return res.status(409).json({ error: 'Proof has already been submitted for this task.' });
        }
      }
      console.error('Submit proof failed:', err);
      res.status(500).json({ error: 'Unable to submit task proof.' });
    }
  }
);

router.get('/uploads/:filename', requireAuth, async (req: AuthRequest, res) => {
  try {
    const filename = String(req.params.filename || '');
    const safePath = resolveSafeUploadPath(filename);
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).json({ error: 'Screenshot not found.' });
    }

    const [sub] = await db
      .select({
        workerId: taskSubmissions.userId,
        employerUserId: employers.userId,
      })
      .from(taskSubmissions)
      .innerJoin(tasks, eq(taskSubmissions.taskId, tasks.id))
      .innerJoin(employers, eq(tasks.employerId, employers.id))
      .where(eq(taskSubmissions.screenshotPath, filename));

    const requester = req.authUser!;
    if (!sub || (requester.role !== 'admin' && requester.id !== sub.workerId && requester.id !== sub.employerUserId)) {
      return res.status(403).json({ error: 'Forbidden: You cannot view this proof attachment.' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(safePath);
  } catch (err) {
    console.error('Screenshot retrieval failed:', err);
    res.status(500).json({ error: 'Unable to serve proof attachment.' });
  }
});

// Unused import prevention for users table if needed later
void users;

export default router;
