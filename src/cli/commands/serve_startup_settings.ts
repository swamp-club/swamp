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

import { UserError } from "../../domain/errors.ts";
import { normalizeOwnerAddress } from "../../domain/datastore_v3/datastore_owner.ts";
import { SIGNAL_WAIT_MAX_TIMEOUT_SECONDS } from "../../domain/workflows/signal_wait.ts";
import {
  MAX_TIMER_DELAY_MS,
  parseTimeout,
  parseTimerDuration,
} from "../duration_parser.ts";
import {
  buildServeAuthConfig,
  type ServeAuthConfig,
} from "../../domain/access/serve_auth_config.ts";
import { resolveWebhooksDir } from "../resolve_webhooks_dir.ts";
import {
  DEFAULT_TOKEN_GC_GRACE_PERIOD_MS,
  DEFAULT_TOKEN_GC_INTERVAL_MS,
} from "../../serve/server_token_gc_service.ts";
import { parseDispatchEnvAllow } from "../../domain/remote/environment_snapshot.ts";
import { CLUB_API_KEY_FILE_FLAG } from "../../infrastructure/persistence/api_key_source.ts";
import {
  loadServeConfig,
  type MergedServeOptions,
  mergeServeOptions,
  parseExplicitFlags,
} from "../../serve/serve_config.ts";
import { OAUTH_CLIENT_SECRET_FILE_FLAG } from "../../serve/oauth_client_secret_source.ts";
import { join, resolve } from "@std/path";
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
} from "../../infrastructure/persistence/paths.ts";
import { DEFAULT_CONTINUATION_SWEEP_INTERVAL_MS } from "../../serve/continuation_sweep_service.ts";
import { normalizeAdvertiseAddress } from "../../domain/datastore_v3/serve_leader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const RECONCILIATION_JITTER_MS = 500;

export function assertOffLoopbackSecurity(
  host: string,
  tlsEnabled: boolean,
  authMode: string,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (!tlsEnabled) {
    throw new UserError(
      "Off-loopback binding requires TLS — provide --cert-file and --key-file, or bind to 127.0.0.1",
    );
  }
  if (authMode === "none") {
    throw new UserError(
      "Off-loopback binding requires authentication — set --auth-mode token or --auth-mode oauth, or bind to 127.0.0.1",
    );
  }
}

/**
 * pins both data and config dirs: pinning only SWAMP_HOME would move the config
 * dir and hide the login credentials, crash-looping token and oauth daemons
 */
export function buildServeDaemonEnv(): Record<string, string> {
  return {
    SWAMP_HOME: resolve(getSwampDataDir()),
    SWAMP_CONFIG_DIR: resolve(getSwampConfigDir()),
  };
}

/** where extension code lives; a webhook routes directory may sit in none */
export function webhookRouteExtensionDirs(
  repoDir: string,
  marker: RepoMarkerData | null,
): string[] {
  return [
    resolve(repoDir, resolveWebhooksDir(marker)),
    join(repoDir, "extensions"),
    join(repoDir, ".swamp"),
  ];
}

