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

import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { UserError } from "../domain/errors.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { resolveSecret, type WebhookEndpoint } from "./webhook.ts";
import { WEBHOOK_SCHEMES, type WebhookScheme } from "./webhook_verifiers.ts";
import type { VerifierConfig } from "./webhook_verifiers.ts";

const logger = getSwampLogger(["serve", "config"]);

// ── Env Var Map ───────────────────────────────────────────────────────

export const SERVE_ENV_MAP: Readonly<Record<string, string>> = {
  certFile: "SWAMP_SERVE_CERT_FILE",
  keyFile: "SWAMP_SERVE_KEY_FILE",
  grantsFile: "SWAMP_GRANTS_FILE",
  grantsDir: "SWAMP_GRANTS_DIR",
  wsIdleTimeout: "SWAMP_WS_IDLE_TIMEOUT",
  queueTimeout: "SWAMP_QUEUE_TIMEOUT",
  verifyOnEnroll: "SWAMP_VERIFY_ON_ENROLL",
  trustedHosts: "SWAMP_TRUSTED_HOSTS",
  heartbeatInterval: "SWAMP_HEARTBEAT_INTERVAL",
  staleTtl: "SWAMP_STALE_TTL",
  reconciliationInterval: "SWAMP_RECONCILIATION_INTERVAL",
  hydrationTimeout: "SWAMP_HYDRATION_TIMEOUT",
  groupRefreshInterval: "SWAMP_GROUP_REFRESH_INTERVAL",
  maxConcurrentRuns: "SWAMP_MAX_CONCURRENT_RUNS",
  maxRunsPerPrincipal: "SWAMP_MAX_RUNS_PER_PRINCIPAL",
  maxRunDuration: "SWAMP_MAX_RUN_DURATION",
  enableInternalApi: "SWAMP_ENABLE_INTERNAL_API",
};

// ── Webhook Config Types ──────────────────────────────────────────────

export interface WebhookConfigEntry {
  readonly route: string;
  readonly workflow: string;
  readonly secret: string;
  readonly scheme?: string;
  readonly header?: string;
  readonly prefix?: string;
}

// ── Config File Shape ─────────────────────────────────────────────────

export interface ServeConfigFile {
  port?: number;
  host?: string;
  auth?: {
    mode?: string;
    admins?: string[];
    "allowed-collectives"?: string[];
    "allowed-users"?: string[];
    "oauth-provider"?: string;
    "oauth-client-id"?: string;
    "groups-field"?: string;
    "restricted-model-types"?: string[];
    "restricted-commands"?: string[];
    "group-refresh-interval"?: string;
  };
  tls?: {
    "cert-file"?: string;
    "key-file"?: string;
  };
  webhooks?: WebhookConfigEntry[];
  schedule?: boolean;
  "hot-reload"?: boolean;
  "detach-runs"?: boolean;
  "trust-proxy"?: boolean;
  "trusted-hosts"?: string[];
  "grants-file"?: string;
  "grants-dir"?: string;
  "grant-reload"?: string;
  "ws-idle-timeout"?: string;
  "queue-timeout"?: string;
  "verify-on-enroll"?: boolean;
  "heartbeat-interval"?: string;
  "stale-ttl"?: string;
  "reconciliation-interval"?: string;
  "max-concurrent-runs"?: number;
  "max-runs-per-principal"?: number;
  "max-run-duration"?: string;
  "hydration-timeout"?: string;
  "enable-internal-api"?: boolean;
}

// ── Known Keys ────────────────────────────────────────────────────────

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "port",
  "host",
  "auth",
  "tls",
  "webhooks",
  "schedule",
  "hot-reload",
  "detach-runs",
  "trust-proxy",
  "trusted-hosts",
  "grants-file",
  "grants-dir",
  "grant-reload",
  "ws-idle-timeout",
  "queue-timeout",
  "verify-on-enroll",
  "heartbeat-interval",
  "stale-ttl",
  "reconciliation-interval",
  "max-concurrent-runs",
  "max-runs-per-principal",
  "max-run-duration",
  "hydration-timeout",
  "enable-internal-api",
]);

