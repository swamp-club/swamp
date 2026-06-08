-- Seed data for the swamp-creek-example Postgres container.
-- Models a tiny SaaS billing world: customers, their current plan, and
-- the last time we saw them log in. The swamp side keeps "deployment"
-- resources that get cross-queried against these rows.

CREATE TABLE customers (
  name        text PRIMARY KEY,
  plan        text NOT NULL,
  last_login  timestamptz NOT NULL,
  mrr_cents   integer NOT NULL
);

INSERT INTO customers (name, plan, last_login, mrr_cents) VALUES
  ('acme-corp',     'enterprise', '2026-06-08T11:42:00Z', 250000),
  ('beech-labs',    'pro',        '2026-06-07T09:15:00Z',  49900),
  ('cedar-systems', 'pro',        '2026-05-30T16:01:00Z',  49900),
  ('dogwood-io',    'free',       '2026-06-08T08:08:00Z',      0),
  ('elm-bank',      'enterprise', '2026-06-08T03:30:00Z', 980000),
  ('fir-and-co',    'free',       '2026-05-12T22:11:00Z',      0);

CREATE TABLE incidents (
  customer   text NOT NULL REFERENCES customers(name),
  severity   text NOT NULL,
  opened_at  timestamptz NOT NULL
);

INSERT INTO incidents (customer, severity, opened_at) VALUES
  ('acme-corp',  'sev1', '2026-06-08T10:00:00Z'),
  ('elm-bank',   'sev2', '2026-06-08T01:15:00Z'),
  ('beech-labs', 'sev3', '2026-06-06T13:00:00Z');
