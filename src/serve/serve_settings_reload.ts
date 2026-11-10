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

import {
  type MergedServeOptions,
  mergeServeOptions,
  SERVE_ENV_MAP,
  type ServeConfigFile,
} from "./serve_config.ts";

/** How a reload treats a change to one setting. */
export type SettingReloadClass =
  | "applied"
  | "restart"
  | "startup-only";

export interface SettingCatalogueEntry {
  /** the setting's name as an operator writes it in serve.yaml */
  readonly setting: string;
  /** the command-line flag that pins it, when there is one */
  readonly flag?: string;
  readonly reloadClass: SettingReloadClass;
  /** for restart: why a running process cannot take the change */
  readonly reason?: string;
}

const NEW_PROCESS = "needs a new process";
const NOT_YET = "not applied by reload yet; restart serve to change it";

/**
 * Every MergedServeOptions key and how reload treats it. Keyed by the
 * merged option name so the type checker refuses a key that is not one.
 */
export const SETTING_CATALOGUE: {
  readonly [K in keyof MergedServeOptions]-?: SettingCatalogueEntry;
} = {
  port: restart("port", "port", `${NEW_PROCESS}: the listener is bound to it`),
  host: restart("host", "host", `${NEW_PROCESS}: the listener is bound to it`),
  certFile: restart(
    "tls.cert-file",
    "cert-file",
    `${NEW_PROCESS}: the listener holds the certificate`,
  ),
  keyFile: restart(
    "tls.key-file",
    "key-file",
    `${NEW_PROCESS}: the listener holds the key`,
  ),
  caCert: restart("tls.ca-cert", "ca-cert", NOT_YET),
  reusePort: restart(
    "reuse-port",
    "reuse-port",
    `${NEW_PROCESS}: the listener is bound with it`,
  ),
  address: restart(
    "address",
    "address",
    `${NEW_PROCESS}: it names this serve in the datastore`,
  ),
  advertiseAddress: restart(
    "advertise-address",
    "advertise-address",
    `${NEW_PROCESS}: peers learned it at startup`,
  ),
  authMode: restart(
    "auth.mode",
    "auth-mode",
    `${NEW_PROCESS}: the auth mode decides which services run`,
  ),
  oauthProvider: restart(
    "auth.oauth-provider",
    "oauth-provider",
    `${NEW_PROCESS}: serve registered its OAuth client with it`,
  ),
  oauthClientId: restart(
    "auth.oauth-client-id",
    "oauth-client-id",
    `${NEW_PROCESS}: issued tokens belong to this client`,
  ),
  oauthClientName: restart(
    "auth.oauth-client-name",
    "oauth-client-name",
    `${NEW_PROCESS}: serve registered its OAuth client with it`,
  ),
  keepOauthClientInVault: restart(
    "auth.keep-oauth-client-in-vault",
    "keep-oauth-client-in-vault",
    NOT_YET,
  ),
  hotReload: restart(
    "hot-reload",
    "hot-reload",
    `${NEW_PROCESS}: the signal handler is installed at startup`,
  ),
  admins: restart("auth.admins", "admins", NOT_YET),
  allowedCollectives: restart(
    "auth.allowed-collectives",
    "allowed-collectives",
    NOT_YET,
  ),
  allowedUsers: restart("auth.allowed-users", "allowed-users", NOT_YET),
  groupsField: restart("auth.groups-field", "groups-field", NOT_YET),
  restrictedModelTypes: restart(
    "auth.restricted-model-types",
    "restricted-model-types",
    NOT_YET,
  ),
  restrictedCommands: restart(
    "auth.restricted-commands",
    "restricted-commands",
    NOT_YET,
  ),
  groupRefreshInterval: restart(
    "auth.group-refresh-interval",
    "group-refresh-interval",
    NOT_YET,
  ),
  approveRequiresExplicitGrant: restart(
    "auth.approve-requires-explicit-grant",
    "approve-requires-explicit-grant",
    NOT_YET,
  ),
  signalRequiresExplicitGrant: restart(
    "auth.signal-requires-explicit-grant",
    "signal-requires-explicit-grant",
    NOT_YET,
  ),
  tagRequiresExplicitGrant: restart(
    "auth.tag-requires-explicit-grant",
    "tag-requires-explicit-grant",
    NOT_YET,
  ),
  schedule: restart("schedule", "schedule", NOT_YET),
  grantsFile: restart("grants-file", "grants-file", NOT_YET),
  grantsDir: restart("grants-dir", "grants-dir", NOT_YET),
  grantReload: restart("grant-reload", "grant-reload", NOT_YET),
  webhookRoutesDir: restart(
    "webhook-routes-dir",
    "webhook-routes-dir",
    NOT_YET,
  ),
  webhookRoutesPoll: restart(
    "webhook-routes-poll",
    "webhook-routes-poll",
    NOT_YET,
  ),
  trustProxy: restart("trust-proxy", "trust-proxy", NOT_YET),
  trustedHosts: restart("trusted-hosts", "trusted-hosts", NOT_YET),
  verifyOnEnroll: restart("verify-on-enroll", "verify-on-enroll", NOT_YET),
  dispatchEnvAllow: restart(
    "dispatch-env-allow",
    "dispatch-env-allow",
    NOT_YET,
  ),
  heartbeatInterval: restart(
    "heartbeat-interval",
    "heartbeat-interval",
    NOT_YET,
  ),
  staleTtl: restart("stale-ttl", "stale-ttl", NOT_YET),
  reconciliationInterval: restart(
    "reconciliation-interval",
    "reconciliation-interval",
    NOT_YET,
  ),
  datastorePollInterval: restart(
    "datastore-poll-interval",
    "datastore-poll-interval",
    NOT_YET,
  ),
  continuationSweepInterval: restart(
    "continuation-sweep-interval",
    "continuation-sweep-interval",
    NOT_YET,
  ),
  tokenGcInterval: restart("token-gc-interval", "token-gc-interval", NOT_YET),
  tokenGcGracePeriod: restart(
    "token-gc-grace-period",
    "token-gc-grace-period",
    NOT_YET,
  ),
  maxConcurrentScheduledRuns: restart(
    "max-concurrent-scheduled-runs",
    "max-concurrent-scheduled-runs",
    NOT_YET,
  ),
  maxConcurrentWebhookRuns: restart(
    "max-concurrent-webhook-runs",
    "max-concurrent-webhook-runs",
    NOT_YET,
  ),
  remoteOnly: restart("remote-only", "remote-only", NOT_YET),
  shutdownListenerGrace: restart(
    "shutdown-listener-grace",
    "shutdown-listener-grace",
    NOT_YET,
  ),
  dashboard: applied("dashboard", "dashboard"),
  enableInternalApi: applied("enable-internal-api", "enable-internal-api"),
  autoResume: applied("auto-resume", "auto-resume"),
  wsIdleTimeout: applied("ws-idle-timeout", "ws-idle-timeout"),
  maxSignalWaitTimeout: applied(
    "max-signal-wait-timeout",
    "max-signal-wait-timeout",
  ),
  shutdownDrainTimeout: applied(
    "shutdown-drain-timeout",
    "shutdown-drain-timeout",
  ),
  maxConcurrentRuns: applied("max-concurrent-runs", "max-concurrent-runs"),
  maxRunsPerPrincipal: applied(
    "max-runs-per-principal",
    "max-runs-per-principal",
  ),
  maxRunDuration: applied("max-run-duration", "max-run-duration"),
  queueTimeout: applied("queue-timeout", "queue-timeout"),
  triggerOverrides: applied("triggers"),
  webhookConfigs: applied("webhooks", "webhook"),
  webhook: {
    setting: "--webhook",
    flag: "webhook",
    reloadClass: "startup-only",
  },
  hydrationTimeout: {
    setting: "hydration-timeout",
    flag: "hydration-timeout",
    reloadClass: "startup-only",
  },
  detachRuns: {
    setting: "detach-runs",
    flag: "detach-runs",
    reloadClass: "startup-only",
  },
};