export function collectServeExtraArgs(options: AnyOptions): string[] {
  const args: string[] = [];
  if (options.config) {
    args.push("--config", options.config as string);
  }
  if (options.schedule === false) {
    args.push("--no-schedule");
  }
  if (options.grantsFile) {
    args.push("--grants-file", options.grantsFile as string);
  }
  if (options.address) {
    args.push("--address", options.address as string);
  }
  if (options.advertiseAddress) {
    args.push("--advertise-address", options.advertiseAddress as string);
  }
  if (options.caCert) {
    args.push("--ca-cert", options.caCert as string);
  }
  if (options.grantsDir) {
    args.push("--grants-dir", options.grantsDir as string);
  }
  if (options.webhookRoutesDir) {
    args.push("--webhook-routes-dir", options.webhookRoutesDir as string);
  }
  if (options.webhookRoutesPoll) {
    args.push("--webhook-routes-poll", options.webhookRoutesPoll as string);
  }
  if (options.grantReload && options.grantReload !== "manual") {
    args.push("--grant-reload", options.grantReload as string);
  }
  const webhooks = options.webhook as string[] | undefined;
  if (webhooks) {
    for (const spec of webhooks) {
      args.push("--webhook", spec);
    }
  }
  if (options.authMode && options.authMode !== "none") {
    args.push("--auth-mode", options.authMode as string);
  }
  if (options.admins) {
    args.push("--admins", options.admins as string);
  }
  if (options.allowedCollectives) {
    args.push("--allowed-collectives", options.allowedCollectives as string);
  }
  if (options.allowedUsers) {
    args.push("--allowed-users", options.allowedUsers as string);
  }
  if (options.oauthProvider) {
    args.push("--oauth-provider", options.oauthProvider as string);
  }
  if (options.oauthClientId) {
    args.push("--oauth-client-id", options.oauthClientId as string);
  }
  if (options.oauthClientName) {
    args.push("--oauth-client-name", options.oauthClientName as string);
  }
  if (options.clubApiKeyFile) {
    // The daemon runs from the repo directory, so a path relative to the
    // shell that ran `daemon enable` must be made absolute here.
    args.push(
      CLUB_API_KEY_FILE_FLAG,
      resolve(options.clubApiKeyFile as string),
    );
  }
  if (options.oauthClientSecretFile) {
    args.push(
      OAUTH_CLIENT_SECRET_FILE_FLAG,
      resolve(options.oauthClientSecretFile as string),
    );
  }
  if (options.groupsField) {
    args.push("--groups-field", options.groupsField as string);
  }
  if (options.restrictedModelTypes) {
    args.push(
      "--restricted-model-types",
      options.restrictedModelTypes as string,
    );
  }
  if (options.restrictedCommands) {
    args.push(
      "--restricted-commands",
      options.restrictedCommands as string,
    );
  }
  if (options.approveRequiresExplicitGrant) {
    args.push("--approve-requires-explicit-grant");
  }
  if (options.signalRequiresExplicitGrant) {
    args.push("--signal-requires-explicit-grant");
  }
  if (options.tagRequiresExplicitGrant) {
    args.push("--tag-requires-explicit-grant");
  }
  if (options.keepOauthClientInVault) {
    args.push("--keep-oauth-client-in-vault");
  }
  if (options.groupRefreshInterval) {
    args.push(
      "--group-refresh-interval",
      options.groupRefreshInterval as string,
    );
  }
  if (options.trustProxy) {
    args.push("--trust-proxy");
  }
  if (options.wsIdleTimeout) {
    args.push("--ws-idle-timeout", options.wsIdleTimeout as string);
  }
  if (options.queueTimeout) {
    args.push("--queue-timeout", options.queueTimeout as string);
  }
  if (options.verifyOnEnroll) {
    args.push("--verify-on-enroll");
  }
  if (options.trustedHosts) {
    args.push("--trusted-hosts", options.trustedHosts as string);
  }
  if (options.dispatchEnvAllow) {
    args.push("--dispatch-env-allow", options.dispatchEnvAllow as string);
  }
  if (options.heartbeatInterval) {
    args.push("--heartbeat-interval", options.heartbeatInterval as string);
  }
  if (options.staleTtl) {
    args.push("--stale-ttl", options.staleTtl as string);
  }
  if (options.reconciliationInterval) {
    args.push(
      "--reconciliation-interval",
      options.reconciliationInterval as string,
    );
  }
  if (options.hydrationTimeout) {
    args.push("--hydration-timeout", options.hydrationTimeout as string);
  }
  if (options.shutdownDrainTimeout) {
    args.push(
      "--shutdown-drain-timeout",
      options.shutdownDrainTimeout as string,
    );
  }
  if (options.shutdownListenerGrace) {
    args.push(
      "--shutdown-listener-grace",
      options.shutdownListenerGrace as string,
    );
  }
  if (options.datastorePollInterval) {
    args.push(
      "--datastore-poll-interval",
      options.datastorePollInterval as string,
    );
  }
  if (options.continuationSweepInterval) {
    args.push(
      "--continuation-sweep-interval",
      options.continuationSweepInterval as string,
    );
  }
  if (options.maxSignalWaitTimeout) {
    args.push(
      "--max-signal-wait-timeout",
      options.maxSignalWaitTimeout as string,
    );
  }
  if (options.tokenGcInterval) {
    args.push("--token-gc-interval", options.tokenGcInterval as string);
  }
  if (options.tokenGcGracePeriod) {
    args.push(
      "--token-gc-grace-period",
      options.tokenGcGracePeriod as string,
    );
  }
  if (options.remoteOnly) {
    args.push("--remote-only");
  }
  if (options.reusePort) {
    args.push("--reuse-port");
  }
  if (options.maxConcurrentRuns !== undefined) {
    args.push(
      "--max-concurrent-runs",
      String(options.maxConcurrentRuns),
    );
  }
  if (options.maxConcurrentScheduledRuns !== undefined) {
    args.push(
      "--max-concurrent-scheduled-runs",
      String(options.maxConcurrentScheduledRuns),
    );
  }
  if (options.maxConcurrentWebhookRuns !== undefined) {
    args.push(
      "--max-concurrent-webhook-runs",
      String(options.maxConcurrentWebhookRuns),
    );
  }
  if (options.maxRunsPerPrincipal !== undefined) {
    args.push(
      "--max-runs-per-principal",
      String(options.maxRunsPerPrincipal),
    );
  }
  if (options.maxRunDuration) {
    args.push("--max-run-duration", options.maxRunDuration as string);
  }
  if (options.hotReload) {
    args.push("--hot-reload");
  }
  if (options.enableInternalApi) {
    args.push("--enable-internal-api");
  }
  if (options.dashboard) {
    args.push("--dashboard");
  }
  if (options.autoResume) {
    args.push("--auto-resume");
  }
  return args;
}

