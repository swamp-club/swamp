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
  wsIdleTimeout: "SWAMP_WS_IDLE_TIMEOUT",
  queueTimeout: "SWAMP_QUEUE_TIMEOUT",
  verifyOnEnroll: "SWAMP_VERIFY_ON_ENROLL",
  trustedHosts: "SWAMP_TRUSTED_HOSTS",
  heartbeatInterval: "SWAMP_HEARTBEAT_INTERVAL",
  staleTtl: "SWAMP_STALE_TTL",
  reconciliationInterval: "SWAMP_RECONCILIATION_INTERVAL",
  groupRefreshInterval: "SWAMP_GROUP_REFRESH_INTERVAL",
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
  "grant-reload"?: string;
  "ws-idle-timeout"?: string;
  "queue-timeout"?: string;
  "verify-on-enroll"?: boolean;
  "heartbeat-interval"?: string;
  "stale-ttl"?: string;
  "reconciliation-interval"?: string;
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
  "grant-reload",
  "ws-idle-timeout",
  "queue-timeout",
  "verify-on-enroll",
  "heartbeat-interval",
  "stale-ttl",
  "reconciliation-interval",
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
}

export function mergeServeOptions(
  config: ServeConfigFile | null,
  cliOptions: Record<string, unknown>,
  explicitFlags: ReadonlySet<string>,
  envLookup: EnvLookup = (name) => Deno.env.get(name),
): MergedServeOptions {
  function resolve<T>(
    flagName: string,
    cliValue: T,
    configValue: T | undefined,
    defaultValue: T,
  ): T {
    if (explicitFlags.has(flagName)) {
      return cliValue;
    }

    const envVarName = SERVE_ENV_MAP[kebabToCamel(flagName)];
    if (envVarName) {
      const envValue = envLookup(envVarName);
      if (envValue !== undefined) {
        return envValue as unknown as T;
      }
    }

    if (configValue !== undefined) {
      return configValue;
    }

    return defaultValue;
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

  const port = resolve<number>(
    "port",
    cliOptions.port as number,
    config?.port,
    9090,
  );

  const host = resolve<string>(
    "host",
    cliOptions.host as string,
    config?.host,
    "127.0.0.1",
  );

  const schedule = resolveBoolean(
    "schedule",
    cliOptions.schedule as boolean,
    config?.schedule,
    true,
  );

  const certFile = resolve<string | undefined>(
    "cert-file",
    cliOptions.certFile as string | undefined,
    config?.tls?.["cert-file"],
    undefined,
  );

  const keyFile = resolve<string | undefined>(
    "key-file",
    cliOptions.keyFile as string | undefined,
    config?.tls?.["key-file"],
    undefined,
  );

  const grantReload = resolve<string>(
    "grant-reload",
    cliOptions.grantReload as string,
    config?.["grant-reload"],
    "manual",
  );

  const authMode = resolve<string>(
    "auth-mode",
    cliOptions.authMode as string,
    config?.auth?.mode,
    "none",
  );

  const admins = resolve<string | undefined>(
    "admins",
    cliOptions.admins as string | undefined,
    config?.auth?.admins?.join(","),
    undefined,
  );

  const allowedCollectives = resolve<string | undefined>(
    "allowed-collectives",
    cliOptions.allowedCollectives as string | undefined,
    config?.auth?.["allowed-collectives"]?.join(","),
    undefined,
  );

  const allowedUsers = resolve<string | undefined>(
    "allowed-users",
    cliOptions.allowedUsers as string | undefined,
    config?.auth?.["allowed-users"]?.join(","),
    undefined,
  );

  const oauthProvider = resolve<string | undefined>(
    "oauth-provider",
    cliOptions.oauthProvider as string | undefined,
    config?.auth?.["oauth-provider"],
    undefined,
  );

  const oauthClientId = resolve<string | undefined>(
    "oauth-client-id",
    cliOptions.oauthClientId as string | undefined,
    config?.auth?.["oauth-client-id"],
    undefined,
  );

  const groupsField = resolve<string | undefined>(
    "groups-field",
    cliOptions.groupsField as string | undefined,
    config?.auth?.["groups-field"],
    undefined,
  );

  const restrictedModelTypes = resolve<string | undefined>(
    "restricted-model-types",
    cliOptions.restrictedModelTypes as string | undefined,
    config?.auth?.["restricted-model-types"]?.join(","),
    undefined,
  );

  const groupRefreshInterval = resolve<string | undefined>(
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

  const wsIdleTimeout = resolve<string | undefined>(
    "ws-idle-timeout",
    cliOptions.wsIdleTimeout as string | undefined,
    config?.["ws-idle-timeout"],
    undefined,
  );

  const queueTimeout = resolve<string | undefined>(
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

  const trustedHosts = resolve<string | undefined>(
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

  const heartbeatInterval = resolve<string | undefined>(
    "heartbeat-interval",
    cliOptions.heartbeatInterval as string | undefined,
    config?.["heartbeat-interval"],
    undefined,
  );

  const staleTtl = resolve<string | undefined>(
    "stale-ttl",
    cliOptions.staleTtl as string | undefined,
    config?.["stale-ttl"],
    undefined,
  );

  const reconciliationInterval = resolve<string | undefined>(
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
  };
}
