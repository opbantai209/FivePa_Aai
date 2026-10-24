-- PostgreSQL Schema Migration for WorkPerHour Store & Ledger
-- Run via migration runner or psql

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(128),
  email VARCHAR(255) UNIQUE NOT NULL,
  mobile VARCHAR(64),
  role VARCHAR(64) NOT NULL,
  avatar TEXT,
  title VARCHAR(255),
  rating NUMERIC(3,2) DEFAULT 5.0,
  reviews_count INT DEFAULT 0,
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  earned NUMERIC(12,2) DEFAULT 0,
  completed_jobs INT DEFAULT 0,
  bio TEXT,
  skills TEXT[],
  status VARCHAR(32) DEFAULT 'active',
  verified BOOLEAN DEFAULT FALSE,
  email_verified BOOLEAN DEFAULT FALSE,
  mobile_verified BOOLEAN DEFAULT FALSE,
  wallet_balance NUMERIC(12,2) DEFAULT 0,
  created_at VARCHAR(32),
  is_flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,
  password TEXT,
  session_version INT DEFAULT 1,
  known_devices TEXT[],
  is_available_now BOOLEAN DEFAULT FALSE,
  notification_preferences JSONB
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB;

CREATE TABLE IF NOT EXISTS gigs (
  id VARCHAR(64) PRIMARY KEY,
  freelancer_id VARCHAR(64) NOT NULL,
  freelancer_name VARCHAR(255) NOT NULL,
  freelancer_username VARCHAR(128),
  freelancer_avatar TEXT,
  freelancer_level VARCHAR(64),
  title TEXT NOT NULL,
  slug VARCHAR(255),
  category VARCHAR(128) NOT NULL,
  subcategory VARCHAR(128),
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  delivery_days INT NOT NULL,
  rating NUMERIC(3,2) DEFAULT 5.0,
  reviews_count INT DEFAULT 0,
  image TEXT,
  cover_image TEXT,
  gallery TEXT[],
  tags TEXT[],
  status VARCHAR(32) DEFAULT 'published',
  featured BOOLEAN DEFAULT FALSE,
  featured_until TIMESTAMPTZ,
  extras JSONB DEFAULT '[]'::jsonb,
  moderation_status VARCHAR(32) DEFAULT 'approved',
  moderation_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) PRIMARY KEY,
  buyer_id VARCHAR(64) NOT NULL,
  buyer_name VARCHAR(255) NOT NULL,
  buyer_avatar TEXT,
  title TEXT NOT NULL,
  slug VARCHAR(255),
  category VARCHAR(128) NOT NULL,
  subcategory VARCHAR(128),
  description TEXT,
  budget_min NUMERIC(12,2) DEFAULT 0,
  budget_max NUMERIC(12,2) DEFAULT 0,
  deadline_days INT,
  proposals_count INT DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'open',
  featured BOOLEAN DEFAULT FALSE,
  moderation_status VARCHAR(32) DEFAULT 'approved',
  moderation_notes TEXT,
  budget_type VARCHAR(32),
  budget NUMERIC(12,2),
  duration VARCHAR(64),
  skills TEXT[] DEFAULT '{}',
  accepted_proposal_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS proposals (
  id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  freelancer_id VARCHAR(64) NOT NULL,
  freelancer_name VARCHAR(255) NOT NULL,
  freelancer_avatar TEXT,
  freelancer_title VARCHAR(255),
  cover_letter TEXT,
  bid_amount NUMERIC(12,2) NOT NULL,
  delivery_days INT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'pending',
  workstream_order_id VARCHAR(64),
  offer_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  title TEXT NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  due_date VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32),
  requirements TEXT,
  deliverables TEXT,
  deliverable_files JSONB,
  revisions JSONB,
  admin_notes TEXT,
  is_muted BOOLEAN DEFAULT FALSE,
  escrow_protection_start_date VARCHAR(32),
  escrow_protection_end_date VARCHAR(32),
  gig_id VARCHAR(64),
  project_id VARCHAR(64),
  service_url TEXT,
  gig_slug VARCHAR(128),
  seller_username VARCHAR(128),
  buyer_username VARCHAR(128),
  service_title TEXT,
  service_thumbnail TEXT,
  is_timer_paused BOOLEAN DEFAULT FALSE,
  fee_breakdown JSONB,
  delivery_history JSONB,
  delivery_notes TEXT,
  delivery_reference TEXT,
  accepted_version INT,
  review_window_days INT,
  review_window_expires_at VARCHAR(32),
  review JSONB
);

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  sender_id VARCHAR(64) NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  timestamp VARCHAR(64) NOT NULL,
  type VARCHAR(32) DEFAULT 'message',
  file_info JSONB,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS reviews (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64),
  reviewer_id VARCHAR(64),
  reviewer_name VARCHAR(255),
  reviewer_avatar TEXT,
  target_user_id VARCHAR(64),
  rating INT NOT NULL,
  comment TEXT,
  order_title TEXT,
  gig_id VARCHAR(64),
  project_id VARCHAR(64),
  created_at VARCHAR(32),
  updated_at VARCHAR(32),
  is_cancelled_order BOOLEAN DEFAULT FALSE,
  reply JSONB
);