export function validateServeDaemonArgs(
  options: AnyOptions,
  repoDir: string,
  unitEnv: Readonly<Record<string, string>>,
): ServeStartupSettings {
  const unitArgs = [
    "--repo-dir",
    repoDir,
    "--port",
    String(options.port),
    "--host",
    options.host as string,
  ];
  if (options.certFile) {
    unitArgs.push("--cert-file", options.certFile as string);
  }
  if (options.keyFile) {
    unitArgs.push("--key-file", options.keyFile as string);
  }
  for (const arg of collectServeExtraArgs(options)) {
    unitArgs.push(arg);
  }

  const configFile = loadServeConfig(
    options.config as string | undefined,
    repoDir,
  );
  const merged = mergeServeOptions(
    configFile,
    options,
    parseExplicitFlags(unitArgs),
    (name) => unitEnv[name],
  );
  return resolveServeStartupSettings(merged);
}

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

const DEFAULT_SHUTDOWN_LISTENER_GRACE_MS = 1_000;

// with reuse-port the kernel stops handing this process connections only once
// it stops listening, and no load balancer needs time to notice
export function parseShutdownListenerGrace(
  raw: string | undefined,
  reusePort: boolean,
): number {
  if (raw === undefined) {
    return reusePort ? 0 : DEFAULT_SHUTDOWN_LISTENER_GRACE_MS;
  }
  if (/^0+(ms|mo|[smhdwy])?$/i.test(raw.trim())) return 0;
  return parseTimerDuration(raw, "--shutdown-listener-grace");
}

export function parseShutdownDrainTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (/^0+(ms|mo|[smhdwy])?$/i.test(raw.trim())) return 0;
  return parseTimerDuration(raw, "--shutdown-drain-timeout");
}

export function parseDatastorePollInterval(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+ms$/i.test(raw.trim())) {
    throw new UserError(
      `--datastore-poll-interval must be in whole seconds or larger units (minimum 1s, e.g. 1s, 30s, 1m); got ${raw}`,
    );
  }
  return parseTimerDuration(raw, "--datastore-poll-interval");
}

