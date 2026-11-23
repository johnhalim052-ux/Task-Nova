import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  adminLogs,
  employers,
  notifications,
  taskSubmissions,
  tasks,
  transactions,
  wallets,
  withdrawals,
} from '../db/schema.ts';

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function ensureWalletTx(tx: DbTx, userId: number) {
  await tx
    .insert(wallets)
    .values({ userId })
    .onConflictDoNothing({ target: wallets.userId });

  const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId));
  if (!wallet) {
    throw new Error('Failed to initialize wallet.');
  }
  return wallet;
}

export async function lockWalletTx(tx: DbTx, userId: number) {
  await ensureWalletTx(tx, userId);
  const result = await tx.execute(
    sql`SELECT id, user_id, available_cents, pending_cents, total_earned_cents, total_withdrawn_cents FROM wallets WHERE user_id = ${userId} FOR UPDATE`
  );
  const row = result.rows[0] as
    | {
        id: number;
        user_id: number;
        available_cents: number;
        pending_cents: number;
        total_earned_cents: number;
        total_withdrawn_cents: number;
      }
    | undefined;
  if (!row) {
    throw new Error('Wallet record not found.');
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    availableCents: Number(row.available_cents),
    pendingCents: Number(row.pending_cents),
    totalEarnedCents: Number(row.total_earned_cents),
    totalWithdrawnCents: Number(row.total_withdrawn_cents),
  };
}

