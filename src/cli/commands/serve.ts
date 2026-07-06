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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseTimeout } from "../duration_parser.ts";
import { buildServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { handleConnection } from "../../serve/connection.ts";
import { authenticateServerToken } from "../../serve/token_auth.ts";
import { parsePrincipal } from "../../domain/access/principal.ts";
import { executeWorkflowWithLocks } from "../../serve/deps.ts";
import { CapabilityService } from "../../serve/capability_service.ts";
import { WorkerGateway } from "../../serve/worker_gateway.ts";
import { dispatchFleetProbe } from "../../serve/fleet_probe_dispatch.ts";
import { DispatchService } from "../../serve/dispatch_service.ts";
import { DispatchRegistry } from "../../serve/dispatch_registry.ts";
import { BundleRegistry } from "../../serve/bundle_registry.ts";
import { DataPlane } from "../../serve/data_plane.ts";
import { setRemoteStepDispatcher } from "../../domain/remote/remote_dispatch.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  createServiceScheduler,
  resolveServiceMode,
} from "../../infrastructure/daemon/service_scheduler_factory.ts";
import {
  renderDaemonDisabled,
  renderDaemonEnabled,
  renderDaemonStatus,
  toServiceMode,
} from "../../presentation/output/serve_daemon_output.ts";
import { groupCommandAction } from "../group_action.ts";
import { ScheduledExecutionService } from "../../libswamp/mod.ts";
import { parseWebhookFlag, WebhookService } from "../../serve/webhook.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { RunCancelRegistry } from "../../serve/run_cancel_registry.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  type PolicyReloadMode,
  PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import {
  createAdminGrantStore,
  materializeAdmins,
  migrateGrantDefinitions,
} from "../../domain/access/admin_materializer.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { GRANT_MODEL_TYPE } from "../../domain/models/access/grant_model.ts";
import { cleanupEmptyParentDirs } from "../../infrastructure/persistence/directory_cleanup.ts";
import { join } from "@std/path";
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { sweepStaleRecords } from "../../serve/boot_reconciliation.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function sweepExpiredEntries(): void {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (now > entry.resetAt) authAttempts.delete(ip);
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (authAttempts.size >= MAX_RATE_LIMIT_ENTRIES) sweepExpiredEntries();
    if (authAttempts.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldest = authAttempts.keys().next().value!;
      authAttempts.delete(oldest);
    }
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_AUTH_ATTEMPTS;
}

function clearRateLimit(ip: string): void {
  const entry = authAttempts.get(ip);
  if (entry) {
    entry.count = 0;
  }
}

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

export function validateWebSocketOrigin(
  origin: string | null,
  hostHeader: string | null,
  bindHost: string,
  tlsEnabled: boolean,
): { allowed: boolean; reason?: string } {
  if (origin) {
    const TRUSTED_ORIGINS = new Set([
      "http://127.0.0.1",
      "http://localhost",
      "https://127.0.0.1",
      "https://localhost",
      "http://[::1]",
      "https://[::1]",
    ]);
    if (tlsEnabled) {
      TRUSTED_ORIGINS.add(`https://${bindHost.toLowerCase()}`);
    }

    let originBase: string;
    try {
      const originUrl = new URL(origin);
      originBase = `${originUrl.protocol}//${originUrl.hostname}`;
    } catch {
      return { allowed: false, reason: `malformed origin: ${origin}` };
    }

    if (!TRUSTED_ORIGINS.has(originBase)) {
      return { allowed: false, reason: `untrusted origin: ${origin}` };
    }
  }

  // Only validate Host header when binding off-loopback (direct exposure).
  // When bound to loopback, a reverse proxy on the same machine handles
  // external connections and forwards the public domain as the Host header —
  // this is the documented production deployment model (Caddy, nginx).
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
  if (hostHeader && !LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    let hostName: string;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      hostName = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return { allowed: false, reason: `malformed host: ${hostHeader}` };
    }
    const TRUSTED_HOSTS = new Set([
      "127.0.0.1",
      "localhost",
      "::1",
      bindHost.toLowerCase(),
    ]);
    if (!TRUSTED_HOSTS.has(hostName)) {
      return { allowed: false, reason: `untrusted host: ${hostHeader}` };
    }
  }

  return { allowed: true };
}