function applied(setting: string, flag?: string): SettingCatalogueEntry {
  return { setting, ...(flag ? { flag } : {}), reloadClass: "applied" };
}

function restart(
  setting: string,
  flag: string,
  reason: string,
): SettingCatalogueEntry {
  return { setting, flag, reloadClass: "restart", reason };
}

export interface SettingsReloadReport {
  readonly applied: readonly string[];
  readonly needsRestart: readonly { setting: string; reason: string }[];
  readonly overridden: readonly { setting: string; by: string }[];
}

export interface SettingsDiffInput {
  readonly before: ServeConfigFile | null;
  readonly after: ServeConfigFile | null;
  /** flags given explicitly at startup; they win over the file */
  readonly explicitFlags: ReadonlySet<string>;
  readonly envLookup: (name: string) => string | undefined;
}

/**
 * What the serve.yaml edit changed, judged on the file alone, and for each
 * change whether reload applies it, cannot, or is overridden by a startup flag
 * or environment variable.
 */
export function diffServeSettings(
  input: SettingsDiffInput,
): SettingsReloadReport {
  const fileOnly = (config: ServeConfigFile | null) =>
    mergeServeOptions(config, {}, new Set(), () => undefined);
  const before = fileOnly(input.before);
  const after = fileOnly(input.after);

  const appliedSettings: string[] = [];
  const needsRestart: { setting: string; reason: string }[] = [];
  const overridden: { setting: string; by: string }[] = [];
  for (
    const key of Object.keys(SETTING_CATALOGUE) as (keyof MergedServeOptions)[]
  ) {
    if (sameValue(before[key], after[key])) continue;
    const entry = SETTING_CATALOGUE[key];
    if (entry.reloadClass === "startup-only") continue;
    const by = overriddenBy(key, entry, input);
    if (by !== undefined) {
      overridden.push({ setting: entry.setting, by });
    } else if (entry.reloadClass === "applied") {
      appliedSettings.push(entry.setting);
    } else {
      needsRestart.push({
        setting: entry.setting,
        reason: entry.reason ?? NOT_YET,
      });
    }
  }
  return { applied: appliedSettings, needsRestart, overridden };
}

function overriddenBy(
  key: keyof MergedServeOptions,
  entry: SettingCatalogueEntry,
  input: SettingsDiffInput,
): string | undefined {
  if (entry.flag !== undefined && input.explicitFlags.has(entry.flag)) {
    return `--${entry.flag}`;
  }
  const envVar = SERVE_ENV_MAP[key];
  if (envVar !== undefined && input.envLookup(envVar) !== undefined) {
    return envVar;
  }
  return undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * SIGHUP reloads on a serve nobody is attached to (a daemon, a container,
 * systemd's ExecReload) or one started with --hot-reload; a foreground serve
 * on a terminal keeps it as shutdown, so closing the terminal still stops it.
 */
export function reloadsOnHangup(options: {
  readonly os: string;
  readonly hotReload: boolean;
  readonly stdinIsTerminal: boolean;
}): boolean {
  if (options.os === "windows") return false;
  return options.hotReload || !options.stdinIsTerminal;
}
