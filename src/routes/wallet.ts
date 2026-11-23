import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { transactions, wallets, withdrawals } from '../db/schema.ts';
import { type AuthRequest, requireAuth } from '../middleware/auth.ts';
import { getClientIp, maskDestinationAccount } from '../lib/security.ts';
import { getPaymentProvidersStatus, validateWithdrawalDestination } from '../services/payments.ts';
import { createWithdrawalRequestInTx } from '../services/wallet.ts';

const router = Router();

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many withdrawal requests. Please wait 15 minutes.' },
});

const withdrawSchema = z.object({
  method: z.enum(['paypal', 'usdt', 'vodafone_cash']),
  destinationAccount: z.string().trim().min(5).max(160),
  amountUsd: z.number().min(5, 'Minimum withdrawal amount is $5.00 USD.').max(10000),
});

router.get('/providers', (_req, res) => {
  res.json({ providers: getPaymentProvidersStatus() });
});

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.authUser!.id;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const txRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(50);

    const wdRows = await db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.userId, userId))
      .orderBy(desc(withdrawals.createdAt))
      .limit(30);

    res.json({
      wallet: wallet || {
        availableCents: 0,
        pendingCents: 0,
        totalEarnedCents: 0,
        totalWithdrawnCents: 0,
      },
      transactions: txRows,
      withdrawals: wdRows.map((w) => ({
        ...w,
        destinationAccount: maskDestinationAccount(w.method, w.destinationAccount),
      })),
      providers: getPaymentProvidersStatus(),
    });
  } catch (err) {
    console.error('Wallet overview failed:', err);
    res.status(500).json({ error: 'Unable to load wallet ledger.' });
  }
});

router.post('/withdraw', requireAuth, withdrawLimiter, async (req: AuthRequest, res) => {
  try {
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid withdrawal request.' });
    }

    if (!req.authUser!.emailVerified) {
      return res.status(403).json({ error: 'Verify your email address before requesting a withdrawal.' });
    }

    const destError = validateWithdrawalDestination(parsed.data.method, parsed.data.destinationAccount);
    if (destError) {
      return res.status(400).json({ error: destError });
    }

    const amountCents = Math.round(parsed.data.amountUsd * 100);
    const created = await createWithdrawalRequestInTx({
      userId: req.authUser!.id,
      method: parsed.data.method,
      destinationAccount: parsed.data.destinationAccount,
      amountCents,
      ipAddress: getClientIp(req),
    });

    res.status(201).json({
      withdrawal: {
        ...created,
        destinationAccount: maskDestinationAccount(created.method, created.destinationAccount),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unable to submit withdrawal request.';
    res.status(msg.includes('Insufficient') ? 400 : 500).json({ error: msg });
  }
});

export default router;