export function collectServeExtraArgs(options: AnyOptions): string[] {
  const args: string[] = [];
  if (options.schedule === false) {
    args.push("--no-schedule");
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
  if (options.groupsField) {
    args.push("--groups-field", options.groupsField as string);
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
  return args;
}

const daemonEnableCommand = new Command()
  .name("enable")
  .description("Enable swamp serve as a system daemon (launchd/systemd)")
  .option(
    "--user",
    "Install as a per-user service (systemd --user / launchd agent)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--port <port:number>", "Port for the daemon to listen on", {
    default: 9090,
  })
  .option("--host <host:string>", "Host for the daemon to bind to", {
    default: "127.0.0.1",
  })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "Secret may use @env=VAR to read from an environment variable or " +
      "@file=/path to read from a file (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated principal IDs for admin access",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated user identifiers for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID (required for oauth mode)",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable",
  )
  .example("Enable daemon", "swamp serve daemon enable")
  .example(
    "Enable with custom port",
    "swamp serve daemon enable --port 8080",
  )
  .example(
    "Enable with TLS and auth",
    "swamp serve daemon enable --cert-file cert.pem --key-file key.pem --auth-mode token",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "enable",
    ]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });
    const extraArgs = collectServeExtraArgs(options);

    await scheduler.enable({
      binaryPath: Deno.execPath(),
      repoDir,
      port: options.port as number,
      host: options.host as string,
      certFile: options.certFile as string | undefined,
      keyFile: options.keyFile as string | undefined,
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    });

    renderDaemonEnabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonDisableCommand = new Command()
  .name("disable")
  .description("Disable and remove the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Disable daemon", "swamp serve daemon disable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "disable",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    await scheduler.disable();

    renderDaemonDisabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonStatusCommand = new Command()
  .name("status")
  .description("Show the status of the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Check daemon status", "swamp serve daemon status")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "status",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    const status = await scheduler.status();

    renderDaemonStatus(status, ctx.outputMode, toServiceMode(mode));
  });

const daemonCommand = new Command()
  .name("daemon")
  .description("Manage swamp serve as a system daemon (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", daemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);