CREATE TABLE IF NOT EXISTS uploads (
  filename VARCHAR(255) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  original_name VARCHAR(255),
  mime VARCHAR(128),
  size BIGINT,
  created_at VARCHAR(32) NOT NULL,
  sha256 VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id VARCHAR(64) PRIMARY KEY,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  order_ids JSONB DEFAULT '[]'::jsonb,
  title TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  last_activity_at VARCHAR(32),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS workstream_offers (
  id VARCHAR(64) PRIMARY KEY,
  number VARCHAR(32),
  order_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64),
  kind VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  delivery_days INT,
  status VARCHAR(32) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  resolved_at VARCHAR(32),
  resolved_by VARCHAR(64),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS custom_invoices (
  id VARCHAR(64) PRIMARY KEY,
  invoice_number VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(32) NOT NULL,
  description TEXT,
  created_at VARCHAR(32) NOT NULL,
  paid_at VARCHAR(32),
  related_order_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS disputes (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64),
  seller_id VARCHAR(64),
  raised_by VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  resolution_notes TEXT,
  resolution_type VARCHAR(64),
  notes TEXT,
  assigned_to VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS refunds (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id VARCHAR(64) PRIMARY KEY,
  freelancer_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  method VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  account_details TEXT,
  details JSONB
);

ALTER TABLE payouts ADD COLUMN IF NOT EXISTS account_details TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS details JSONB;

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  priority VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  messages JSONB DEFAULT '[]'::jsonb,
  is_appeal BOOLEAN DEFAULT FALSE,
  category VARCHAR(64),
  appeal_context JSONB
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  actor VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  action VARCHAR(255) NOT NULL,
  target VARCHAR(255) NOT NULL,
  details TEXT,
  timestamp VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_emails (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT,
  body TEXT NOT NULL,
  type VARCHAR(64),
  sent_at VARCHAR(64),
  date VARCHAR(64),
  read BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_gateways (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS financial_ledger_state (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_order_id ON messages(order_id);
CREATE INDEX IF NOT EXISTS idx_reviews_target_user_id ON reviews(target_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller_id ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_proposals_project_id ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_offers_order_id ON workstream_offers(order_id);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN DEFAULT FALSE,
  created_at VARCHAR(64) NOT NULL,
  dedup_key VARCHAR(255) UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_review JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS previous_status VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gig_order_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_order_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proposal_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extension_requests JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_extension_used BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_request JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_type VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_window_restarted_at VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS response_deadline VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_breakdown JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_reference TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_version INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_window_days INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_window_expires_at VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_timer_paused BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gig_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gig_slug VARCHAR(128);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_username VARCHAR(128);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_username VARCHAR(128);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_title TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_thumbnail TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_muted BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_protection_start_date VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_protection_end_date VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS requirements TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deliverables TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deliverable_files JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS revisions JSONB DEFAULT '[]'::jsonb;

-- Users table upgrades
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) DEFAULT 5.0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reviews_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS earned NUMERIC(12,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_jobs INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS known_devices TEXT[] DEFAULT ARRAY['dev_default_session']::text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available_now BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB;

-- Gigs table upgrades
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS freelancer_username VARCHAR(128);
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS freelancer_avatar TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS freelancer_level VARCHAR(64);
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS slug VARCHAR(255);
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS subcategory VARCHAR(128);
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) DEFAULT 5.0;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS reviews_count INT DEFAULT 0;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS image TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS cover_image TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS gallery TEXT[] DEFAULT '{}';
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'published';
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS extras JSONB DEFAULT '[]'::jsonb;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32) DEFAULT 'approved';
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS moderation_notes TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_gigs_freelancer_id ON gigs(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_gigs_status ON gigs(status);
CREATE INDEX IF NOT EXISTS idx_gigs_category ON gigs(category);
CREATE INDEX IF NOT EXISTS idx_gigs_slug ON gigs(slug);

-- Projects table upgrades
ALTER TABLE projects ADD COLUMN IF NOT EXISTS buyer_avatar TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug VARCHAR(255);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS subcategory VARCHAR(128);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_min NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_max NUMERIC(12,2) DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deadline_days INT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS proposals_count INT DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'open';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32) DEFAULT 'approved';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS moderation_notes TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_type VARCHAR(32);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS duration VARCHAR(64);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS skills TEXT[] DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS accepted_proposal_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_projects_buyer_id ON projects(buyer_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- Proposals table upgrades
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS freelancer_avatar TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS freelancer_title VARCHAR(255);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS cover_letter TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS workstream_order_id VARCHAR(64);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS offer_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_proposals_freelancer_id ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_proposals_workstream_order_id ON proposals(workstream_order_id);
CREATE INDEX IF NOT EXISTS idx_proposals_offer_id ON proposals(offer_id);

-- Reviews table upgrades
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_cancelled_order BOOLEAN DEFAULT FALSE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_title TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS gig_id VARCHAR(64);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS project_id VARCHAR(64);

-- Uploads table upgrades
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS order_id VARCHAR(64);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);

-- Workspaces table upgrades
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS order_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_activity_at VARCHAR(32);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Workstream offers table upgrades
ALTER TABLE workstream_offers ADD COLUMN IF NOT EXISTS number VARCHAR(32);
ALTER TABLE workstream_offers ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);
ALTER TABLE workstream_offers ADD COLUMN IF NOT EXISTS resolved_at VARCHAR(32);
ALTER TABLE workstream_offers ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(64);
ALTER TABLE workstream_offers ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_orders_workspace_id ON orders(workspace_id);

CREATE TABLE IF NOT EXISTS project_clarifications (
  id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  user_avatar TEXT,
  text TEXT NOT NULL,
  timestamp VARCHAR(64) NOT NULL,
  replies JSONB DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_clarifications_project_id ON project_clarifications(project_id);

CREATE TABLE IF NOT EXISTS wallets (
  user_id VARCHAR(64) PRIMARY KEY,
  user_name VARCHAR(255) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  user_role VARCHAR(64) NOT NULL,
  available_balance NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  funds_on_hold NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  pending_withdrawals NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  status VARCHAR(32) DEFAULT 'active' NOT NULL,
  restriction_reason TEXT,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_movements (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  type VARCHAR(32) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id VARCHAR(64) PRIMARY KEY,
  reference VARCHAR(128) NOT NULL,
  description TEXT,
  event_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) UNIQUE,
  actor VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id VARCHAR(64) PRIMARY KEY,
  journal_id VARCHAR(64) NOT NULL REFERENCES ledger_journals(id) ON DELETE CASCADE,
  account_code VARCHAR(32) NOT NULL,
  debit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  credit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD' NOT NULL,
  description TEXT,
  user_id VARCHAR(64),
  order_id VARCHAR(64),
  payout_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS escrows (
  order_id VARCHAR(64) PRIMARY KEY,
  order_title TEXT NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  remaining NUMERIC(14,2) NOT NULL,
  refunded_total NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  released_gross NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  refund_seq INT DEFAULT 0 NOT NULL,
  release_seq INT DEFAULT 0 NOT NULL,
  status VARCHAR(32) DEFAULT 'held' NOT NULL,
  funded_at TIMESTAMPTZ DEFAULT NOW(),
  commission_percent NUMERIC(5,2) DEFAULT 20.00 NOT NULL,
  service_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  small_order_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  fees_refunded BOOLEAN DEFAULT FALSE NOT NULL
);

ALTER TABLE escrows ADD COLUMN IF NOT EXISTS order_title TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS buyer_id VARCHAR(64);
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS seller_id VARCHAR(64);
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS remaining NUMERIC(14,2) DEFAULT 0.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(14,2) DEFAULT 0.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS released_gross NUMERIC(14,2) DEFAULT 0.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS refund_seq INT DEFAULT 0;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS release_seq INT DEFAULT 0;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'held';
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS funded_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2) DEFAULT 20.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS service_fee NUMERIC(14,2) DEFAULT 0.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS small_order_fee NUMERIC(14,2) DEFAULT 0.00;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS fees_refunded BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_escrows_buyer_id ON escrows(buyer_id);
CREATE INDEX IF NOT EXISTS idx_escrows_seller_id ON escrows(seller_id);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);

CREATE TABLE IF NOT EXISTS earnings_clearing (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  clearance_start TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  clearance_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) DEFAULT 'clearing' NOT NULL,
  payout_eligible BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_idempotency (
  key TEXT PRIMARY KEY,
  operation TEXT,
  status TEXT,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pending_balance NUMERIC(14,2) DEFAULT 0.00 NOT NULL;





CREATE TABLE IF NOT EXISTS runtime_diagnostic_logs (
  id VARCHAR(64) PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  severity VARCHAR(16) NOT NULL,
  service VARCHAR(64) NOT NULL,
  function_name VARCHAR(128) NOT NULL,
  implementation VARCHAR(64),
  operation VARCHAR(64) NOT NULL,
  request_id VARCHAR(64),
  outcome VARCHAR(32),
  error_message TEXT,
  details JSONB
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_timestamp ON runtime_diagnostic_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON runtime_diagnostic_logs(severity);
CREATE INDEX IF NOT EXISTS idx_diagnostics_operation ON runtime_diagnostic_logs(operation);
CREATE INDEX IF NOT EXISTS idx_diagnostics_request_id ON runtime_diagnostic_logs(request_id);

CREATE TABLE IF NOT EXISTS payment_methods (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  is_default BOOLEAN DEFAULT FALSE,
  created_at VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user_id ON payment_methods(user_id);

-- PHASE 0B INTEGRITY CONSTRAINTS & EXTENSIONS

-- 1. Review uniqueness: One review per reviewer per order (Fix 35)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_review_order_reviewer ON reviews(order_id, reviewer_id);

-- 2. Username case-insensitive uniqueness (Fix 36)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_lower_username ON users (LOWER(username)) WHERE username IS NOT NULL AND username <> '';

-- 3. Default payment method uniqueness per user (Fix 37)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_user_default_payment_method ON payment_methods(user_id) WHERE is_default = TRUE;

-- 4. Financial Non-Negative & Balance Integrity Checks (Fix 34)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wallets_nonnegative_available') THEN
    ALTER TABLE wallets ADD CONSTRAINT chk_wallets_nonnegative_available CHECK (available_balance >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wallets_nonnegative_hold') THEN
    ALTER TABLE wallets ADD CONSTRAINT chk_wallets_nonnegative_hold CHECK (funds_on_hold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_escrows_nonnegative_remaining') THEN
    ALTER TABLE escrows ADD CONSTRAINT chk_escrows_nonnegative_remaining CHECK (remaining >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_escrows_nonnegative_amount') THEN
    ALTER TABLE escrows ADD CONSTRAINT chk_escrows_nonnegative_amount CHECK (amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payouts_positive_amount') THEN
    ALTER TABLE payouts ADD CONSTRAINT chk_payouts_positive_amount CHECK (amount > 0);
  END IF;
END $$;

-- 5. Payout Provider Reference Unique Constraint (Phase 0C Fix 5)
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_payout_provider_reference ON payouts(provider_reference) WHERE provider_reference IS NOT NULL AND provider_reference <> '';

-- 6. Payment Intents (Phase 0C Fix 8)
CREATE TABLE IF NOT EXISTS payment_intents (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64),
  amount NUMERIC(14,2) NOT NULL,
  currency VARCHAR(16) DEFAULT 'USD' NOT NULL,
  gateway VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'pending' NOT NULL,
  provider_reference VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON payment_intents(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_prov ON payment_intents(provider_reference);





