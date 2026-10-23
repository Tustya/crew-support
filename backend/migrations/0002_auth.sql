ALTER TABLE app_users
  ADD COLUMN email text,
  ADD COLUMN password_hash text,
  ADD COLUMN position_title text;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_email_shape CHECK (
    email IS NULL OR (
      char_length(email) BETWEEN 3 AND 200
      AND email = lower(email)
      AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    )
  ),
  ADD CONSTRAINT app_users_position_title_length CHECK (
    position_title IS NULL OR char_length(position_title) BETWEEN 1 AND 120
  );

CREATE UNIQUE INDEX app_users_email_uq ON app_users (email) WHERE email IS NOT NULL;

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE auth_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash text NOT NULL,
  ip text NOT NULL CHECK (char_length(ip) BETWEEN 1 AND 64),
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_attempts_email_idx ON auth_attempts (email_hash, attempted_at DESC);
CREATE INDEX auth_attempts_ip_idx ON auth_attempts (ip, attempted_at DESC);