const KNOWN_AUTH_KEYS = new Set([
  "mode",
  "admins",
  "allowed-collectives",
  "allowed-users",
  "oauth-provider",
  "oauth-client-id",
  "groups-field",
  "restricted-model-types",
  "restricted-commands",
  "group-refresh-interval",
]);

const KNOWN_TLS_KEYS = new Set([
  "cert-file",
  "key-file",
]);

// ── Config Loading ────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = ".swamp/serve.yaml";

export function loadServeConfig(
  configPath: string | undefined,
  repoDir: string,
): ServeConfigFile | null {
  const path = configPath ?? join(repoDir, DEFAULT_CONFIG_PATH);
  const isExplicit = configPath !== undefined;

  let content: string;
  try {
    content = Deno.readTextFileSync(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      if (isExplicit) {
        throw new UserError(
          `Serve config file not found: ${path}`,
        );
      }
      return null;
    }
    throw new UserError(
      `Failed to read serve config file ${path}: ${cause}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (cause) {
    throw new UserError(
      `Invalid YAML in serve config file ${path}: ${cause}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return null;
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(
      `Serve config file ${path} must be a YAML mapping, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }`,
    );
  }

  const raw = parsed as Record<string, unknown>;

  warnUnknownKeys(raw, KNOWN_TOP_LEVEL_KEYS, path, "");
  if (raw.auth && typeof raw.auth === "object" && !Array.isArray(raw.auth)) {
    warnUnknownKeys(
      raw.auth as Record<string, unknown>,
      KNOWN_AUTH_KEYS,
      path,
      "auth.",
    );
  }
  if (raw.tls && typeof raw.tls === "object" && !Array.isArray(raw.tls)) {
    warnUnknownKeys(
      raw.tls as Record<string, unknown>,
      KNOWN_TLS_KEYS,
      path,
      "tls.",
    );
  }

  validateConfigValues(raw, path);

  logger.info`Loaded serve config from ${path}`;

  return raw as unknown as ServeConfigFile;
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      logger.warn(
        "Unknown key {key} in serve config file {path} — ignoring",
        { key: `${prefix}${key}`, path },
      );
    }
  }
}