export function parseWebhookRoutesPoll(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim().toLowerCase() === "off") return undefined;
  if (/^\d+ms$/i.test(raw.trim())) {
    throw new UserError(
      `--webhook-routes-poll must be off or whole seconds or larger units (minimum 1s, e.g. 10s, 30s, 1m); got ${raw}`,
    );
  }
  return parseTimerDuration(raw, "--webhook-routes-poll");
}

const DEFAULT_GROUP_REFRESH_MS = 4 * 60 * 60 * 1000;

export function parseContinuationSweepInterval(
  raw: string | undefined,
): number {
  if (raw === undefined) return DEFAULT_CONTINUATION_SWEEP_INTERVAL_MS;
  if (/^0+(s|m|h)?$/i.test(raw.trim())) return 0;
  if (/^\d+ms$/i.test(raw.trim())) {
    throw new UserError(
      `--continuation-sweep-interval must be in whole seconds or larger units (minimum 1s, e.g. 1s, 30s, 1m), or 0 to disable; got ${raw}`,
    );
  }
  return parseTimerDuration(raw, "--continuation-sweep-interval");
}

export function parseMaxSignalWaitTimeout(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = parseTimeout(raw, "--max-signal-wait-timeout") / 1000;
  if (seconds > SIGNAL_WAIT_MAX_TIMEOUT_SECONDS) {
    throw new UserError(
      `--max-signal-wait-timeout (${raw}) is more than the one year (${SIGNAL_WAIT_MAX_TIMEOUT_SECONDS}s) any wait may ask for`,
    );
  }
  return seconds;
}

export interface TokenGcSettings {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;
}

export function parseTokenGcSettings(
  interval: string | undefined,
  gracePeriod: string | undefined,
): TokenGcSettings {
  return {
    intervalMs: interval === undefined
      ? DEFAULT_TOKEN_GC_INTERVAL_MS
      : parseTokenGcDuration(interval, "--token-gc-interval", true),
    gracePeriodMs: gracePeriod === undefined
      ? DEFAULT_TOKEN_GC_GRACE_PERIOD_MS
      : parseTokenGcDuration(gracePeriod, "--token-gc-grace-period", false),
  };
}

function parseTokenGcDuration(
  raw: string,
  flagName: string,
  drivesTimer: boolean,
): number {
  const trimmed = raw.trim();
  if (/^0+(ms|mo|[smhdwy])?$/i.test(trimmed)) return 0;
  if (/^\d+ms$/i.test(trimmed)) {
    throw new UserError(
      `${flagName} must be in whole seconds or larger units (e.g. 30s, 1h); got ${raw}`,
    );
  }
  return drivesTimer
    ? parseTimerDuration(raw, flagName)
    : parseTimeout(raw, flagName);
}

export interface ServeStartupSettings {
  authConfig: ServeAuthConfig;
  /**
   * address clients reach this serve at; serve writes a claimed v3 datastore
   * only when it is the owner's
   */
  ownerAddress?: string;
  /**
   * this node's address as its team's other nodes reach it; the leader record
   * names it so followers can forward
   */
  advertiseAddress?: string;
  tlsEnabled: boolean;
  wsIdleTimeoutSeconds?: number;
  queueTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleTtlMs?: number;
  reconciliationIntervalMs?: number;
  shutdownDrainTimeoutMs: number;
  shutdownListenerGraceMs: number;
  hydrationTimeoutMs: number;
  datastorePollIntervalMs?: number;
  webhookRoutesPollMs?: number;
  continuationSweepIntervalMs: number;
  maxSignalWaitTimeoutSeconds?: number;
  tokenGcSettings: TokenGcSettings;
  /** 0 when group refresh is off */
  groupRefreshMs: number;
  dispatchEnvAllow?: readonly string[];
  maxConcurrentRuns?: number;
  maxConcurrentScheduledRuns?: number;
  maxConcurrentWebhookRuns?: number;
  maxRunsPerPrincipal?: number;
  maxRunDurationMs?: number;
  grantReloadMode: "manual" | "auto";
}

