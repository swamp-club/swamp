// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { handleConnection } from "../../serve/connection.ts";
import { executeWorkflowWithLocks } from "../../serve/deps.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../../libswamp/mod.ts";
import { parseWebhookFlag, WebhookService } from "../../serve/webhook.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

export const serveCommand = new Command()
  .name("serve")
  .description("Start a WebSocket API server for workflow and model execution")
  .example("Start server", "swamp serve")
  .example("Custom port", "swamp serve --port 8080")
  .example(
    "Bind to all interfaces",
    "swamp serve --host 0.0.0.0 --port 3000",
  )
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--port <port:number>", "Port to listen on", { default: 9090 })
  .option("--host <host:string>", "Host to bind to", { default: "127.0.0.1" })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>",
    { collect: true },
  )
  .example(
    "Webhook trigger",
    "swamp serve --webhook '/hooks/github:my-workflow:$WEBHOOK_SECRET'",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve"]);
    const repoDir = options.repoDir as string ?? ".";
    const port = options.port as number;
    const host = options.host as string;
    const isJson = ctx.outputMode === "json";

    ctx.logger.info`Initializing repository at ${repoDir}`;

    const { repoDir: resolvedRepoDir, repoContext, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: ctx.outputMode,
      });

    if (host !== "127.0.0.1" && host !== "localhost") {
      logger.warn(
        "Binding to non-loopback address {host} — no authentication is enforced on WebSocket connections",
        { host },
      );
    }
    const connectionCtx = {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
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

    const server = Deno.serve(
      {
        port,
        hostname: host,
        signal: ac.signal,
        onListen({ hostname, port: listenPort }) {
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url: `ws://${hostname}:${listenPort}`,
              schedulingEnabled: enableSchedule,
            }));
          } else {
            logger.info("WebSocket API server listening on {host}:{port}", {
              host: hostname,
              port: listenPort,
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
      ac.abort();
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
    };
    Deno.addSignalListener("SIGINT", () => {
      shutdown().catch((e) =>
        logger.error("Shutdown error: {error}", {
          error: e instanceof Error ? e.message : String(e),
        })
      );
    });
    Deno.addSignalListener("SIGTERM", () => {
      shutdown().catch((e) =>
        logger.error("Shutdown error: {error}", {
          error: e instanceof Error ? e.message : String(e),
        })
      );
    });

    await server.finished;

    repoContext.catalogStore.close();
  });
