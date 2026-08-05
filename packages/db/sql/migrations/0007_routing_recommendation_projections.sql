-- P10-006: persist routing recommendation projections so /org/models can compare
-- projected savings to realized post-period outcomes.

CREATE TABLE IF NOT EXISTS routing_recommendation_projections (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  range_days INT NOT NULL,
  model TEXT NOT NULL,
  cheap_categories TEXT[] NOT NULL,
  cheap_category_calls INT NOT NULL,
  cheap_category_spend_usd NUMERIC(12, 6) NOT NULL,
  savings_ratio NUMERIC(8, 6) NOT NULL,
  projected_monthly_saving_usd NUMERIC(12, 6) NOT NULL,
  projected_period_saving_usd NUMERIC(12, 6) NOT NULL,
  price_precise BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT routing_recommendation_window_model_uniq
    UNIQUE (window_start, window_end, range_days, model)
);

CREATE INDEX IF NOT EXISTS routing_recommendation_created_idx
  ON routing_recommendation_projections (created_at DESC);

CREATE INDEX IF NOT EXISTS routing_recommendation_range_window_idx
  ON routing_recommendation_projections (range_days, window_end DESC);
