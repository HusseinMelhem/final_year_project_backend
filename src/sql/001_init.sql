-- Extensions (optional but useful)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===== Enums (simple via CHECK for portability) =====

-- ===== Users / Auth =====
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(30) UNIQUE NOT NULL
);

INSERT INTO roles (name) VALUES ('USER'), ('ADMIN')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL REFERENCES roles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','DELETED')),
  blocked_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS countries (
  code CHAR(2) PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

-- Minimal seed
INSERT INTO countries(code, name) VALUES ('LB','Lebanon')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS cities (
  id SERIAL PRIMARY KEY,
  country_code CHAR(2) NOT NULL REFERENCES countries(code),
  name VARCHAR(120) NOT NULL,
  UNIQUE(country_code, name)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(80) NOT NULL,
  avatar_url TEXT NULL,
  city_id INT NULL REFERENCES cities(id),
  budget_min INT NULL,
  budget_max INT NULL,
  gender VARCHAR(20) NOT NULL DEFAULT 'PREFER_NOT_SAY',
  gender_preference VARCHAR(20) NOT NULL DEFAULT 'ANY',
  lifestyle_tags TEXT[] NOT NULL DEFAULT '{}',
  bio TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Listings =====
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  city_id INT NOT NULL REFERENCES cities(id),
  title VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  room_type VARCHAR(20) NOT NULL CHECK (room_type IN ('WHOLE_APT','PRIVATE_ROOM','SHARED_ROOM','STUDIO')),
  price_monthly INT NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','LBP','EUR')),
  gender_preference VARCHAR(20) NOT NULL DEFAULT 'ANY',
  address_text TEXT NULL,
  approx_location TEXT NULL,
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  google_maps_place_id VARCHAR(200) NULL,
  google_maps_url TEXT NULL,
  available_from DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','ARCHIVED','DELETED')),
  reviewed_by_admin_id UUID NULL REFERENCES users(id),
  review_note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listings_status_city ON listings(status, city_id);
CREATE INDEX IF NOT EXISTS idx_listings_status_price ON listings(status, price_monthly);
CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS listing_photos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_photos_listing_pos ON listing_photos(listing_id, position);

CREATE TABLE IF NOT EXISTS favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, listing_id)
);

-- ===== Messaging (History) =====
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','SPAM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  participant_role VARCHAR(20) NOT NULL CHECK (participant_role IN ('OWNER','INQUIRER','ADMIN')),
  last_read_at TIMESTAMPTZ NULL,
  PRIMARY KEY(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ NULL,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by_admin_id UUID NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_edits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version INT NOT NULL,
  body TEXT NOT NULL,
  edited_by_user_id UUID NOT NULL REFERENCES users(id),
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id, version)
);

-- ===== Reports & Audit =====
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_user_id UUID NOT NULL REFERENCES users(id),
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('LISTING','USER','MESSAGE','CONVERSATION')),
  target_id UUID NOT NULL,
  reason_code VARCHAR(20) NOT NULL CHECK (reason_code IN ('SCAM','SPAM','HARASSMENT','INAPPROPRIATE','OTHER')),
  description TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','REJECTED')),
  resolved_by_admin_id UUID NULL REFERENCES users(id),
  resolution_note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status_time ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID NULL REFERENCES users(id),
  action_type VARCHAR(60) NOT NULL,
  target_table VARCHAR(60) NULL,
  target_id UUID NULL,
  details JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
