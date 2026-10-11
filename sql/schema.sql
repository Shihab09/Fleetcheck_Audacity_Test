-- How the repository contract maps onto PostgreSQL (reference, not run by the tests).

CREATE TABLE quarterly_selections (
  id                 uuid PRIMARY KEY,
  company_id         uuid        NOT NULL REFERENCES companies(id),
  quarter            text        NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  percentage         numeric(5,2) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  algorithm_version  text        NOT NULL,
  seed               text        NOT NULL,   -- revealed to auditors; never shown to company users
  seed_commitment    text        NOT NULL,
  input_hash         text        NOT NULL,
  eligible_count     integer     NOT NULL,
  selected_count     integer     NOT NULL,
  created_by         uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- The rule "running it twice must not produce a second selection" lives here,
  -- so it holds even with two API pods racing each other.
  CONSTRAINT one_selection_per_company_quarter UNIQUE (company_id, quarter)
);

CREATE TABLE selection_vehicles (
  selection_id uuid    NOT NULL REFERENCES quarterly_selections(id),
  vehicle_id   uuid    NOT NULL,
  company_id   uuid    NOT NULL,
  selected     boolean NOT NULL,
  rank         integer,             -- 1..selected_count for picked vehicles, else NULL
  PRIMARY KEY (selection_id, vehicle_id),
  FOREIGN KEY (company_id, vehicle_id) REFERENCES vehicles(company_id, id)
);

-- Selections are evidence: the app role may insert but never change or delete them.
REVOKE UPDATE, DELETE ON quarterly_selections, selection_vehicles FROM app_tenant, app_ops;

ALTER TABLE quarterly_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY ops_only ON quarterly_selections
  USING (current_setting('app.role', true) = 'ops');   -- company admins never see the pick

-- insertIfAbsent, in one transaction:
--   INSERT INTO quarterly_selections (...) VALUES (...)
--   ON CONFLICT ON CONSTRAINT one_selection_per_company_quarter DO NOTHING
--   RETURNING id;
--   -- no row returned => someone else won; SELECT the existing row and return it.
