ALTER TABLE snapshots ADD COLUMN row_count integer NOT NULL DEFAULT 0;

ALTER TABLE app_settings ADD COLUMN data_generation bigint NOT NULL DEFAULT 0;

CREATE TABLE queue_views (
  group_id uuid NOT NULL REFERENCES work_groups (id) ON DELETE CASCADE,
  basis text NOT NULL CHECK (basis IN ('baseline', 'previous')),
  status text NOT NULL CHECK (status IN (
    'unchanged', 'needs_baseline', 'waiting', 'preparing', 'needs_review', 'reviewed', 'handed_off', 'sent', 'stale', 'needs_decision'
  )),
  change_count integer NOT NULL,
  crew_names text[] NOT NULL,
  changes jsonb NOT NULL,
  exceptions jsonb NOT NULL,
  draft_id uuid,
  draft_status text,
  revision integer,
  due_at timestamptz,
  stay_date date NOT NULL,
  airport_code text NOT NULL,
  hotel_id uuid,
  hotel_name text NOT NULL DEFAULT '',
  hotel_city text NOT NULL DEFAULT '',
  hotel_timezone text NOT NULL DEFAULT 'UTC',
  group_key text NOT NULL,
  hotel jsonb,
  last_change_at timestamptz,
  version bigint NOT NULL,
  has_baseline boolean NOT NULL DEFAULT false,
  PRIMARY KEY (group_id, basis)
);

CREATE INDEX queue_views_list_idx ON queue_views (basis, stay_date, status, hotel_name);
