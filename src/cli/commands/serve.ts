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
import { handleConnection } from "../../serve/connection.ts";
import { executeWorkflowWithLocks } from "../../serve/deps.ts";
import { CapabilityService } from "../../serve/capability_service.ts";
import { WorkerGateway } from "../../serve/worker_gateway.ts";
import { DispatchService } from "../../serve/dispatch_service.ts";
import { DispatchRegistry } from "../../serve/dispatch_registry.ts";
import { BundleRegistry } from "../../serve/bundle_registry.ts";
import { DataPlane } from "../../serve/data_plane.ts";
import { setRemoteStepDispatcher } from "../../domain/remote/remote_dispatch.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../../libswamp/mod.ts";
import { parseWebhookFlag, WebhookService } from "../../serve/webhook.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

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
    "Bind to all interfaces",
    "swamp serve --host 0.0.0.0 --port 3000",
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
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>",
    { collect: true },
  )
  .example(
    "Enable TLS",
    "swamp serve --cert-file server.crt --key-file server.key",
  )
  .example(
    "Webhook trigger",
    "swamp serve --webhook '/hooks/github:my-workflow:$WEBHOOK_SECRET'",
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

    if (host !== "127.0.0.1" && host !== "localhost") {
      logger.warn(
        "Binding to non-loopback address {host} — no authentication is enforced on WebSocket connections",
        { host },
      );
    }
    // Remote-execution control plane: capability verbs, worker enrollment,
    // and the dispatch/lease registries shared with the HTTP data plane.
    // See design/remote-execution.md.
    const capabilityService = new CapabilityService({
      repoDir: resolvedRepoDir,
      repoContext,
    });
    const dispatchRegistry = new DispatchRegistry();
    const bundleRegistry = new BundleRegistry();
    const dispatchService = new DispatchService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
    });
    const workerGateway = new WorkerGateway({
      repoDir: resolvedRepoDir,
      repoContext,
      capabilityService,
      onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
      onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
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

    const connectionCtx = {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
      workerGateway,
    };

    // Eagerly load extension registries so failures surface at startup
    // rather than silently on first scheduled/webhook execution.
    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      datastoreTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

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
          }));
        } else {
          logger.info(
            "Webhook registered: {route} → {workflow}",
            { route: ep.route, workflow: ep.workflowIdOrName },
          );
        }
      }
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
      async (req) => {
        // WebSocket upgrade (check first — upgrade requests are also GETs)
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          handleConnection(socket, connectionCtx);
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
  });
