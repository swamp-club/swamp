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
import { CLUB_API_KEY_FILE_FLAG } from "../../infrastructure/persistence/api_key_source.ts";
import { groupCommandAction } from "../group_action.ts";
import { OAUTH_CLIENT_SECRET_FILE_FLAG } from "../../serve/oauth_client_secret_source.ts";
import { requireAuthenticated, requireScope } from "../auth_context.ts";
import {
  ADDRESS_DESCRIPTION,
  ADVERTISE_ADDRESS_DESCRIPTION,
  CLUB_API_KEY_FILE_DESCRIPTION,
  DISPATCH_ENV_ALLOW_HELP,
  RESERVED_WORKER_LABELS_HELP,
  SERVE_CA_CERT_DESCRIPTION,
} from "./serve_options.ts";
import {
  buildServeDaemonEnv,
  collectServeExtraArgs,
  daemonOAuthEnvWarnings,
  validateServeDaemonArgs,
} from "./serve_startup_settings.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const daemonEnableCommand = new Command()
  .name("enable")
  .description(
    "Enable swamp serve as a system daemon (launchd/systemd). The service " +
      "receives the flags given here and serve.yaml; the env: forms in the " +
      "option help are read by swamp serve itself and are not carried from " +
      "this shell.",
  )
  .option(
    "--user",
    "Install as a per-user service (systemd --user / launchd agent)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option("--port <port:number>", "Port for the daemon to listen on", {
    default: 9090,
  })
  .option("--host <host:string>", "Host for the daemon to bind to", {
    default: "127.0.0.1",
  })
  .option(
    "--address <url:string>",
    ADDRESS_DESCRIPTION,
  )
  .option("--advertise-address <url:string>", ADVERTISE_ADDRESS_DESCRIPTION)
  .option("--ca-cert <path:string>", SERVE_CA_CERT_DESCRIPTION)
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate (a relative path resolves against the repository)",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key (a relative path resolves against the repository)",
  )
  .option(
    "--grants-file <path:string>",
    "Path to an external grants YAML file loaded at startup (a relative path resolves against the repository); its grants are stored with source file:grants-file",
  )
  .option(
    "--grants-dir <path:string>",
    "Path to an additional directory of grants YAML files, read alongside the repository grants/ directory (a relative path resolves against the repository); their grants are stored with source file:grants-dir/<filename>",
  )
  .option(
    "--webhook-routes-dir <path:string>",
    "Directory of webhook route files, one route per YAML file, loaded at startup and on 'swamp serve reload' (default: webhook-routes; a relative path resolves against the repository; env: SWAMP_WEBHOOK_ROUTES_DIR)",
  )
  .option(
    "--webhook-routes-poll <duration:string>",
    "Poll the webhook routes directory at this interval and apply changed route files without 'swamp serve reload'; a change goes live once two polls agree, one to two intervals after it lands (default: off; minimum: 1s; env: SWAMP_WEBHOOK_ROUTES_POLL)",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "scheme is one of github (default), jira, linear, stripe, slack, generic, " +
      "or a webhook extension type (@collective/name). " +
      "Secret may use @env=VAR to read from an environment variable, " +
      "@file=/path to read from a file, or @vault=<vault>:<key> to read " +
      "from a configured vault (avoids secrets in argv). " +
      "Flag routes replace the serve config's webhooks list and stay fixed " +
      "until serve restarts; list routes under webhooks in serve.yaml to " +
      "change them with 'swamp serve reload'",
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
    "Comma-separated swamp-club usernames or user:<sub> subjects for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID, taken from this flag or serve.yaml (SWAMP_OAUTH_CLIENT_ID " +
      "in this shell is not passed to the service). When set, serve never " +
      "registers and needs the client's secret from --oauth-client-secret-file " +
      "or its stored copy; when omitted, a client is registered on first start " +
      "(headless with a collective key holding oauth:manage).",
  )
  .option(
    `${OAUTH_CLIENT_SECRET_FILE_FLAG} <path:string>`,
    "Path to a file containing the secret of the OAuth client named by " +
      "--oauth-client-id; the service reads it on every start and never " +
      "stores it. SWAMP_OAUTH_CLIENT_SECRET_FILE and SWAMP_OAUTH_CLIENT_SECRET " +
      "in this shell are not passed to the service.",
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    CLUB_API_KEY_FILE_DESCRIPTION,
  )
  .option(
    "--oauth-client-name <name:string>",
    "OAuth client name used during registration (env: SWAMP_OAUTH_CLIENT_NAME). " +
      "Defaults to swamp-serve-{repoName}-{hostname}.",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field the collectives are read from (default: collectives)",
  )
  .option(
    "--restricted-model-types <types:string>",
    "Comma-separated behavior types whose behaviors only admins may create, run, edit or delete, along with their data and the workflow steps that run them (e.g. command/shell,@acme/deploy); a leading @ is ignored when matching, so @acme/deploy and acme/deploy are the same entry. Requires --auth-mode token or oauth",
  )
  .option(
    "--restricted-commands <cmds:string>",
    "Comma-separated server commands that require admin authority (e.g. datastore.namespace.list,extension.install); names match exactly. Requires --auth-mode token or oauth",
  )
  .option(
    "--approve-requires-explicit-grant",
    "Require a grant that names approve to decide a manual approval gate; " +
      "a run grant alone no longer implies approve. Off by default. " +
      "Requires --auth-mode token or oauth " +
      "(env: SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT)",
  )
  .option(
    "--signal-requires-explicit-grant",
    "Require a grant that names signal to deliver a signal to a workflow's wait; " +
      "a run grant alone no longer implies signal. Off by default. " +
      "Requires --auth-mode token or oauth " +
      "(env: SWAMP_SIGNAL_REQUIRES_EXPLICIT_GRANT)",
  )
  .option(
    "--tag-requires-explicit-grant",
    "Require a grant that names tag to change a behavior's or workflow's tags; " +
      "a write grant alone no longer implies tag. Off by default. " +
      "Requires --auth-mode token or oauth " +
      "(env: SWAMP_TAG_REQUIRES_EXPLICIT_GRANT)",
  )
  .option(
    "--keep-oauth-client-in-vault",
    "Leave oauth-client-id and oauth-client-secret in the user vault when " +
      "moving OAuth secrets into the datastore, so a vault seeded with them " +
      "serves instances recreated with an empty datastore. Off by default: " +
      "anything that can read that vault can read the client secret " +
      "(env: SWAMP_KEEP_OAUTH_CLIENT_IN_VAULT)",
  )
  .option(
    "--group-refresh-interval <duration:string>",
    "How often to re-fetch IdP group memberships for active server tokens. " +
      "Accepts seconds (14400), explicit units (4h, 30m), or 0 to disable. Default: 4h. " +
      "Requires --auth-mode oauth (env: SWAMP_GROUP_REFRESH_INTERVAL).",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For for client IP in token auth rate limiting, and X-Forwarded-Prefix for the path prefix workers send their data plane under",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable",
  )
  .option(
    "--trusted-hosts <hosts:string>",
    "Comma-separated hostnames or host:port authorities to trust for Host and browser Origin validation, including no-auth HTTP APIs behind reverse proxies; give a public address on a port other than 443 as host:port (env: SWAMP_TRUSTED_HOSTS)",
  )
  .option(
    "--dispatch-env-allow <names:string>",
    DISPATCH_ENV_ALLOW_HELP,
  )
  .option(
    "--reserved-worker-labels <keys:string>",
    RESERVED_WORKER_LABELS_HELP,
  )
  .option(
    "--detach-runs",
    "Deprecated — HA mode is now detected automatically based on your datastore configuration. " +
      "This flag is accepted for backwards compatibility but has no effect.",
  )
  .option(
    "--heartbeat-interval <duration:string>",
    "Instance heartbeat interval (default: 30s, env: SWAMP_HEARTBEAT_INTERVAL)",
  )
  .option(
    "--stale-ttl <duration:string>",
    "Heartbeat stale TTL — instance considered dead after this (default: 90s, env: SWAMP_STALE_TTL)",
  )
  .option(
    "--reconciliation-interval <duration:string>",
    "Peer reconciliation scan interval (default: 60s, env: SWAMP_RECONCILIATION_INTERVAL)",
  )
  .option(
    "--hydration-timeout <duration:string>",
    "Startup cache hydration timeout (default: 60s, env: SWAMP_HYDRATION_TIMEOUT)",
  )
  .option(
    "--shutdown-drain-timeout <duration:string>",
    "How long shutdown waits for in-flight runs before aborting them (default: 30s, 0 aborts at once, env: SWAMP_SHUTDOWN_DRAIN_TIMEOUT)",
  )
  .option(
    "--shutdown-listener-grace <duration:string>",
    "How long serve keeps listening after /ready turns 503, so load balancers notice first; set it above the load balancer's health-check window, never more than --shutdown-drain-timeout (default: 1s, 0 with --reuse-port, env: SWAMP_SHUTDOWN_LISTENER_GRACE)",
  )
  .option(
    "--datastore-poll-interval <duration:string>",
    "Datastore poll interval (default: 30s, minimum: 1s, env: SWAMP_DATASTORE_POLL_INTERVAL)",
  )
  .option(
    "--continuation-sweep-interval <duration:string>",
    "Continuation sweep interval (default: 30s, 0 disables, env: SWAMP_CONTINUATION_SWEEP_INTERVAL)",
  )
  .option(
    "--max-signal-wait-timeout <duration:string>",
    "Longest timeout a wait_for_signal step may ask for (default: 1y, env: SWAMP_MAX_SIGNAL_WAIT_TIMEOUT)",
  )
  .option(
    "--token-gc-interval <duration:string>",
    "Server token GC interval (default: 1h, 0 disables, env: SWAMP_TOKEN_GC_INTERVAL)",
  )
  .option(
    "--token-gc-grace-period <duration:string>",
    "How long expired server tokens are kept before GC (default: 1h, 0 deletes at expiry, env: SWAMP_TOKEN_GC_GRACE_PERIOD)",
  )
  .option(
    "--remote-only",
    "Disable local (loopback) execution — all steps must declare placement " +
      "(env: SWAMP_REMOTE_ONLY)",
  )
  .option(
    "--reuse-port",
    "Listen with SO_REUSEPORT, opening the port only once startup completes, so a new process can start beside the old one (Linux; env: SWAMP_REUSE_PORT)",
  )
  .option(
    "--ws-idle-timeout <duration:string>",
    "WebSocket idle timeout (env: SWAMP_WS_IDLE_TIMEOUT). Default: 30s",
  )
  .option(
    "--queue-timeout <duration:string>",
    "Queue timeout for placed steps (env: SWAMP_QUEUE_TIMEOUT). Default: 10m",
  )
  .option(
    "--max-concurrent-runs <count:integer>",
    "Maximum concurrent detached runs across all principals. Default: 100 " +
      "(env: SWAMP_MAX_CONCURRENT_RUNS)",
  )
  .option(
    "--max-concurrent-scheduled-runs <count:integer>",
    "Maximum scheduled workflow runs in flight at once; a workflow never " +
      "overlaps itself. Default: 1 (env: SWAMP_MAX_CONCURRENT_SCHEDULED_RUNS)",
  )
  .option(
    "--max-concurrent-webhook-runs <count:integer>",
    "Maximum webhook workflow runs in flight at once, across all routes; " +
      "deliveries to the same route may overlap. Default: 1 " +
      "(env: SWAMP_MAX_CONCURRENT_WEBHOOK_RUNS)",
  )
  .option(
    "--max-runs-per-principal <count:integer>",
    "Maximum concurrent detached runs per authenticated principal " +
      "(env: SWAMP_MAX_RUNS_PER_PRINCIPAL)",
  )
  .option(
    "--max-run-duration <duration:string>",
    "Maximum wall-clock time a detached run may execute " +
      "(env: SWAMP_MAX_RUN_DURATION)",
  )
  .option(
    "--hot-reload",
    "Enable SIGHUP-based hot-reload for pulled extension bundles. " +
      "Writes a PID file to .swamp/serve.pid; use 'swamp serve reload' to trigger",
  )
  .option(
    "--enable-internal-api",
    "Enable the /internal/runs endpoint for full run history access " +
      "(env: SWAMP_ENABLE_INTERNAL_API)",
  )
  .option(
    "--dashboard",
    "Enable the web dashboard at /dashboard for this repo only, without workspace switching. " +
      "Use swamp start for local workspace switching " +
      "(env: SWAMP_DASHBOARD)",
  )
  .option(
    "--auto-resume",
    "Resume a suspended run once every approval gate on it is decided and every wait for a signal is settled. " +
      "Applies to workflows that declare no inputs; a workflow with inputs " +
      "must set autoResume: true itself, and autoResume: false opts out " +
      "(env: SWAMP_AUTO_RESUME)",
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
  .example(
    "Enable with config file",
    "swamp serve daemon enable --config /etc/swamp/serve.yaml",
  )
  .action(async function (options: AnyOptions) {
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const env = buildServeDaemonEnv();
    const { authConfig } = validateServeDaemonArgs(options, repoDir, env);
    const warnings = daemonOAuthEnvWarnings(
      (name) => Deno.env.get(name),
      options,
      authConfig,
    );
    if (authConfig.mode === "oauth" || authConfig.mode === "token") {
      requireAuthenticated("swamp serve is a team feature", "serve:*");
      requireScope("serve:*");
    }

    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "enable",
    ]);
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
      env,
    });

    renderDaemonEnabled(ctx.outputMode, toServiceMode(mode), warnings);
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

export const daemonCommand = new Command()
  .name("daemon")
  .description("Manage swamp serve as a system daemon (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", daemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);