function validateConfigValues(
  raw: Record<string, unknown>,
  path: string,
): void {
  if (raw.port !== undefined) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port)) {
      throw new UserError(
        `Invalid port in ${path}: expected integer, got ${
          JSON.stringify(raw.port)
        }`,
      );
    }
    if (raw.port < 1 || raw.port > 65535) {
      throw new UserError(
        `Invalid port in ${path}: must be between 1 and 65535, got ${raw.port}`,
      );
    }
  }

  if (raw.host !== undefined && typeof raw.host !== "string") {
    throw new UserError(
      `Invalid host in ${path}: expected string, got ${typeof raw.host}`,
    );
  }

  if (raw.schedule !== undefined && typeof raw.schedule !== "boolean") {
    throw new UserError(
      `Invalid schedule in ${path}: expected boolean, got ${typeof raw
        .schedule}`,
    );
  }

  if (
    raw["hot-reload"] !== undefined && typeof raw["hot-reload"] !== "boolean"
  ) {
    throw new UserError(
      `Invalid hot-reload in ${path}: expected boolean, got ${typeof raw[
        "hot-reload"
      ]}`,
    );
  }

  if (
    raw["detach-runs"] !== undefined && typeof raw["detach-runs"] !== "boolean"
  ) {
    throw new UserError(
      `Invalid detach-runs in ${path}: expected boolean, got ${typeof raw[
        "detach-runs"
      ]}`,
    );
  }

  if (
    raw["trust-proxy"] !== undefined && typeof raw["trust-proxy"] !== "boolean"
  ) {
    throw new UserError(
      `Invalid trust-proxy in ${path}: expected boolean, got ${typeof raw[
        "trust-proxy"
      ]}`,
    );
  }

  if (
    raw["verify-on-enroll"] !== undefined &&
    typeof raw["verify-on-enroll"] !== "boolean"
  ) {
    throw new UserError(
      `Invalid verify-on-enroll in ${path}: expected boolean, got ${typeof raw[
        "verify-on-enroll"
      ]}`,
    );
  }

  const stringFields: [string, unknown][] = [
    ["grants-file", raw["grants-file"]],
    ["grants-dir", raw["grants-dir"]],
    ["grant-reload", raw["grant-reload"]],
    ["ws-idle-timeout", raw["ws-idle-timeout"]],
    ["queue-timeout", raw["queue-timeout"]],
    ["heartbeat-interval", raw["heartbeat-interval"]],
    ["stale-ttl", raw["stale-ttl"]],
    ["reconciliation-interval", raw["reconciliation-interval"]],
    ["hydration-timeout", raw["hydration-timeout"]],
  ];
  for (const [name, value] of stringFields) {
    if (value !== undefined && typeof value !== "string") {
      throw new UserError(
        `Invalid ${name} in ${path}: expected string, got ${typeof value}`,
      );
    }
  }

  if (raw.auth && typeof raw.auth === "object" && !Array.isArray(raw.auth)) {
    const authObj = raw.auth as Record<string, unknown>;
    const authStringFields: [string, unknown][] = [
      ["auth.mode", authObj.mode],
      ["auth.oauth-provider", authObj["oauth-provider"]],
      ["auth.oauth-client-id", authObj["oauth-client-id"]],
      ["auth.groups-field", authObj["groups-field"]],
      ["auth.group-refresh-interval", authObj["group-refresh-interval"]],
    ];
    for (const [name, value] of authStringFields) {
      if (value !== undefined && typeof value !== "string") {
        throw new UserError(
          `Invalid ${name} in ${path}: expected string, got ${typeof value}`,
        );
      }
    }
  }

  if (raw.tls && typeof raw.tls === "object" && !Array.isArray(raw.tls)) {
    const tlsObj = raw.tls as Record<string, unknown>;
    const tlsStringFields: [string, unknown][] = [
      ["tls.cert-file", tlsObj["cert-file"]],
      ["tls.key-file", tlsObj["key-file"]],
    ];
    for (const [name, value] of tlsStringFields) {
      if (value !== undefined && typeof value !== "string") {
        throw new UserError(
          `Invalid ${name} in ${path}: expected string, got ${typeof value}`,
        );
      }
    }
  }

  if (raw.webhooks !== undefined) {
    if (!Array.isArray(raw.webhooks)) {
      throw new UserError(
        `Invalid webhooks in ${path}: expected array, got ${typeof raw
          .webhooks}`,
      );
    }
    for (let i = 0; i < raw.webhooks.length; i++) {
      validateWebhookEntry(raw.webhooks[i], path, i);
    }
  }

  if (raw["trusted-hosts"] !== undefined) {
    if (!Array.isArray(raw["trusted-hosts"])) {
      throw new UserError(
        `Invalid trusted-hosts in ${path}: expected array of strings, got ${typeof raw[
          "trusted-hosts"
        ]}`,
      );
    }
  }
}

function validateWebhookEntry(
  entry: unknown,
  path: string,
  index: number,
): void {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new UserError(
      `Invalid webhook at index ${index} in ${path}: expected object`,
    );
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.route !== "string" || !obj.route) {
    throw new UserError(
      `Invalid webhook at index ${index} in ${path}: route is required and must be a string`,
    );
  }
  if (!obj.route.startsWith("/")) {
    throw new UserError(
      `Invalid webhook at index ${index} in ${path}: route must start with '/', got '${obj.route}'`,
    );
  }
  if (typeof obj.workflow !== "string" || !obj.workflow) {
    throw new UserError(
      `Invalid webhook at index ${index} in ${path}: workflow is required and must be a string`,
    );
  }
  if (typeof obj.secret !== "string" || !obj.secret) {
    throw new UserError(
      `Invalid webhook at index ${index} in ${path}: secret is required and must be a string`,
    );
  }
  if (obj.scheme !== undefined) {
    if (
      typeof obj.scheme !== "string" ||
      !(WEBHOOK_SCHEMES as readonly string[]).includes(obj.scheme)
    ) {
      throw new UserError(
        `Invalid webhook at index ${index} in ${path}: scheme must be one of ${
          WEBHOOK_SCHEMES.join(", ")
        }, got '${obj.scheme}'`,
      );
    }
    if (obj.scheme === "generic" && typeof obj.header !== "string") {
      throw new UserError(
        `Invalid webhook at index ${index} in ${path}: generic scheme requires a header name`,
      );
    }
  }
}

