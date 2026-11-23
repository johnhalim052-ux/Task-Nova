import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const TASK_CATEGORIES = [
  'Social media tasks',
  'Website visits',
  'App testing',
  'Surveys',
  'Data entry',
  'Research tasks',
  'Content evaluation',
  'Writing tasks',
] as const;

export const WITHDRAWAL_METHODS = ['paypal', 'usdt', 'vodafone_cash'] as const;

// 1. Users table (supports bcrypt email/password auth + Firebase UID linking + RBAC)
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    uid: text('uid').notNull().unique(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    name: text('name').notNull(),
    role: text('role').notNull().default('worker'), // 'worker' | 'employer' | 'admin'
    bio: text('bio').notNull().default(''),
    country: text('country').notNull().default(''),
    payoutPreference: text('payout_preference').notNull().default('paypal'),
    emailVerified: boolean('email_verified').notNull().default(false),
    accountVerified: boolean('account_verified').notNull().default(false),
    accountStatus: text('account_status').notNull().default('active'), // 'active' | 'suspended' | 'pending_review'
    verificationTokenHash: text('verification_token_hash'),
    verificationExpiresAt: timestamp('verification_expires_at'),
    resetTokenHash: text('reset_token_hash'),
    resetExpiresAt: timestamp('reset_expires_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lastLoginIp: text('last_login_ip'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('users_role_idx').on(table.role),
    index('users_status_idx').on(table.accountStatus),
  ]
);

// 2. Employers table (verified employer profiles & campaign treasury balances)
export const employers = pgTable(
  'employers',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    companyName: text('company_name').notNull(),
    website: text('website').notNull().default(''),
    businessDescription: text('business_description').notNull().default(''),
    verificationStatus: text('verification_status').notNull().default('pending'), // 'pending' | 'verified' | 'rejected'
    verifiedBy: integer('verified_by').references(() => users.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at'),
    totalFundedCents: integer('total_funded_cents').notNull().default(0),
    availableCampaignBalanceCents: integer('available_campaign_balance_cents').notNull().default(0),
    totalSpentCents: integer('total_spent_cents').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('employers_verification_idx').on(table.verificationStatus)]
);

// 3. Tasks table (microtask campaigns created & funded by verified employers)
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    employerId: integer('employer_id')
      .references(() => employers.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    proofRequirements: text('proof_requirements').notNull(),
    rewardCents: integer('reward_cents').notNull(),
    maxQuantity: integer('max_quantity').notNull(),
    acceptedCount: integer('accepted_count').notNull().default(0),
    approvedCount: integer('approved_count').notNull().default(0),
    fundedBudgetCents: integer('funded_budget_cents').notNull().default(0),
    spentBudgetCents: integer('spent_budget_cents').notNull().default(0),
    fundingStatus: text('funding_status').notNull().default('unfunded'), // 'unfunded' | 'funded' | 'exhausted'
    status: text('status').notNull().default('draft'), // 'draft' | 'active' | 'paused' | 'completed' | 'removed'
    difficulty: text('difficulty').notNull().default('Easy'),
    estimatedMinutes: integer('estimated_minutes').notNull().default(10),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('tasks_status_category_idx').on(table.status, table.category),
    index('tasks_employer_idx').on(table.employerId),
  ]
);

// 4. Task Submissions table (unique per task+user to prevent duplicate rewards)
export const taskSubmissions = pgTable(
  'task_submissions',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull().default('accepted'), // 'accepted' | 'submitted' | 'approved' | 'rejected'
    textProof: text('text_proof').notNull().default(''),
    screenshotPath: text('screenshot_path'),
    screenshotMime: text('screenshot_mime'),
    rewardCentsSnapshot: integer('reward_cents_snapshot').notNull(),
    submissionIp: text('submission_ip'),
    reviewerId: integer('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerNote: text('reviewer_note'),
    acceptedAt: timestamp('accepted_at').defaultNow().notNull(),
    submittedAt: timestamp('submitted_at'),
    reviewedAt: timestamp('reviewed_at'),
  },
  (table) => [
    uniqueIndex('task_submissions_task_user_uidx').on(table.taskId, table.userId),
    index('task_submissions_user_status_idx').on(table.userId, table.status),
    index('task_submissions_task_status_idx').on(table.taskId, table.status),
  ]
);