export const serveCommand = new Command()
  .name("serve")
  .description(
    "Start a WebSocket API server for workflow and model execution.\n\n" +
      "Service deployments: swamp loads all extensions — including " +
      "already-pulled repo extensions — through an embedded runtime under the " +
      "user's home directory (~/.swamp). When running under a service manager " +
      "such as systemd, ensure HOME (or USERPROFILE on Windows) is set in the " +
      "unit environment, e.g. `Environment=HOME=/root`. Without it, scheduled " +
      'workflow runs fail with "Unknown model type" for pulled extension ' +
      "types.",
  )
  .example("Start server", "swamp serve")
  .example("Custom port", "swamp serve --port 8080")
  .example(
    "Bind to all interfaces (TLS + auth required)",
    "swamp serve --host 0.0.0.0 --port 3000 --cert-file server.crt --key-file server.key --auth-mode token",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--port <port:number>", "Port to listen on", { default: 9090 })
  .option("--host <host:string>", "Host to bind to", { default: "127.0.0.1" })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate (env: SWAMP_SERVE_CERT_FILE)",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key (env: SWAMP_SERVE_KEY_FILE)",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "scheme is one of github (default), linear, stripe, slack, generic; " +
      "generic requires a header name and accepts an optional value prefix. " +
      "Secret may use @env=VAR to read from an environment variable or " +
      "@file=/path to read from a file (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated principal IDs for admin access (e.g. user:oauth|user-123)",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated user identifiers for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID (required for oauth mode)",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting (enable when behind a reverse proxy)",
  )
  .option(
    "--ws-idle-timeout <duration:string>",
    "WebSocket idle timeout — how long the server waits for a pong before closing the connection (env: SWAMP_WS_IDLE_TIMEOUT). " +
      "Accepts seconds (30), explicit units (2m, 5m), or 0 to disable. Default: 30s",
  )
  .option(
    "--queue-timeout <duration:string>",
    "How long a placed step queues for a matching worker before timing out (env: SWAMP_QUEUE_TIMEOUT). " +
      "Accepts seconds (60), explicit units (2m, 10m), or 0 to disable. Default: 10m",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable — workers that fail are marked unverified (env: SWAMP_VERIFY_ON_ENROLL)",
  )
  .example(
    "Enable TLS",
    "swamp serve --cert-file server.crt --key-file server.key",
  )
  .example(
    "Token auth",
    "swamp serve --auth-mode token --admins 'user:oauth|user-123'",
  )
  .example(
    "Webhook (secret from env var)",
    "swamp serve --webhook '/hooks/github:my-workflow:@env=WEBHOOK_SECRET'",
  )
  .example(
    "Webhook (secret from file)",
    "swamp serve --webhook '/hooks/github:my-workflow:@file=/run/secrets/webhook'",
  )
  .example(
    "Webhook with a provider scheme",
    "swamp serve --webhook '/hooks/linear:my-workflow:@env=LINEAR_SECRET:linear' " +
      "--webhook '/hooks/custom:my-workflow:@env=CUSTOM_SECRET:generic:X-Signature:sha256='",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve"]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const port = options.port as number;
    const host = options.host as string;
    const isJson = ctx.outputMode === "json";

    const certFile = (options.certFile as string | undefined) ??
      Deno.env.get("SWAMP_SERVE_CERT_FILE") ?? undefined;
    const keyFile = (options.keyFile as string | undefined) ??
      Deno.env.get("SWAMP_SERVE_KEY_FILE") ?? undefined;

    if ((certFile && !keyFile) || (!certFile && keyFile)) {
      throw new Error(
        "Both --cert-file and --key-file must be provided together for TLS",
      );
    }

    let cert: string | undefined;
    let key: string | undefined;
    if (certFile && keyFile) {
      cert = await Deno.readTextFile(certFile);
      key = await Deno.readTextFile(keyFile);
    }
    const tlsEnabled = cert !== undefined;
    const trustProxy = options.trustProxy === true;

    const wsIdleTimeoutRaw = (options.wsIdleTimeout as string | undefined) ??
      Deno.env.get("SWAMP_WS_IDLE_TIMEOUT") ?? undefined;
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

    const queueTimeoutRaw = (options.queueTimeout as string | undefined) ??
      Deno.env.get("SWAMP_QUEUE_TIMEOUT") ?? undefined;
    let queueTimeoutMs: number | undefined;
    if (queueTimeoutRaw !== undefined) {
      const normalized = queueTimeoutRaw.trim().replace(/^0[smhdw].*$/i, "0");
      queueTimeoutMs = normalized === "0"
        ? 0
        : parseTimeout(queueTimeoutRaw, "--queue-timeout");
    }

    const authConfig = buildServeAuthConfig({
      authMode: options.authMode as string | undefined,
      admins: options.admins as string | undefined,
      allowedCollectives: options.allowedCollectives as string | undefined,
      allowedUsers: options.allowedUsers as string | undefined,
      oauthProvider: options.oauthProvider as string | undefined,
      oauthClientId: options.oauthClientId as string | undefined,
      groupsField: options.groupsField as string | undefined,
    });

    if (authConfig.mode === "none" && authConfig.admins.length > 0) {
      logger.warn(
        "--admins is set but --auth-mode is {mode} — admins will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (authConfig.mode === "none") {
      logger.warn(
        "auth-mode is 'none' — this mode is deprecated and will be removed in a future release. " +
          "Use --auth-mode token for authenticated access. " +
          "See https://swamp-club.com/manual/how-to/swamp-serve/set-up-token-auth",
      );
    }

    assertOffLoopbackSecurity(host, tlsEnabled, authConfig.mode);

    ctx.logger.info`Initializing repository at ${repoDir}`;

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: ctx.outputMode,
    });
    // Remote-execution control plane: capability verbs, worker enrollment,
    // and the dispatch/lease registries shared with the HTTP data plane.
    // See design/remote-execution.md.
    const dispatchRegistry = new DispatchRegistry();
    const capabilityService = new CapabilityService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
    });
    const bundleRegistry = new BundleRegistry();
    const dispatchService = new DispatchService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      queueTimeoutMs,
    });
    const verifyOnEnroll = options.verifyOnEnroll === true ||
      Deno.env.get("SWAMP_VERIFY_ON_ENROLL") === "true";
    const workerGateway = new WorkerGateway({
      repoDir: resolvedRepoDir,
      repoContext,
      capabilityService,
      onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
      onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
      onWorkerEnrolled: (worker) =>
        dispatchService.notifyWorkerEnrolled(worker),
      onWorkerDraining: (worker) =>
        dispatchService.notifyWorkerDraining(worker),
      verifyOnEnroll,
      verifyWorker: verifyOnEnroll
        ? async (workerName) => {
          const probe = await dispatchFleetProbe(
            dispatchService,
            repoContext.unifiedDataRepo,
            workerName,
            "verify-on-enroll",
            AbortSignal.timeout(60_000),
          );
          if (probe.status === "pass") {
            return { ok: true };
          }
          return {
            ok: false,
            failureReason: probe.status === "error"
              ? probe.error ?? "probe error"
              : (probe.failures ?? []).join("; ") || "probe failed",
          };
        }
        : undefined,
    });
    dispatchService.bindGateway(workerGateway);
    setRemoteStepDispatcher(dispatchService);
    const dataPlane = new DataPlane({
      repoDir: resolvedRepoDir,
      repoContext,
      sessions: workerGateway.sessions,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
    });
    dispatchService.setOnDispatchEnd((dispatchId) =>
      dataPlane.releaseDispatch(dispatchId)
    );

    // Eagerly load extension registries so failures surface at startup
    // rather than silently on first scheduled/webhook execution.
    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      datastoreTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

    const grantReloadMode = options.grantReload as string;
    if (grantReloadMode !== "manual" && grantReloadMode !== "auto") {
      throw new UserError(
        `Invalid --grant-reload value "${grantReloadMode}": must be "manual" or "auto"`,
      );
    }

    const serveEventBus = new EventBus();

    const modelsDir = join(resolvedRepoDir, "models");
    const autoDefDir = repoContext.autoDefinitionsDir;
    const grantTypeDir = GRANT_MODEL_TYPE.toDirectoryPath();
    const grantSourceDir = join(modelsDir, grantTypeDir);
    const migrationResult = await migrateGrantDefinitions(
      grantSourceDir,
      join(autoDefDir, grantTypeDir),
    );
    if (migrationResult.moved > 0) {
      logger
        .info`Migrated ${migrationResult.moved} grant definition(s) from models/ to .swamp/auto-definitions/`;
      await cleanupEmptyParentDirs(
        join(grantSourceDir, "_placeholder"),
        modelsDir,
      );
    }

    const autoDefRepo = new YamlDefinitionRepository(
      resolvedRepoDir,
      undefined,
      autoDefDir,
      false,
    );
    const adminGrantStore = createAdminGrantStore(
      repoContext.definitionRepo,
      autoDefRepo,
      repoContext.unifiedDataRepo,
    );
    const materializeResult = await materializeAdmins(
      authConfig.mode,
      authConfig.admins,
      adminGrantStore,
    );
    if (
      materializeResult.created > 0 || materializeResult.revoked > 0 ||
      materializeResult.reactivated > 0
    ) {
      logger
        .info`Admin grants materialized: ${materializeResult.created} created, ${materializeResult.revoked} revoked, ${materializeResult.reactivated} reactivated, ${materializeResult.unchanged} unchanged`;
    }

    const policySnapshotLoader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      serveEventBus,
      grantReloadMode as PolicyReloadMode,
    );
    await policySnapshotLoader.load();
    logger.info("Policy snapshot loaded (reload mode: {mode})", {
      mode: grantReloadMode,
    });

    const cancelRegistry = new RunCancelRegistry();

    // Reap orphaned runs left in "running" state by a previous daemon.
    // Workflow runs still use YAML-based reaping (tracker wiring deferred to #519).
    const reapCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentRuns = await repoContext.workflowRunRepo.findAllGlobalSince(
      reapCutoff,
    );
    for (const { run, workflowId } of recentRuns) {
      if (run.status === "running") {
        logger.warn(
          "Reaping orphaned workflow run {runId} (workflow: {workflowName})",
          { runId: run.id, workflowName: run.workflowName },
        );
        run.cancel("daemon restarted");
        await repoContext.workflowRunRepo.save(workflowId, run);
      }
    }

    // Model method runs use the SQLite run tracker for stale detection.
    const runTracker = RunTrackerStore.fromSwampDir(
      swampPath(resolvedRepoDir),
    );
    const reapedRuns = runTracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);
    for (const run of reapedRuns) {
      logger.warn`Reaped stale model method run ${run.id} (method: ${
        run.methodName ?? "unknown"
      })`;
    }

    const swept = await sweepStaleRecords({
      repoDir: resolvedRepoDir,
      repoContext,
    });
    if (swept.leases + swept.pendingDispatches + swept.workers > 0) {
      logger.info(
        "Boot reconciliation: swept {leases} lease(s), {pendingDispatches} pending dispatch(es), {workers} worker(s)",
        {
          leases: swept.leases,
          pendingDispatches: swept.pendingDispatches,
          workers: swept.workers,
        },
      );
    }

    const datastoreResolver = new DefaultDatastorePathResolver(
      resolvedRepoDir,
      datastoreConfig,
    );
    const connectionCtx: import("../../serve/connection.ts").ConnectionContext =
      {
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
        workerGateway,
        policySnapshotLoader,
        authConfig,
        cancelRegistry,
        runTracker,
        dispatchService,
      };

    const ac = new AbortController();
    const enableSchedule = options.schedule !== false;
    const webhookFlags: string[] = options.webhook ?? [];

    // Start scheduled execution service if enabled
    let scheduledExecution: ScheduledExecutionService | null = null;
    if (enableSchedule) {
      scheduledExecution = new ScheduledExecutionService({
        workflowRepo: repoContext.workflowRepo,
        repoDir: resolvedRepoDir,
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            resolvedRepoDir,
            repoContext,
            datastoreConfig,
            input,
            signal,
            onEvent,
            syncService,
            runTracker,
          ),
      });

      await scheduledExecution.start((event) => {
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "schedule_registered":
              logger.info(
                "Scheduled workflow {name} ({cron})",
                { name: event.workflowName, cron: event.cronExpression },
              );
              break;
            case "schedule_unregistered":
              logger.info(
                "Unregistered scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_fired":
              logger.info(
                "Running scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_skipped":
              logger.warn(
                "Skipped scheduled workflow {name}: {reason}",
                { name: event.workflowName, reason: event.reason },
              );
              break;
            case "schedule_completed":
              logger.info(
                "Scheduled workflow {name} completed (run: {runId})",
                { name: event.workflowName, runId: event.runId },
              );
              break;
            case "schedule_failed":
              logger.error(
                "Scheduled workflow {name} failed: {error}",
                { name: event.workflowName, error: event.error },
              );
              break;
          }
        }
      });
    }

    // Parse and initialize webhook endpoints
    let webhookService: WebhookService | null = null;
    if (webhookFlags.length > 0) {
      const endpoints = webhookFlags.map(parseWebhookFlag);
      webhookService = new WebhookService({
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        endpoints,
        syncService,
      });

      webhookService.setEventHandler((event) => {
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "webhook_received":
              logger.info(
                "Webhook received on {route} for workflow {workflow}",
                { route: event.route, workflow: event.workflowName },
              );
              break;
            case "webhook_rejected":
              logger.warn(
                "Webhook rejected on {route}: {reason}",
                { route: event.route, reason: event.reason },
              );
              break;
            case "webhook_queued":
              logger.info(
                "Webhook queued workflow {workflow}",
                { workflow: event.workflowName },
              );
              break;
            case "webhook_completed":
              logger.info(
                "Webhook workflow {workflow} completed (run: {runId})",
                { workflow: event.workflowName, runId: event.runId },
              );
              break;
            case "webhook_failed":
              logger.error(
                "Webhook workflow {workflow} failed: {error}",
                { workflow: event.workflowName, error: event.error },
              );
              break;
          }
        }
      });

      for (const ep of endpoints) {
        if (isJson) {
          console.log(JSON.stringify({
            kind: "webhook_registered",
            route: ep.route,
            workflow: ep.workflowIdOrName,
            scheme: ep.verifier.scheme,
          }));
        } else {
          logger.info(
            "Webhook registered: {route} → {workflow} (scheme: {scheme})",
            {
              route: ep.route,
              workflow: ep.workflowIdOrName,
              scheme: ep.verifier.scheme,
            },
          );
        }
      }
    }

    const wsUpgradeOpts: Deno.UpgradeWebSocketOptions = {};
    if (wsIdleTimeoutSeconds !== undefined) {
      wsUpgradeOpts.idleTimeout = wsIdleTimeoutSeconds;
    }

    const wsScheme = tlsEnabled ? "wss" : "ws";
    const server = Deno.serve(
      {
        port,
        hostname: host,
        signal: ac.signal,
        cert,
        key,
        onListen({ hostname, port: listenPort }) {
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url: `${wsScheme}://${hostname}:${listenPort}`,
              schedulingEnabled: enableSchedule,
            }));
          } else {
            logger.info("WebSocket API server listening on {url}", {
              url: `${wsScheme}://${hostname}:${listenPort}`,
            });
          }
        },
      },
      async (req, info) => {
        // WebSocket upgrade (check first — upgrade requests are also GETs)
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const remoteAddr = trustProxy
            ? (req.headers.get("x-forwarded-for")
              ?.split(",")[0]?.trim() ??
              info.remoteAddr.hostname)
            : info.remoteAddr.hostname;

          const originCheck = validateWebSocketOrigin(
            req.headers.get("origin"),
            req.headers.get("host"),
            host,
            tlsEnabled,
          );
          if (!originCheck.allowed) {
            logger.warn(
              "WebSocket upgrade rejected: {reason} from {ip}",
              { reason: originCheck.reason, ip: remoteAddr },
            );
            return new Response(
              `Forbidden: ${originCheck.reason}`,
              { status: 403 },
            );
          }

          if (authConfig.mode !== "none") {
            if (authConfig.mode !== "token") {
              return new Response(
                "WebSocket authentication is not supported for this server configuration",
                { status: 501 },
              );
            }

            if (!checkRateLimit(remoteAddr)) {
              logger.warn("WebSocket auth rate-limited from {ip}", {
                ip: remoteAddr,
              });
              return new Response("Too Many Requests", { status: 429 });
            }

            const url = new URL(req.url);
            const tokenParam = url.searchParams.get("token");
            url.searchParams.delete("token");
            if (!tokenParam) {
              logger.warn(
                "WebSocket auth rejected: no token provided from {ip}",
                { ip: remoteAddr },
              );
              return new Response("Unauthorized: token required", {
                status: 401,
              });
            }
            const result = await authenticateServerToken(
              tokenParam,
              resolvedRepoDir,
              repoContext,
            );
            if (!result.ok) {
              logger.warn(
                "WebSocket auth rejected from {ip}: {error}",
                { ip: remoteAddr, error: result.error },
              );
              return new Response("Unauthorized", { status: 401 });
            }
            clearRateLimit(remoteAddr);
            const principal = parsePrincipal(result.principalId);
            const { socket, response } = Deno.upgradeWebSocket(
              req,
              wsUpgradeOpts,
            );
            handleConnection(socket, connectionCtx, principal);
            return response;
          }
          const { socket, response } = Deno.upgradeWebSocket(
            req,
            wsUpgradeOpts,
          );
          handleConnection(socket, connectionCtx, null);
          return response;
        }

        // Remote-execution data plane (bearer-authenticated worker routes)
        const dataPlaneResponse = await dataPlane.handle(req);
        if (dataPlaneResponse) return dataPlaneResponse;

        // Webhook endpoints (POST only, checked before health)
        if (webhookService && req.method === "POST") {
          const webhookResponse = await webhookService.handleRequest(req);
          if (webhookResponse) return webhookResponse;
        }

        // Cancel endpoint (authenticated — same auth as WebSocket)
        if (req.method === "POST") {
          const url = new URL(req.url);
          const cancelMatch = url.pathname.match(
            /^\/api\/v1\/cancel\/(workflow-run|method-run)\/([^/]+)$/,
          );
          const isBulkCancel = url.pathname === "/api/v1/cancel";
          if (cancelMatch || isBulkCancel) {
            if (authConfig.mode !== "none") {
              const authHeader = req.headers.get("authorization");
              const token = authHeader?.startsWith("Bearer ")
                ? authHeader.slice(7)
                : null;
              if (!token) {
                return new Response("Unauthorized: token required", {
                  status: 401,
                });
              }
              const authResult = await authenticateServerToken(
                token,
                resolvedRepoDir,
                repoContext,
              );
              if (!authResult.ok) {
                return new Response("Unauthorized", { status: 401 });
              }
            }
          }
          if (cancelMatch) {
            const executionType = cancelMatch[1] as
              | "workflow-run"
              | "method-run";
            const executionId = cancelMatch[2];
            // Check cancel registry first (WebSocket ad-hoc and webhook runs)
            let found = cancelRegistry.cancel(executionType, executionId);
            // For workflow runs, also check scheduled execution service
            if (
              !found && executionType === "workflow-run" && scheduledExecution
            ) {
              found = scheduledExecution.cancelByRunId(executionId);
            }
            if (found) {
              return Response.json({
                status: "cancelled",
                executionType,
                executionId,
              });
            }
            return Response.json({
              status: "not_found",
              message:
                `No active ${executionType} with id ${executionId} in this serve instance`,
            }, { status: 404 });
          }
          if (url.pathname === "/api/v1/cancel") {
            const body = await req.json().catch(() => ({}));
            const typeFilter = typeof body.executionType === "string"
              ? body.executionType
              : undefined;
            if (
              typeFilter && typeFilter !== "workflow-run" &&
              typeFilter !== "method-run"
            ) {
              return Response.json({
                status: "error",
                message: "executionType must be 'workflow-run' or 'method-run'",
              }, { status: 400 });
            }
            let count = cancelRegistry.cancelAll(typeFilter);
            if (
              (!typeFilter || typeFilter === "workflow-run") &&
              scheduledExecution
            ) {
              count += scheduledExecution.cancelAllRuns();
            }
            return Response.json({ status: "cancelled", count });
          }
        }

        // Health check endpoint
        if (req.method === "GET") {
          const url = new URL(req.url);
          if (url.pathname === "/" || url.pathname === "/health") {
            const schedules = scheduledExecution?.listSchedules().map((s) => ({
              workflowId: s.workflowId,
              cronExpression: s.cronExpression,
              nextRun: s.nextRun?.toISOString() ?? null,
              running: scheduledExecution!.isRunning(s.workflowId),
            })) ?? [];

            const webhooks = webhookService
              ? webhookService.listEndpoints().map((ep) => ({
                route: ep.route,
                workflow: ep.workflowIdOrName,
                scheme: ep.scheme,
              }))
              : [];

            return Response.json({
              status: "ok",
              version: "1",
              scheduling: {
                enabled: enableSchedule,
                schedules,
              },
              webhooks,
            });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    );

    // Handle SIGINT/SIGTERM for graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (isJson) {
        console.log(JSON.stringify({ status: "stopping" }));
      }
      logger.info("Shutting down...");
      if (webhookService) {
        await webhookService.stop();
      }
      if (scheduledExecution) {
        await scheduledExecution.stop();
      }
      await policySnapshotLoader.dispose();
      setRemoteStepDispatcher(null);
      ac.abort();
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
    };
    registerShutdownHandler({
      handler: () => {
        shutdown().catch((e) =>
          logger.error("Shutdown error: {error}", {
            error: e instanceof Error ? e.message : String(e),
          })
        );
      },
    });

    await server.finished;

    repoContext.catalogStore.close();
  })
  .command("daemon", daemonCommand);