// ── Webhook Config to WebhookEndpoint ─────────────────────────────────

export function parseWebhookConfig(entry: WebhookConfigEntry): WebhookEndpoint {
  const secret = resolveSecret(entry.secret);
  const scheme = (entry.scheme ?? "github") as WebhookScheme;

  let verifier: VerifierConfig;
  if (scheme === "generic") {
    verifier = {
      scheme: "generic",
      header: entry.header!,
      prefix: entry.prefix ?? "",
    };
  } else {
    verifier = { scheme };
  }

  return {
    route: entry.route,
    workflowIdOrName: entry.workflow,
    secret,
    verifier,
  };
}

// ── Explicit Flag Detection ───────────────────────────────────────────

export function parseExplicitFlags(args: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;

    let flagName: string;
    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      flagName = arg.slice(2, eqIndex);
    } else {
      flagName = arg.slice(2);
    }

    if (flagName.startsWith("no-")) {
      flags.add(flagName.slice(3));
      flags.add(flagName);
    }

    flags.add(flagName);
  }
  return flags;
}

// kebab-case flag name → camelCase option name
function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Merge Logic ───────────────────────────────────────────────────────

export type EnvLookup = (name: string) => string | undefined;

export interface MergedServeOptions {
  port: number;
  host: string;
  schedule: boolean;
  certFile?: string;
  keyFile?: string;
  grantsFile?: string;
  grantsDir?: string;
  grantReload: string;
  webhook?: string[];
  webhookEndpoints?: WebhookEndpoint[];
  authMode: string;
  admins?: string;
  allowedCollectives?: string;
  allowedUsers?: string;
  oauthProvider?: string;
  oauthClientId?: string;
  groupsField?: string;
  restrictedModelTypes?: string;
  restrictedCommands?: string;
  groupRefreshInterval?: string;
  trustProxy: boolean;
  wsIdleTimeout?: string;
  queueTimeout?: string;
  verifyOnEnroll: boolean;
  trustedHosts?: string;
  detachRuns: boolean;
  heartbeatInterval?: string;
  staleTtl?: string;
  reconciliationInterval?: string;
  hotReload: boolean;
  maxConcurrentRuns?: number;
  maxRunsPerPrincipal?: number;
  maxRunDuration?: string;
  hydrationTimeout?: string;
  enableInternalApi: boolean;
}

