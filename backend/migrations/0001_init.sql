CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('specialist', 'lead', 'system')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hotels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hotel_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 120),
  airport_code text NOT NULL CHECK (airport_code ~ '^[A-Z]{3}$'),
  timezone text NOT NULL,
  recipient_source text NOT NULL DEFAULT 'local' CHECK (recipient_source IN ('local', 'aviabit')),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc jsonb NOT NULL DEFAULT '[]'::jsonb,
  contract_status text NOT NULL CHECK (contract_status IN ('confirmed', 'none', 'unknown')),
  active boolean NOT NULL DEFAULT true,
  comment text NOT NULL DEFAULT '',
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX hotels_source_hotel_id_uq ON hotels (source_hotel_id) WHERE source_hotel_id IS NOT NULL;

CREATE TABLE app_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  poll_minutes integer NOT NULL CHECK (poll_minutes BETWEEN 1 AND 60),
  quiet_minutes integer NOT NULL CHECK (quiet_minutes BETWEEN 1 AND 120),
  auto_check boolean NOT NULL DEFAULT false,
  auto_prepare boolean NOT NULL DEFAULT false,
  stay_scope text NOT NULL CHECK (stay_scope IN ('today', 'tomorrow', 'both')),
  stale_after_minutes integer NOT NULL,
  template_version integer NOT NULL DEFAULT 1,
  row_version bigint NOT NULL DEFAULT 1,
  sender_name text NOT NULL DEFAULT 'Crew Support' CHECK (char_length(sender_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stale_after_minutes >= poll_minutes)
);

INSERT INTO app_settings (id, poll_minutes, quiet_minutes, auto_check, auto_prepare, stay_scope, stale_after_minutes)
VALUES (1, 5, 60, false, false, 'both', 15);

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL CHECK (template_key IN ('adjustment', 'new_booking', 'cancellation')),
  version integer NOT NULL CHECK (version > 0),
  blocks jsonb NOT NULL,
  columns jsonb NOT NULL,
  new_label text NOT NULL,
  cancel_label text NOT NULL,
  author_id uuid REFERENCES app_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, version)
);

CREATE TABLE source_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_code text,
  source_cursor text,
  input_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_runs_started_idx ON source_runs (started_at DESC);
CREATE UNIQUE INDEX source_runs_one_active ON source_runs (adapter) WHERE status = 'running';

CREATE TABLE snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid NOT NULL REFERENCES source_runs (id),
  source text NOT NULL,
  series_id text NOT NULL,
  seq bigint NOT NULL,
  window_from date,
  window_to date,
  fetched_at timestamptz NOT NULL,
  hash text NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('accepted', 'blocked')),
  completeness text NOT NULL CHECK (completeness IN ('full', 'unknown')),
  validation_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, seq)
);

CREATE TABLE snapshot_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES snapshots (id),
  source_booking_id text,
  source_crew_id text,
  entity_id uuid,
  sheet_name text,
  source_row_no integer,
  source_row_hash text NOT NULL,
  hotel_id uuid REFERENCES hotels (id),
  airport_code text NOT NULL CHECK (airport_code ~ '^[A-Z]{3}$'),
  stay_date date,
  full_name text NOT NULL CHECK (char_length(full_name) <= 250),
  position text,
  gender text CHECK (gender IN ('M', 'F')),
  arrival_local_date date,
  arrival_local_time time,
  departure_local_date date,
  departure_local_time time,
  arrival_flight text,
  departure_flight text,
  room_type text CHECK (room_type IN ('SGL', 'DBL')),
  hotel_duration_raw text,
  hotel_duration_minutes integer,
  record_status text CHECK (record_status IN ('active', 'cancelled')),
  replacement_of text,
  raw_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX snapshot_bookings_source_id_uq ON snapshot_bookings (snapshot_id, source_booking_id) WHERE source_booking_id IS NOT NULL;