export function resolveServeStartupSettings(
  merged: MergedServeOptions,
): ServeStartupSettings {
  const { certFile, keyFile } = merged;
  if ((certFile && !keyFile) || (!certFile && keyFile)) {
    throw new UserError(
      "Both --cert-file and --key-file must be provided together for TLS",
    );
  }
  const tlsEnabled = Boolean(certFile && keyFile);
  const ownerAddress = merged.address === undefined
    ? undefined
    : normalizeOwnerAddress(merged.address);
  const advertiseAddress = merged.advertiseAddress === undefined
    ? undefined
    : normalizeAdvertiseAddress(merged.advertiseAddress);

  const wsIdleTimeoutRaw = merged.wsIdleTimeout;
  let wsIdleTimeoutSeconds: number | undefined;
  if (wsIdleTimeoutRaw !== undefined) {
    if (wsIdleTimeoutRaw === "0") {
      wsIdleTimeoutSeconds = 0;
    } else {
      wsIdleTimeoutSeconds = Math.round(
        parseTimeout(wsIdleTimeoutRaw) / 1000,
      );
    }
  }

  const queueTimeoutRaw = merged.queueTimeout;
  let queueTimeoutMs: number | undefined;
  if (queueTimeoutRaw !== undefined) {
    const normalized = queueTimeoutRaw.trim().replace(/^0[smhdw].*$/i, "0");
    queueTimeoutMs = normalized === "0"
      ? 0
      : parseTimeout(queueTimeoutRaw, "--queue-timeout");
  }

  const heartbeatIntervalMs = merged.heartbeatInterval !== undefined
    ? parseTimerDuration(merged.heartbeatInterval, "--heartbeat-interval")
    : undefined;

  const staleTtlMs = merged.staleTtl !== undefined
    ? parseTimeout(merged.staleTtl, "--stale-ttl")
    : undefined;

  const reconciliationIntervalMs = merged.reconciliationInterval !== undefined
    ? parseTimerDuration(
      merged.reconciliationInterval,
      "--reconciliation-interval",
      MAX_TIMER_DELAY_MS - RECONCILIATION_JITTER_MS,
    )
    : undefined;

  const shutdownDrainTimeoutMs = parseShutdownDrainTimeout(
    merged.shutdownDrainTimeout,
  );
  const shutdownListenerGraceMs = parseShutdownListenerGrace(
    merged.shutdownListenerGrace,
    merged.reusePort,
  );

  const hydrationTimeoutMs = merged.hydrationTimeout !== undefined
    ? parseTimerDuration(merged.hydrationTimeout, "--hydration-timeout")
    : 60_000;

  const datastorePollIntervalMs = parseDatastorePollInterval(
    merged.datastorePollInterval,
  );

  const webhookRoutesPollMs = parseWebhookRoutesPoll(merged.webhookRoutesPoll);

  const continuationSweepIntervalMs = parseContinuationSweepInterval(
    merged.continuationSweepInterval,
  );

  const maxSignalWaitTimeoutSeconds = parseMaxSignalWaitTimeout(
    merged.maxSignalWaitTimeout,
  );

  const tokenGcSettings = parseTokenGcSettings(
    merged.tokenGcInterval,
    merged.tokenGcGracePeriod,
  );

  const dispatchEnvAllow = parseDispatchEnvAllow(merged.dispatchEnvAllow);

  let groupRefreshMs = DEFAULT_GROUP_REFRESH_MS;
  if (merged.groupRefreshInterval !== undefined) {
    const normalized = merged.groupRefreshInterval.trim().replace(
      /^0[smhdw].*$/i,
      "0",
    );
    groupRefreshMs = normalized === "0" ? 0 : parseTimerDuration(
      merged.groupRefreshInterval,
      "--group-refresh-interval",
    );
  }

  const maxConcurrentRuns = merged.maxConcurrentRuns;
  if (
    maxConcurrentRuns !== undefined &&
    (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1)
  ) {
    throw new UserError(
      `--max-concurrent-runs must be a positive integer, got ${maxConcurrentRuns}`,
    );
  }
  const maxConcurrentScheduledRuns = merged.maxConcurrentScheduledRuns;
  if (
    maxConcurrentScheduledRuns !== undefined &&
    (!Number.isInteger(maxConcurrentScheduledRuns) ||
      maxConcurrentScheduledRuns < 1)
  ) {
    throw new UserError(
      `--max-concurrent-scheduled-runs must be a positive integer, got ${maxConcurrentScheduledRuns}`,
    );
  }
  const maxConcurrentWebhookRuns = merged.maxConcurrentWebhookRuns;
  if (
    maxConcurrentWebhookRuns !== undefined &&
    (!Number.isInteger(maxConcurrentWebhookRuns) ||
      maxConcurrentWebhookRuns < 1)
  ) {
    throw new UserError(
      `--max-concurrent-webhook-runs must be a positive integer, got ${maxConcurrentWebhookRuns}`,
    );
  }
  const maxRunsPerPrincipal = merged.maxRunsPerPrincipal;
  if (
    maxRunsPerPrincipal !== undefined &&
    (!Number.isInteger(maxRunsPerPrincipal) || maxRunsPerPrincipal < 1)
  ) {
    throw new UserError(
      `--max-runs-per-principal must be a positive integer, got ${maxRunsPerPrincipal}`,
    );
  }
  const maxRunDurationMs = merged.maxRunDuration !== undefined
    ? parseTimerDuration(String(merged.maxRunDuration), "--max-run-duration")
    : undefined;

  const authConfig = buildServeAuthConfig({
    authMode: merged.authMode,
    admins: merged.admins,
    allowedCollectives: merged.allowedCollectives,
    allowedUsers: merged.allowedUsers,
    oauthProvider: merged.oauthProvider,
    oauthClientId: merged.oauthClientId,
    groupsField: merged.groupsField,
    restrictedModelTypes: merged.restrictedModelTypes,
    restrictedCommands: merged.restrictedCommands,
    approveRequiresExplicitGrant: merged.approveRequiresExplicitGrant,
    signalRequiresExplicitGrant: merged.signalRequiresExplicitGrant,
    tagRequiresExplicitGrant: merged.tagRequiresExplicitGrant,
  });

  assertOffLoopbackSecurity(merged.host, tlsEnabled, authConfig.mode);

  const grantReloadMode = merged.grantReload;
  if (grantReloadMode !== "manual" && grantReloadMode !== "auto") {
    throw new UserError(
      `Invalid --grant-reload value "${grantReloadMode}": must be "manual" or "auto"`,
    );
  }

  return {
    authConfig,
    tlsEnabled,
    ...(ownerAddress !== undefined ? { ownerAddress } : {}),
    ...(advertiseAddress !== undefined ? { advertiseAddress } : {}),
    wsIdleTimeoutSeconds,
    queueTimeoutMs,
    heartbeatIntervalMs,
    staleTtlMs,
    reconciliationIntervalMs,
    shutdownDrainTimeoutMs,
    shutdownListenerGraceMs,
    hydrationTimeoutMs,
    datastorePollIntervalMs,
    ...(webhookRoutesPollMs !== undefined ? { webhookRoutesPollMs } : {}),
    continuationSweepIntervalMs,
    maxSignalWaitTimeoutSeconds,
    tokenGcSettings,
    groupRefreshMs,
    ...(dispatchEnvAllow !== undefined ? { dispatchEnvAllow } : {}),
    maxConcurrentRuns,
    maxConcurrentScheduledRuns,
    maxConcurrentWebhookRuns,
    maxRunsPerPrincipal,
    maxRunDurationMs,
    grantReloadMode,
  };
}
