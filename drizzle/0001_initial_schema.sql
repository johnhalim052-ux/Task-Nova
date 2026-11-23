-- TaskNova Initial PostgreSQL Schema Migration
-- Tables: users, employers, tasks, task_submissions, wallets, transactions, withdrawals, notifications, admin_logs

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  bio TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  payout_preference TEXT NOT NULL DEFAULT 'paypal',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  account_verified BOOLEAN NOT NULL DEFAULT FALSE,
  account_status TEXT NOT NULL DEFAULT 'active',
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMP,
  reset_token_hash TEXT,
  reset_expires_at TIMESTAMP,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  last_login_ip TEXT,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
CREATE INDEX IF NOT EXISTS users_status_idx ON users(account_status);

CREATE TABLE IF NOT EXISTS employers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  business_description TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMP,
  total_funded_cents INTEGER NOT NULL DEFAULT 0,
  available_campaign_balance_cents INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS employers_verification_idx ON employers(verification_status);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  proof_requirements TEXT NOT NULL,
  reward_cents INTEGER NOT NULL,
  max_quantity INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  approved_count INTEGER NOT NULL DEFAULT 0,
  funded_budget_cents INTEGER NOT NULL DEFAULT 0,
  spent_budget_cents INTEGER NOT NULL DEFAULT 0,
  funding_status TEXT NOT NULL DEFAULT 'unfunded',
  status TEXT NOT NULL DEFAULT 'draft',
  difficulty TEXT NOT NULL DEFAULT 'Easy',
  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_status_category_idx ON tasks(status, category);
CREATE INDEX IF NOT EXISTS tasks_employer_idx ON tasks(employer_id);

CREATE TABLE IF NOT EXISTS task_submissions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted',
  text_proof TEXT NOT NULL DEFAULT '',
  screenshot_path TEXT,
  screenshot_mime TEXT,
  reward_cents_snapshot INTEGER NOT NULL,
  submission_ip TEXT,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_note TEXT,
  accepted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMP,
  reviewed_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS task_submissions_task_user_uidx ON task_submissions(task_id, user_id);
CREATE INDEX IF NOT EXISTS task_submissions_user_status_idx ON task_submissions(user_id, status);
CREATE INDEX IF NOT EXISTS task_submissions_task_status_idx ON task_submissions(task_id, status);

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  available_cents INTEGER NOT NULL DEFAULT 0,
  pending_cents INTEGER NOT NULL DEFAULT 0,
  total_earned_cents INTEGER NOT NULL DEFAULT 0,
  total_withdrawn_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  amount_cents INTEGER NOT NULL,
  balance_after_available_cents INTEGER NOT NULL,
  balance_after_pending_cents INTEGER NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  external_reference TEXT,
  description TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS transactions_type_status_idx ON transactions(type, status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  destination_account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_name TEXT NOT NULL,
  provider_reference TEXT,
  provider_error TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  requested_ip TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS withdrawals_user_status_idx ON withdrawals(user_id, status);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals(status);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL,
  ip_address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_logs_created_idx ON admin_logs(created_at);