CREATE UNIQUE INDEX snapshot_bookings_entity_uq ON snapshot_bookings (snapshot_id, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX snapshot_bookings_snapshot_idx ON snapshot_bookings (snapshot_id);

CREATE TABLE work_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text NOT NULL UNIQUE,
  hotel_id uuid REFERENCES hotels (id),
  airport_code text NOT NULL CHECK (airport_code ~ '^[A-Z]{3}$'),
  stay_date date NOT NULL,
  last_change_at timestamptz,
  quiet_started_at timestamptz,
  due_at timestamptz,
  current_draft_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  last_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_groups_due_idx ON work_groups (due_at);
CREATE INDEX work_groups_hotel_idx ON work_groups (hotel_id, stay_date);

CREATE TABLE notification_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text NOT NULL,
  payload jsonb NOT NULL,
  source_snapshot_id uuid REFERENCES snapshots (id),
  notification_id uuid,
  established_by text NOT NULL CHECK (established_by IN ('manual_base', 'send', 'external_confirm')),
  established_by_user uuid REFERENCES app_users (id),
  confirmed_at timestamptz NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  evidence text CHECK (evidence IS NULL OR char_length(evidence) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_key, revision_no)
);

CREATE INDEX notification_baselines_group_idx ON notification_baselines (group_key, revision_no DESC);

CREATE TABLE change_events (
  id uuid PRIMARY KEY,
  group_key text NOT NULL,
  entity_key text NOT NULL,
  entity_id uuid,
  kind text NOT NULL CHECK (kind IN ('added', 'cancelled', 'arrival', 'departure', 'flight', 'room', 'hotel_change', 'date_change')),
  before_booking jsonb,
  after_booking jsonb,
  changed_fields jsonb NOT NULL,
  first_detected_at timestamptz NOT NULL,
  from_snapshot_id uuid NOT NULL REFERENCES snapshots (id),
  to_snapshot_id uuid NOT NULL REFERENCES snapshots (id),
  linked_event_id uuid,
  link_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_snapshot_id, to_snapshot_id, group_key, entity_key, kind)
);

CREATE INDEX change_events_group_idx ON change_events (group_key, first_detected_at DESC);

CREATE TABLE exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('blocking', 'warning')),
  status text NOT NULL CHECK (status IN ('open', 'held', 'resolved')),
  message text NOT NULL CHECK (char_length(message) <= 500),
  snapshot_id uuid REFERENCES snapshots (id),
  created_by uuid REFERENCES app_users (id),
  resolved_by uuid REFERENCES app_users (id),
  resolution text,
  resolution_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX exceptions_open_idx ON exceptions (group_key) WHERE status <> 'resolved';
CREATE UNIQUE INDEX exceptions_open_kind_uq ON exceptions (group_key, kind, snapshot_id) WHERE status <> 'resolved' AND snapshot_id IS NOT NULL;

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text NOT NULL REFERENCES work_groups (group_key),
  status text NOT NULL CHECK (status IN ('active', 'reviewed', 'sending', 'sent', 'send_failed', 'handed_off', 'external_confirmed', 'stale')),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  source_snapshot_id uuid NOT NULL REFERENCES snapshots (id),
  template_version_id uuid NOT NULL REFERENCES template_versions (id),
  row_version bigint NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX drafts_one_open ON drafts (group_key) WHERE status IN ('active', 'reviewed', 'sending', 'handed_off');
CREATE INDEX drafts_status_idx ON drafts (status, created_at DESC);

ALTER TABLE work_groups
  ADD CONSTRAINT work_groups_current_draft_fk FOREIGN KEY (current_draft_id) REFERENCES drafts (id);

