// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

// a leaf, so the serve host can name these without loading serve's config
export const SERVE_ENV_MAP: Readonly<Record<string, string>> = {
  certFile: "SWAMP_SERVE_CERT_FILE",
  keyFile: "SWAMP_SERVE_KEY_FILE",
  oauthClientId: "SWAMP_OAUTH_CLIENT_ID",
  oauthClientName: "SWAMP_OAUTH_CLIENT_NAME",
  grantsFile: "SWAMP_GRANTS_FILE",
  address: "SWAMP_SERVE_ADDRESS",
  advertiseAddress: "SWAMP_SERVE_ADVERTISE_ADDRESS",
  caCert: "SWAMP_CA_CERT",
  grantsDir: "SWAMP_GRANTS_DIR",
  webhookRoutesDir: "SWAMP_WEBHOOK_ROUTES_DIR",
  webhookRoutesPoll: "SWAMP_WEBHOOK_ROUTES_POLL",
  wsIdleTimeout: "SWAMP_WS_IDLE_TIMEOUT",
  queueTimeout: "SWAMP_QUEUE_TIMEOUT",
  verifyOnEnroll: "SWAMP_VERIFY_ON_ENROLL",
  trustedHosts: "SWAMP_TRUSTED_HOSTS",
  dispatchEnvAllow: "SWAMP_DISPATCH_ENV_ALLOW",
  reservedWorkerLabels: "SWAMP_RESERVED_WORKER_LABELS",
  heartbeatInterval: "SWAMP_HEARTBEAT_INTERVAL",
  staleTtl: "SWAMP_STALE_TTL",
  reconciliationInterval: "SWAMP_RECONCILIATION_INTERVAL",
  hydrationTimeout: "SWAMP_HYDRATION_TIMEOUT",
  shutdownDrainTimeout: "SWAMP_SHUTDOWN_DRAIN_TIMEOUT",
  shutdownListenerGrace: "SWAMP_SHUTDOWN_LISTENER_GRACE",
  datastorePollInterval: "SWAMP_DATASTORE_POLL_INTERVAL",
  continuationSweepInterval: "SWAMP_CONTINUATION_SWEEP_INTERVAL",
  maxSignalWaitTimeout: "SWAMP_MAX_SIGNAL_WAIT_TIMEOUT",
  tokenGcInterval: "SWAMP_TOKEN_GC_INTERVAL",
  tokenGcGracePeriod: "SWAMP_TOKEN_GC_GRACE_PERIOD",
  groupRefreshInterval: "SWAMP_GROUP_REFRESH_INTERVAL",
  maxConcurrentRuns: "SWAMP_MAX_CONCURRENT_RUNS",
  maxConcurrentScheduledRuns: "SWAMP_MAX_CONCURRENT_SCHEDULED_RUNS",
  maxConcurrentWebhookRuns: "SWAMP_MAX_CONCURRENT_WEBHOOK_RUNS",
  maxRunsPerPrincipal: "SWAMP_MAX_RUNS_PER_PRINCIPAL",
  maxRunDuration: "SWAMP_MAX_RUN_DURATION",
  enableInternalApi: "SWAMP_ENABLE_INTERNAL_API",
  remoteOnly: "SWAMP_REMOTE_ONLY",
  reusePort: "SWAMP_REUSE_PORT",
  dashboard: "SWAMP_DASHBOARD",
  autoResume: "SWAMP_AUTO_RESUME",
  approveRequiresExplicitGrant: "SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT",
  keepOauthClientInVault: "SWAMP_KEEP_OAUTH_CLIENT_IN_VAULT",
  signalRequiresExplicitGrant: "SWAMP_SIGNAL_REQUIRES_EXPLICIT_GRANT",
  tagRequiresExplicitGrant: "SWAMP_TAG_REQUIRES_EXPLICIT_GRANT",
  stepsRequireExplicitGrant: "SWAMP_STEPS_REQUIRE_EXPLICIT_GRANT",
};