export async function approveSubmissionInTx(params: {
  submissionId: number;
  reviewerId: number;
  reviewerNote?: string;
  isAdminOverride?: boolean;
  ipAddress: string;
}) {
  return db.transaction(async (tx) => {
    const subRes = await tx.execute(
      sql`SELECT id, task_id, user_id, status, reward_cents_snapshot FROM task_submissions WHERE id = ${params.submissionId} FOR UPDATE`
    );
    const submission = subRes.rows[0] as
      | {
          id: number;
          task_id: number;
          user_id: number;
          status: string;
          reward_cents_snapshot: number;
        }
      | undefined;

    if (!submission) {
      throw new Error('Submission not found.');
    }
    if (submission.status !== 'submitted') {
      throw new Error(`Submission cannot be approved from status '${submission.status}'.`);
    }

    const taskRes = await tx.execute(
      sql`SELECT id, employer_id, title, reward_cents, max_quantity, approved_count, funded_budget_cents, spent_budget_cents, status FROM tasks WHERE id = ${Number(submission.task_id)} FOR UPDATE`
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
          status: string;
        }
      | undefined;

    if (!task) {
      throw new Error('Parent task not found.');
    }

    const [employer] = await tx
      .select()
      .from(employers)
      .where(eq(employers.id, Number(task.employer_id)));

    if (!employer) {
      throw new Error('Employer profile not found.');
    }

    if (!params.isAdminOverride && employer.userId !== params.reviewerId) {
      throw new Error('Forbidden: You do not own this task campaign.');
    }

    const rewardCents = Number(submission.reward_cents_snapshot);
    const currentApproved = Number(task.approved_count);
    const maxQty = Number(task.max_quantity);
    const spentBudget = Number(task.spent_budget_cents);
    const fundedBudget = Number(task.funded_budget_cents);

    if (currentApproved >= maxQty) {
      throw new Error('Task campaign has already reached its maximum approved quantity.');
    }
    if (spentBudget + rewardCents > fundedBudget) {
      throw new Error('Insufficient funded campaign budget to approve this submission.');
    }

    const wallet = await lockWalletTx(tx, Number(submission.user_id));
    const newPending = Math.max(0, wallet.pendingCents - rewardCents);
    const newAvailable = wallet.availableCents + rewardCents;
    const newTotalEarned = wallet.totalEarnedCents + rewardCents;

    await tx
      .update(wallets)
      .set({
        availableCents: newAvailable,
        pendingCents: newPending,
        totalEarnedCents: newTotalEarned,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx
      .update(taskSubmissions)
      .set({
        status: 'approved',
        reviewerId: params.reviewerId,
        reviewerNote: params.reviewerNote?.trim() || 'Proof verified and reward released.',
        reviewedAt: new Date(),
      })
      .where(and(eq(taskSubmissions.id, Number(submission.id)), eq(taskSubmissions.status, 'submitted')));

    const nextApproved = currentApproved + 1;
    const nextSpent = spentBudget + rewardCents;
    const isExhausted = nextApproved >= maxQty || nextSpent + Number(task.reward_cents) > fundedBudget;

    await tx
      .update(tasks)
      .set({
        approvedCount: nextApproved,
        spentBudgetCents: nextSpent,
        fundingStatus: isExhausted ? 'exhausted' : 'funded',
        status: isExhausted ? 'completed' : task.status,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, Number(task.id)));

    await tx
      .update(employers)
      .set({
        totalSpentCents: employer.totalSpentCents + rewardCents,
        updatedAt: new Date(),
      })
      .where(eq(employers.id, employer.id));

    await tx.insert(transactions).values({
      walletId: wallet.id,
      userId: Number(submission.user_id),
      type: 'task_reward',
      status: 'completed',
      amountCents: rewardCents,
      balanceAfterAvailableCents: newAvailable,
      balanceAfterPendingCents: newPending,
      referenceType: 'submission',
      referenceId: Number(submission.id),
      idempotencyKey: `reward_sub_${submission.id}`,
      description: `Approved task reward: ${task.title}`,
    });

    await tx.insert(notifications).values({
      userId: Number(submission.user_id),
      type: 'reward',
      title: 'Task Proof Approved',
      message: `Your proof for "${task.title}" was approved. $${(rewardCents / 100).toFixed(2)} added to your available balance.`,
    });

    if (params.isAdminOverride) {
      await tx.insert(adminLogs).values({
        adminId: params.reviewerId,
        action: 'APPROVE_SUBMISSION_REWARD',
        targetType: 'submission',
        targetId: String(submission.id),
        details: `Approved submission #${submission.id} for $${(rewardCents / 100).toFixed(2)}`,
        ipAddress: params.ipAddress,
      });
    }

    return {
      submissionId: Number(submission.id),
      rewardCents,
      availableCents: newAvailable,
    };
  });
}

export async function rejectSubmissionInTx(params: {
  submissionId: number;
  reviewerId: number;
  reviewerNote: string;
  isAdminOverride?: boolean;
  ipAddress: string;
}) {
  return db.transaction(async (tx) => {
    const subRes = await tx.execute(
      sql`SELECT id, task_id, user_id, status, reward_cents_snapshot FROM task_submissions WHERE id = ${params.submissionId} FOR UPDATE`
    );
    const submission = subRes.rows[0] as
      | {
          id: number;
          task_id: number;
          user_id: number;
          status: string;
          reward_cents_snapshot: number;
        }
      | undefined;

    if (!submission) {
      throw new Error('Submission not found.');
    }
    if (submission.status !== 'submitted') {
      throw new Error(`Submission cannot be rejected from status '${submission.status}'.`);
    }

    const [task] = await tx.select().from(tasks).where(eq(tasks.id, Number(submission.task_id)));
    if (!task) {
      throw new Error('Task not found.');
    }

    const [employer] = await tx.select().from(employers).where(eq(employers.id, task.employerId));
    if (!params.isAdminOverride && (!employer || employer.userId !== params.reviewerId)) {
      throw new Error('Forbidden: You do not own this task campaign.');
    }

    const rewardCents = Number(submission.reward_cents_snapshot);
    const wallet = await lockWalletTx(tx, Number(submission.user_id));
    const newPending = Math.max(0, wallet.pendingCents - rewardCents);

    await tx
      .update(wallets)
      .set({
        pendingCents: newPending,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx
      .update(taskSubmissions)
      .set({
        status: 'rejected',
        reviewerId: params.reviewerId,
        reviewerNote: params.reviewerNote.trim(),
        reviewedAt: new Date(),
      })
      .where(and(eq(taskSubmissions.id, Number(submission.id)), eq(taskSubmissions.status, 'submitted')));

    await tx.insert(transactions).values({
      walletId: wallet.id,
      userId: Number(submission.user_id),
      type: 'task_rejected',
      status: 'completed',
      amountCents: 0,
      balanceAfterAvailableCents: wallet.availableCents,
      balanceAfterPendingCents: newPending,
      referenceType: 'submission',
      referenceId: Number(submission.id),
      idempotencyKey: `reject_sub_${submission.id}`,
      description: `Proof rejected for "${task.title}": ${params.reviewerNote.trim()}`,
    });

    await tx.insert(notifications).values({
      userId: Number(submission.user_id),
      type: 'warning',
      title: 'Task Proof Rejected',
      message: `Your proof for "${task.title}" was rejected. Reason: ${params.reviewerNote.trim()}`,
    });

    if (params.isAdminOverride) {
      await tx.insert(adminLogs).values({
        adminId: params.reviewerId,
        action: 'REJECT_SUBMISSION',
        targetType: 'submission',
        targetId: String(submission.id),
        details: `Rejected submission #${submission.id}: ${params.reviewerNote.trim()}`,
        ipAddress: params.ipAddress,
      });
    }

    return { submissionId: Number(submission.id), status: 'rejected' };
  });
}

export async function createWithdrawalRequestInTx(params: {
  userId: number;
  method: 'paypal' | 'usdt' | 'vodafone_cash';
  destinationAccount: string;
  amountCents: number;
  ipAddress: string;
}) {
  return db.transaction(async (tx) => {
    const wallet = await lockWalletTx(tx, params.userId);
    if (wallet.availableCents < params.amountCents) {
      throw new Error('Insufficient available balance for this withdrawal request.');
    }

    const newAvailable = wallet.availableCents - params.amountCents;
    await tx
      .update(wallets)
      .set({
        availableCents: newAvailable,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    const providerMap = {
      paypal: 'PayPal Payouts API',
      usdt: `USDT Treasury (${process.env.USDT_NETWORK || 'TRC20'})`,
      vodafone_cash: 'Vodafone Cash PSP',
    } as const;

    const [created] = await tx
      .insert(withdrawals)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        method: params.method,
        destinationAccount: params.destinationAccount.trim(),
        amountCents: params.amountCents,
        feeCents: 0,
        netAmountCents: params.amountCents,
        status: 'pending',
        providerName: providerMap[params.method],
        requestedIp: params.ipAddress,
      })
      .returning();

    await tx.insert(transactions).values({
      walletId: wallet.id,
      userId: params.userId,
      type: 'withdrawal_hold',
      status: 'completed',
      amountCents: -params.amountCents,
      balanceAfterAvailableCents: newAvailable,
      balanceAfterPendingCents: wallet.pendingCents,
      referenceType: 'withdrawal',
      referenceId: created.id,
      idempotencyKey: `wd_hold_${created.id}`,
      description: `Withdrawal hold #${created.id} via ${providerMap[params.method]}`,
    });

    await tx.insert(notifications).values({
      userId: params.userId,
      type: 'wallet',
      title: 'Withdrawal Request Submitted',
      message: `Your $${(params.amountCents / 100).toFixed(2)} ${params.method.toUpperCase()} withdrawal (#${created.id}) is queued for provider & admin verification.`,
    });

    return created;
  });
}
