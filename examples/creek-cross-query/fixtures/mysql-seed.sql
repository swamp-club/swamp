-- Seed data for the swamp-creek-example MySQL container.
-- Models a deployment audit log keyed by customer + service name.
-- The 3-way cross-query story: swamp owns "deployment" resources, Postgres
-- owns customer/plan/billing state, MySQL owns the audit log.

CREATE TABLE deploy_audits (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer     VARCHAR(64) NOT NULL,
  service      VARCHAR(64) NOT NULL,
  status       VARCHAR(16) NOT NULL,
  duration_ms  INT NOT NULL,
  deployed_at  DATETIME(3) NOT NULL,
  INDEX idx_customer (customer),
  INDEX idx_deployed_at (deployed_at)
);

INSERT INTO deploy_audits (customer, service, status, duration_ms, deployed_at) VALUES
  ('acme-corp',     'api',     'success', 12400,  '2026-06-08 11:30:00.000'),
  ('acme-corp',     'web',     'success',  8900,  '2026-06-08 09:12:00.000'),
  ('beech-labs',    'api',     'failed',   3400,  '2026-06-07 17:45:00.000'),
  ('beech-labs',    'worker',  'success',  6200,  '2026-06-07 10:00:00.000'),
  ('cedar-systems', 'api',     'success', 11200,  '2026-06-05 14:00:00.000'),
  ('elm-bank',      'api',     'success',  9100,  '2026-06-08 02:50:00.000'),
  ('elm-bank',      'web',     'success',  7700,  '2026-06-08 02:51:00.000'),
  ('dogwood-io',    'api',     'success',  3300,  '2026-06-08 07:55:00.000');