CREATE TABLE draft_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts (id),
  revision integer NOT NULL CHECK (revision > 0),
  source_fingerprint text NOT NULL,
  recipients_fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  rendered_subject text NOT NULL CHECK (char_length(rendered_subject) <= 512),
  rendered_content text NOT NULL,
  recipient_to jsonb NOT NULL,
  recipient_cc jsonb NOT NULL,
  manual_override jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES app_users (id),
  reviewed_fingerprint text,
  template_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, revision)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_version_id uuid NOT NULL REFERENCES draft_versions (id),
  group_key text NOT NULL,
  transport_operation text NOT NULL CHECK (transport_operation IN ('send', 'handoff')),
  transport_status text NOT NULL CHECK (transport_status IN ('sending', 'sent', 'send_failed', 'delivery_unknown', 'handed_off', 'external_confirmed')),
  provider_message_id text,
  actor_id uuid REFERENCES app_users (id),
  archived_payload jsonb NOT NULL,
  sent_at timestamptz,
  external_confirmation_at timestamptz,
  confirmation_basis text CHECK (confirmation_basis IS NULL OR char_length(confirmation_basis) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_version_id, transport_operation)
);

CREATE INDEX notifications_group_idx ON notifications (group_key, created_at DESC);

ALTER TABLE notification_baselines
  ADD CONSTRAINT notification_baselines_notification_fk FOREIGN KEY (notification_id) REFERENCES notifications (id);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications (id),
  request_key text NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result text NOT NULL CHECK (result IN ('pending', 'accepted', 'rejected', 'unknown')),
  provider_receipt_sanitized jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL,
  actor_user_id uuid REFERENCES app_users (id),
  service_actor text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  group_key text,
  result text NOT NULL CHECK (result IN ('ok', 'error', 'denied')),
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL
);

CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_group_idx ON audit_events (group_key, occurred_at DESC);

CREATE TABLE integration_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_key text NOT NULL UNIQUE,
  status text NOT NULL,
  safe_endpoint_label text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  last_test_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO integration_configs (adapter_key, status, safe_endpoint_label)
VALUES
  ('source', 'disabled', 'not-configured'),
  ('mail', 'disabled', 'not-configured');

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  subject_key text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  dedupe_key text NOT NULL,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_active_dedupe ON jobs (dedupe_key) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_due_idx ON jobs (status, due_at);

CREATE TABLE request_dedup (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_code integer,
  response_body jsonb,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename_sanitized text NOT NULL,
  format text NOT NULL,
  sha256 text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  status text NOT NULL,
  schema_version text,
  header_mapping_version text,
  sheet_name text,
  row_count integer,
  unresolved_identity_count integer,
  unresolved_hotel_count integer,
  error_report_safe jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot_id uuid REFERENCES snapshots (id),
  created_by uuid REFERENCES app_users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable table %', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON snapshots
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER snapshot_bookings_immutable BEFORE UPDATE OR DELETE ON snapshot_bookings
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER change_events_immutable BEFORE UPDATE OR DELETE ON change_events
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON template_versions
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER baselines_immutable BEFORE UPDATE OR DELETE ON notification_baselines
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION draft_versions_review_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'reviewed revision is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.rendered_subject IS DISTINCT FROM OLD.rendered_subject
    OR NEW.rendered_content IS DISTINCT FROM OLD.rendered_content
    OR NEW.recipient_to IS DISTINCT FROM OLD.recipient_to
    OR NEW.recipient_cc IS DISTINCT FROM OLD.recipient_cc
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
    OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
    OR NEW.recipients_fingerprint IS DISTINCT FROM OLD.recipients_fingerprint
    OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.manual_override IS DISTINCT FROM OLD.manual_override
  THEN
    RAISE EXCEPTION 'draft payload is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER draft_versions_review_only_trg BEFORE UPDATE ON draft_versions
FOR EACH ROW EXECUTE FUNCTION draft_versions_review_only();

CREATE TRIGGER draft_versions_no_delete BEFORE DELETE ON draft_versions
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION notifications_payload_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_payload IS DISTINCT FROM OLD.archived_payload
    OR NEW.draft_version_id IS DISTINCT FROM OLD.draft_version_id
    OR NEW.group_key IS DISTINCT FROM OLD.group_key
    OR NEW.transport_operation IS DISTINCT FROM OLD.transport_operation
  THEN
    RAISE EXCEPTION 'archived notification is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_payload_immutable_trg BEFORE UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION notifications_payload_immutable();

CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
