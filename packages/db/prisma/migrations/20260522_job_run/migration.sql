CREATE TABLE IF NOT EXISTS job_runs (
  id         BIGSERIAL PRIMARY KEY,
  job_name   TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status     TEXT NOT NULL DEFAULT 'running',
  error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name_started ON job_runs(job_name, started_at DESC);

-- Add left_at to team_members if not present
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ;
