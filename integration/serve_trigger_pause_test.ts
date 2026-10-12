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

// workflow.trigger.set pauses and resumes a workflow's schedule: the pause is
// kept in the trigger override in the config file serve was started with, the
// scheduler applies it, get reports it, and the audit trail records it as a
// pause or resume rather than one more override write.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ScheduledExecutionService } from "../src/libswamp/workflows/scheduled_execution.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
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
  fn: (repo: ServeRepo, configPath: string) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const configPath = join(repo.repoDir, "serve.yaml");
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
    await fn(repo, configPath);
  });
}

function ctxFor(repo: ServeRepo, configPath: string): ConnectionContext {
  return { ...createServeCtx(repo), serveConfigPath: configPath };
}

async function triggersIn(path: string): Promise<unknown> {
  const parsed = parseYaml(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  return parsed.triggers;
}

Deno.test("workflow.trigger.set: paused alone keeps the override's schedule and inputs", async () => {
  await withConfigFile(async (repo, configPath) => {
    const scheduledExecution = new ScheduledExecutionService({
      workflowRepo: repo.repoContext.workflowRepo,
      repoDir: repo.repoDir,
      executeWorkflow: () => Promise.resolve(),
    });
    const frames = await sendRequest(
      { ...ctxFor(repo, configPath), scheduledExecution },
      request("workflow.trigger.set", { workflowName: "sweep", paused: true }),
    );
    const expected = {
      schedule: "21 7 * * *",
      inputs: { target: "production" },
      paused: true,
    };
    assertEquals(data(frames), { workflowName: "sweep", entry: expected });
    assertEquals(await triggersIn(configPath), { sweep: expected });
    assertEquals(scheduledExecution.getTriggerOverride("sweep"), expected);
  });
});

Deno.test("workflow.trigger.get: reports the pause in the override and the effective trigger", async () => {
  await withConfigFile(async (repo, configPath) => {
    const ctx = ctxFor(repo, configPath);
    await sendRequest(
      ctx,
      request("workflow.trigger.set", { workflowName: "report", paused: true }),
    );
    const frames = await sendRequest(
      ctx,
      request("workflow.trigger.get", { workflowName: "report" }),
    );
    const result = data(frames);
    assertEquals(result.override, { paused: true });
    assertEquals(result.effective, {
      schedule: null,
      inputs: {},
      paused: true,
    });

    const unpaused = data(
      await sendRequest(
        ctx,
        request("workflow.trigger.get", { workflowName: "sweep" }),
      ),
    );
    assertEquals(
      (unpaused.effective as { paused: boolean }).paused,
      false,
    );
  });
});

Deno.test("workflow.trigger.set: resuming a paused-only override removes it", async () => {
  await withConfigFile(async (repo, configPath) => {
    const ctx = ctxFor(repo, configPath);
    await sendRequest(
      ctx,
      request("workflow.trigger.set", { workflowName: "report", paused: true }),
    );
    const frames = await sendRequest(
      ctx,
      request("workflow.trigger.set", {
        workflowName: "report",
        paused: false,
      }),
    );
    assertEquals(data(frames), { workflowName: "report", entry: {} });
    assertEquals(await triggersIn(configPath), {
      sweep: { schedule: "21 7 * * *", inputs: { target: "production" } },
    });
  });
});

Deno.test("workflow.trigger.set: a new schedule keeps the pause", async () => {
  await withConfigFile(async (repo, configPath) => {
    const ctx = ctxFor(repo, configPath);
    await sendRequest(
      ctx,
      request("workflow.trigger.set", { workflowName: "sweep", paused: true }),
    );
    await sendRequest(
      ctx,
      request("workflow.trigger.set", {
        workflowName: "sweep",
        schedule: "0 9 * * *",
      }),
    );
    assertEquals(await triggersIn(configPath), {
      sweep: { schedule: "0 9 * * *", paused: true },
    });
  });
});

Deno.test("workflow.trigger.remove: removes a paused override, resuming the built-in schedule", async () => {
  await withConfigFile(async (repo, configPath) => {
    const ctx = ctxFor(repo, configPath);
    await sendRequest(
      ctx,
      request("workflow.trigger.set", { workflowName: "report", paused: true }),
    );
    const frames = await sendRequest(
      ctx,
      request("workflow.trigger.remove", { workflowName: "report" }),
    );
    assertEquals(frames.map((f) => f.type), ["workflow.trigger.remove"]);
    assertEquals(await triggersIn(configPath), {
      sweep: { schedule: "21 7 * * *", inputs: { target: "production" } },
    });
  });
});

Deno.test("workflow.trigger.set: refuses a payload with neither schedule nor paused, or inputs without a schedule", async () => {
  await withConfigFile(async (repo, configPath) => {
    const before = await Deno.readTextFile(configPath);
    const ctx = ctxFor(repo, configPath);
    const empty = await sendRequest(
      ctx,
      request("workflow.trigger.set", { workflowName: "sweep" }),
    );
    assertEquals(errorFrame(empty)?.error?.code, "invalid_request");
    const inputsOnly = await sendRequest(
      ctx,
      request("workflow.trigger.set", {
        workflowName: "sweep",
        paused: true,
        inputs: { target: "staging" },
      }),
    );
    assertEquals(errorFrame(inputsOnly)?.error?.code, "invalid_request");
    assertEquals(await Deno.readTextFile(configPath), before);
  });
});

Deno.test("workflow.trigger.set: pausing needs write on the workflow", async () => {
  await withConfigFile(async (repo, configPath) => {
    const before = await Deno.readTextFile(configPath);
    const ctxWith = (actions: string[]) =>
      ({
        ...createServeCtx(repo, [
          grant({
            resource: { kind: "workflow", pattern: "*" },
            actions: actions as ReturnType<typeof grant>["actions"],
          }),
        ]),
        serveConfigPath: configPath,
      }) as ConnectionContext;

    const denied = await sendRequest(
      ctxWith(["read"]),
      request("workflow.trigger.set", { workflowName: "sweep", paused: true }),
    );
    assertEquals(errorFrame(denied)?.error?.code, "unauthorized");
    assertEquals(await Deno.readTextFile(configPath), before);

    const allowed = await sendRequest(
      ctxWith(["read", "write"]),
      request("workflow.trigger.set", { workflowName: "sweep", paused: true }),
    );
    assertEquals(errorFrame(allowed), undefined);
  });
});

Deno.test("workflow.trigger.set: a pause and a resume are audited as such", async () => {
  await withConfigFile(async (repo, configPath) => {
    const audit: AuditEvent[] = [];
    const ctx = {
      ...ctxFor(repo, configPath),
      instanceId: "inst-1",
      auditEmitter: { emit: (event: AuditEvent) => audit.push(event) },
    } as unknown as ConnectionContext;
    for (
      const payload of [{ paused: true }, { paused: false }, {
        schedule: "0 9 * * *",
      }]
    ) {
      await sendRequest(
        ctx,
        request("workflow.trigger.set", { workflowName: "sweep", ...payload }),
      );
    }
    await waitFor(() => audit.length === 3, "three audit events");
    assertEquals(audit.map((e) => [e.action, e.outcome, e.resourceName]), [
      ["workflow.trigger.pause", "success", "sweep"],
      ["workflow.trigger.resume", "success", "sweep"],
      ["workflow.trigger.set", "success", "sweep"],
    ]);
  });
});