// 5. Wallets table (strict server-side balance ledger)
export const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  availableCents: integer('available_cents').notNull().default(0),
  pendingCents: integer('pending_cents').notNull().default(0),
  totalEarnedCents: integer('total_earned_cents').notNull().default(0),
  totalWithdrawnCents: integer('total_withdrawn_cents').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 6. Transactions table (immutable audit trail & idempotent reward/withdrawal entries)
export const transactions = pgTable(
  'transactions',
  {
    id: serial('id').primaryKey(),
    walletId: integer('wallet_id')
      .references(() => wallets.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').notNull(), // 'task_pending' | 'task_reward' | 'task_rejected' | 'withdrawal_hold' | 'withdrawal_paid' | 'withdrawal_refund' | 'employer_deposit_intent' | 'employer_deposit_verified' | 'campaign_allocation'
    status: text('status').notNull().default('completed'), // 'completed' | 'pending_verification' | 'failed'
    amountCents: integer('amount_cents').notNull(),
    balanceAfterAvailableCents: integer('balance_after_available_cents').notNull(),
    balanceAfterPendingCents: integer('balance_after_pending_cents').notNull(),
    referenceType: text('reference_type').notNull(), // 'submission' | 'withdrawal' | 'task' | 'employer'
    referenceId: integer('reference_id').notNull(),
    idempotencyKey: text('idempotency_key').unique(),
    externalReference: text('external_reference'),
    description: text('description').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('transactions_user_created_idx').on(table.userId, table.createdAt),
    index('transactions_type_status_idx').on(table.type, table.status),
  ]
);

// 7. Withdrawals table (PayPal, USDT, Vodafone Cash provider workflow)
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    walletId: integer('wallet_id')
      .references(() => wallets.id, { onDelete: 'cascade' })
      .notNull(),
    method: text('method').notNull(), // 'paypal' | 'usdt' | 'vodafone_cash'
    destinationAccount: text('destination_account').notNull(),
    amountCents: integer('amount_cents').notNull(),
    feeCents: integer('fee_cents').notNull().default(0),
    netAmountCents: integer('net_amount_cents').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'paid' | 'rejected' | 'failed'
    providerName: text('provider_name').notNull(),
    providerReference: text('provider_reference'),
    providerError: text('provider_error'),
    reviewedBy: integer('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    processedAt: timestamp('processed_at'),
  },
  (table) => [
    index('withdrawals_user_status_idx').on(table.userId, table.status),
    index('withdrawals_status_idx').on(table.status),
  ]
);

// 8. Notifications table
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').notNull().default('info'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('notifications_user_read_idx').on(table.userId, table.isRead)]
);

// 9. Admin Logs table (security & moderation audit trail)
export const adminLogs = pgTable(
  'admin_logs',
  {
    id: serial('id').primaryKey(),
    adminId: integer('admin_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    details: text('details').notNull(),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('admin_logs_created_idx').on(table.createdAt)]
);

// Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  employerProfile: one(employers, {
    fields: [users.id],
    references: [employers.userId],
  }),
  wallet: one(wallets, {
    fields: [users.id],
    references: [wallets.userId],
  }),
  submissions: many(taskSubmissions),
  transactions: many(transactions),
  withdrawals: many(withdrawals),
  notifications: many(notifications),
}));

export const employersRelations = relations(employers, ({ one, many }) => ({
  user: one(users, {
    fields: [employers.userId],
    references: [users.id],
  }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  employer: one(employers, {
    fields: [tasks.employerId],
    references: [employers.id],
  }),
  submissions: many(taskSubmissions),
}));

export const taskSubmissionsRelations = relations(taskSubmissions, ({ one }) => ({
  task: one(tasks, {
    fields: [taskSubmissions.taskId],
    references: [tasks.id],
  }),
  worker: one(users, {
    fields: [taskSubmissions.userId],
    references: [users.id],
  }),
}));

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  user: one(users, {
    fields: [wallets.userId],
    references: [users.id],
  }),
  transactions: many(transactions),
  withdrawals: many(withdrawals),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  wallet: one(wallets, {
    fields: [transactions.walletId],
    references: [wallets.id],
  }),
  user: one(users, {
    fields: [transactions.userId],
    references: [users.id],
  }),
}));

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
  user: one(users, {
    fields: [withdrawals.userId],
    references: [users.id],
  }),
  wallet: one(wallets, {
    fields: [withdrawals.walletId],
    references: [wallets.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));
