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

// The workflow.trigger handlers read and write the config file serve was
// started with (ctx.serveConfigPath, the resolved --config), not
// <repo>/.swamp/serve.yaml, and get reports what the scheduler applies
// (swamp-club#2468, #2472).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../src/libswamp/mod.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

function data(frames: Frame[]): Record<string, unknown> {
  assertEquals(frames.length, 1);
  return (frames[0].payload as { data: Record<string, unknown> }).data;
}

async function withConfigFile(
  fn: (repo: ServeRepo, configPath: string, configDir: string) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const configDir = join(repo.repoDir, "mounted-config");
    await Deno.mkdir(configDir);
    const configPath = join(configDir, "serve.yaml");
    await Deno.writeTextFile(
      configPath,
      [
        "port: 9191",
        "triggers:",
        "  sweep:",
        '    schedule: "21 7 * * *"',
        "    inputs:",
        "      target: production",
        "",
      ].join("\n"),
    );
    await fn(repo, configPath, configDir);
  });
}

function ctxFor(repo: ServeRepo, configPath: string): ConnectionContext {
  return { ...createServeCtx(repo), serveConfigPath: configPath };
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
  return parseYaml(await Deno.readTextFile(path)) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("workflow.trigger.get: reports the override in the --config file", async () => {
  await withConfigFile(async (repo, configPath) => {
    const frames = await sendRequest(
      ctxFor(repo, configPath),
      request("workflow.trigger.get", { workflowName: "sweep" }),
    );
    assertEquals(data(frames).override, {
      schedule: "21 7 * * *",
      inputs: { target: "production" },
    });
  });
});

Deno.test("workflow.trigger.set: writes the --config file, not .swamp/serve.yaml", async () => {
  await withConfigFile(async (repo, configPath) => {
    const frames = await sendRequest(
      ctxFor(repo, configPath),
      request("workflow.trigger.set", {
        workflowName: "report",
        schedule: "0 8 * * *",
      }),
    );
    assertEquals(frames.map((f) => f.type), ["workflow.trigger.set"]);

    const written = await readYaml(configPath);
    assertEquals(written.port, 9191);
    assertEquals(written.triggers, {
      sweep: { schedule: "21 7 * * *", inputs: { target: "production" } },
      report: { schedule: "0 8 * * *" },
    });
    assertEquals(
      await exists(join(repo.repoDir, ".swamp", "serve.yaml")),
      false,
    );
  });
});

Deno.test("workflow.trigger.remove: removes the override from the --config file", async () => {
  await withConfigFile(async (repo, configPath) => {
    const frames = await sendRequest(
      ctxFor(repo, configPath),
      request("workflow.trigger.remove", { workflowName: "sweep" }),
    );
    assertEquals(frames.map((f) => f.type), ["workflow.trigger.remove"]);

    const written = await readYaml(configPath);
    assertEquals(written.port, 9191);
    assertEquals(written.triggers, undefined);
  });
});

Deno.test("workflow.trigger.get: reports the scheduler's override when the file differs", async () => {
  await withConfigFile(async (repo, configPath) => {
    const scheduledExecution = new ScheduledExecutionService({
      workflowRepo: repo.repoContext.workflowRepo,
      repoDir: repo.repoDir,
      executeWorkflow: () => Promise.resolve(),
      triggerOverrides: new Map([["sweep", { schedule: "44 10 * * *" }]]),
    });
    const frames = await sendRequest(
      { ...ctxFor(repo, configPath), scheduledExecution },
      request("workflow.trigger.get", { workflowName: "sweep" }),
    );
    assertEquals(data(frames).override, { schedule: "44 10 * * *" });
  });
});

Deno.test({
  name:
    "workflow.trigger.set: refuses when the --config file cannot be written and leaves the scheduler unchanged",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withConfigFile(async (repo, configPath, configDir) => {
      await Deno.chmod(configDir, 0o555);
      try {
        // Mode bits do not stop root; skip rather than fail there.
        const probe = join(configDir, ".probe");
        try {
          await Deno.writeTextFile(probe, "");
          await Deno.remove(probe);
          return;
        } catch {
          // Read-only, as intended.
        }

        const original = { schedule: "21 7 * * *" };
        const scheduledExecution = new ScheduledExecutionService({
          workflowRepo: repo.repoContext.workflowRepo,
          repoDir: repo.repoDir,
          executeWorkflow: () => Promise.resolve(),
          triggerOverrides: new Map([["sweep", original]]),
        });
        const before = await Deno.readTextFile(configPath);

        const frames = await sendRequest(
          { ...ctxFor(repo, configPath), scheduledExecution, hotReload: true },
          request("workflow.trigger.set", {
            workflowName: "sweep",
            schedule: "44 10 * * *",
          }),
        );

        const error = errorFrame(frames)?.error;
        assertEquals(error?.code, "workflow_trigger_set_failed");
        assertStringIncludes(error?.message ?? "", "swamp serve reload");

        const removeFrames = await sendRequest(
          ctxFor(repo, configPath),
          request("workflow.trigger.remove", { workflowName: "sweep" }),
        );
        const removeError = errorFrame(removeFrames)?.error;
        assertEquals(removeError?.code, "workflow_trigger_remove_failed");
        assertStringIncludes(removeError?.message ?? "", "restart serve");
        assertEquals(scheduledExecution.getTriggerOverride("sweep"), original);
        assertEquals(await Deno.readTextFile(configPath), before);
      } finally {
        await Deno.chmod(configDir, 0o755);
      }
    });
  },
});