export function mergeServeOptions(
  config: ServeConfigFile | null,
  cliOptions: Record<string, unknown>,
  explicitFlags: ReadonlySet<string>,
  envLookup: EnvLookup = (name) => Deno.env.get(name),
): MergedServeOptions {
  function resolveString(
    flagName: string,
    cliValue: string | undefined,
    configValue: string | undefined,
    defaultValue: string | undefined,
  ): string | undefined {
    if (explicitFlags.has(flagName)) {
      return cliValue;
    }

    const envVarName = SERVE_ENV_MAP[kebabToCamel(flagName)];
    if (envVarName) {
      const envValue = envLookup(envVarName);
      if (envValue !== undefined) {
        return envValue;
      }
    }

    if (configValue !== undefined) {
      return configValue;
    }

    return defaultValue;
  }

  function resolveNumber(
    flagName: string,
    cliValue: number,
    configValue: number | undefined,
    defaultValue: number,
  ): number {
    if (explicitFlags.has(flagName)) {
      return cliValue;
    }

    if (configValue !== undefined) {
      return configValue;
    }

    return defaultValue;
  }

  function resolveOptionalNumber(
    flagName: string,
    cliValue: number | undefined,
    configValue: number | undefined,
  ): number | undefined {
    if (explicitFlags.has(flagName)) {
      return cliValue;
    }

    const envVarName = SERVE_ENV_MAP[kebabToCamel(flagName)];
    if (envVarName) {
      const envValue = envLookup(envVarName);
      if (envValue !== undefined && envValue.trim() !== "") {
        const n = Number(envValue);
        if (!isNaN(n)) return n;
      }
    }

    if (configValue !== undefined) {
      return configValue;
    }

    return undefined;
  }

  function resolveBoolean(
    flagName: string,
    cliValue: boolean,
    configValue: boolean | undefined,
    defaultValue: boolean,
  ): boolean {
    if (explicitFlags.has(flagName)) {
      return cliValue;
    }

    const envVarName = SERVE_ENV_MAP[kebabToCamel(flagName)];
    if (envVarName) {
      const envValue = envLookup(envVarName);
      if (envValue !== undefined) {
        return envValue === "true" || envValue === "1";
      }
    }

    if (configValue !== undefined) {
      return configValue;
    }

    return defaultValue;
  }

  const port = resolveNumber(
    "port",
    cliOptions.port as number,
    config?.port,
    9090,
  );

  const host = resolveString(
    "host",
    cliOptions.host as string | undefined,
    config?.host,
    "127.0.0.1",
  ) ?? "127.0.0.1";

  const schedule = resolveBoolean(
    "schedule",
    cliOptions.schedule as boolean,
    config?.schedule,
    true,
  );

  const certFile = resolveString(
    "cert-file",
    cliOptions.certFile as string | undefined,
    config?.tls?.["cert-file"],
    undefined,
  );

  const keyFile = resolveString(
    "key-file",
    cliOptions.keyFile as string | undefined,
    config?.tls?.["key-file"],
    undefined,
  );

  const grantsFile = resolveString(
    "grants-file",
    cliOptions.grantsFile as string | undefined,
    config?.["grants-file"],
    undefined,
  );

  const grantsDir = resolveString(
    "grants-dir",
    cliOptions.grantsDir as string | undefined,
    config?.["grants-dir"],
    undefined,
  );

  const grantReload = resolveString(
    "grant-reload",
    cliOptions.grantReload as string | undefined,
    config?.["grant-reload"],
    "manual",
  ) ?? "manual";

  const authMode = resolveString(
    "auth-mode",
    cliOptions.authMode as string | undefined,
    config?.auth?.mode,
    "none",
  ) ?? "none";

  const admins = resolveString(
    "admins",
    cliOptions.admins as string | undefined,
    config?.auth?.admins?.join(","),
    undefined,
  );

  const allowedCollectives = resolveString(
    "allowed-collectives",
    cliOptions.allowedCollectives as string | undefined,
    config?.auth?.["allowed-collectives"]?.join(","),
    undefined,
  );

  const allowedUsers = resolveString(
    "allowed-users",
    cliOptions.allowedUsers as string | undefined,
    config?.auth?.["allowed-users"]?.join(","),
    undefined,
  );

  const oauthProvider = resolveString(
    "oauth-provider",
    cliOptions.oauthProvider as string | undefined,
    config?.auth?.["oauth-provider"],
    undefined,
  );

  const oauthClientId = resolveString(
    "oauth-client-id",
    cliOptions.oauthClientId as string | undefined,
    config?.auth?.["oauth-client-id"],
    undefined,
  );

  const groupsField = resolveString(
    "groups-field",
    cliOptions.groupsField as string | undefined,
    config?.auth?.["groups-field"],
    undefined,
  );

  const restrictedModelTypes = resolveString(
    "restricted-model-types",
    cliOptions.restrictedModelTypes as string | undefined,
    config?.auth?.["restricted-model-types"]?.join(","),
    undefined,
  );

  const restrictedCommands = resolveString(
    "restricted-commands",
    cliOptions.restrictedCommands as string | undefined,
    config?.auth?.["restricted-commands"]?.join(","),
    undefined,
  );

  const groupRefreshInterval = resolveString(
    "group-refresh-interval",
    cliOptions.groupRefreshInterval as string | undefined,
    config?.auth?.["group-refresh-interval"],
    undefined,
  );

  const trustProxy = resolveBoolean(
    "trust-proxy",
    cliOptions.trustProxy as boolean,
    config?.["trust-proxy"],
    false,
  );

  const wsIdleTimeout = resolveString(
    "ws-idle-timeout",
    cliOptions.wsIdleTimeout as string | undefined,
    config?.["ws-idle-timeout"],
    undefined,
  );

  const queueTimeout = resolveString(
    "queue-timeout",
    cliOptions.queueTimeout as string | undefined,
    config?.["queue-timeout"],
    undefined,
  );

  const verifyOnEnroll = resolveBoolean(
    "verify-on-enroll",
    cliOptions.verifyOnEnroll as boolean,
    config?.["verify-on-enroll"],
    false,
  );

  const trustedHosts = resolveString(
    "trusted-hosts",
    cliOptions.trustedHosts as string | undefined,
    config?.["trusted-hosts"]?.join(","),
    undefined,
  );

  const detachRuns = resolveBoolean(
    "detach-runs",
    cliOptions.detachRuns as boolean,
    config?.["detach-runs"],
    false,
  );

  const heartbeatInterval = resolveString(
    "heartbeat-interval",
    cliOptions.heartbeatInterval as string | undefined,
    config?.["heartbeat-interval"],
    undefined,
  );

  const staleTtl = resolveString(
    "stale-ttl",
    cliOptions.staleTtl as string | undefined,
    config?.["stale-ttl"],
    undefined,
  );

  const reconciliationInterval = resolveString(
    "reconciliation-interval",
    cliOptions.reconciliationInterval as string | undefined,
    config?.["reconciliation-interval"],
    undefined,
  );

  const hotReload = resolveBoolean(
    "hot-reload",
    cliOptions.hotReload as boolean,
    config?.["hot-reload"],
    false,
  );

  const maxConcurrentRuns = resolveOptionalNumber(
    "max-concurrent-runs",
    cliOptions.maxConcurrentRuns as number | undefined,
    config?.["max-concurrent-runs"],
  );

  const maxRunsPerPrincipal = resolveOptionalNumber(
    "max-runs-per-principal",
    cliOptions.maxRunsPerPrincipal as number | undefined,
    config?.["max-runs-per-principal"],
  );

  const maxRunDuration = resolveString(
    "max-run-duration",
    cliOptions.maxRunDuration as string | undefined,
    config?.["max-run-duration"],
    undefined,
  );

  const hydrationTimeout = resolveString(
    "hydration-timeout",
    cliOptions.hydrationTimeout as string | undefined,
    config?.["hydration-timeout"],
    undefined,
  );

  const enableInternalApi = resolveBoolean(
    "enable-internal-api",
    cliOptions.enableInternalApi as boolean,
    config?.["enable-internal-api"],
    false,
  );

  // Webhooks: CLI --webhook flags replace config file webhooks entirely
  let webhook: string[] | undefined;
  let webhookEndpoints: WebhookEndpoint[] | undefined;

  if (explicitFlags.has("webhook")) {
    webhook = cliOptions.webhook as string[] | undefined;
  } else if (config?.webhooks && config.webhooks.length > 0) {
    webhookEndpoints = config.webhooks.map(parseWebhookConfig);
  }

  return {
    port,
    host,
    schedule,
    certFile,
    keyFile,
    grantsFile,
    grantsDir,
    grantReload,
    webhook,
    webhookEndpoints,
    authMode,
    admins,
    allowedCollectives,
    allowedUsers,
    oauthProvider,
    oauthClientId,
    groupsField,
    restrictedModelTypes,
    restrictedCommands,
    groupRefreshInterval,
    trustProxy,
    wsIdleTimeout,
    queueTimeout,
    verifyOnEnroll,
    trustedHosts,
    detachRuns,
    heartbeatInterval,
    staleTtl,
    reconciliationInterval,
    hotReload,
    maxConcurrentRuns,
    maxRunsPerPrincipal,
    maxRunDuration,
    hydrationTimeout,
    enableInternalApi,
  };
}
