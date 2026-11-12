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

import { assertEquals, assertExists } from "@std/assert";
import {
  createCommandTelemetry,
  createControlTelemetry,
  createRunTelemetry,
  setServeCollectivesSource,
} from "./telemetry.ts";
import { UserError } from "../domain/errors.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import type { TelemetryEntry } from "../domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../domain/telemetry/repositories.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../cli/telemetry_integration.ts";

class CapturingRepository implements TelemetryRepository {
  saved: TelemetryEntry[] = [];

  save(entry: TelemetryEntry): Promise<void> {
    this.saved.push(entry);
    return Promise.resolve();
  }
  findByDate(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  findByDateRange(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  deleteAllOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  findUnflushed(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  markFlushed(): Promise<boolean> {
    return Promise.resolve(true);
  }
  quarantine(): Promise<void> {
    return Promise.resolve();
  }
  deleteQuarantinedOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

const TARGET = { modelName: "enricher", methodName: "enrich" };

async function withActiveService(
  fn: (repo: CapturingRepository) => Promise<void>,
): Promise<void> {
  const repo = new CapturingRepository();
  setActiveTelemetryService(new TelemetryService(repo, "1.0.0"));
  try {
    await fn(repo);
  } finally {
    clearActiveTelemetryService();
  }
}

Deno.test("createRunTelemetry: returns undefined when telemetry is disabled", () => {
  clearActiveTelemetryService();
  assertEquals(createRunTelemetry("schedule", "nightly"), undefined);
});

Deno.test("createRunTelemetry: records a success parent entry on finish(null)", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("schedule", "nightly");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved.length, 1);
    const parent = repo.saved[0];
    assertEquals(parent.invocation.command, "workflow");
    assertEquals(parent.invocation.subcommand, "run");
    assertEquals(parent.result.status, "success");
    assertEquals(parent.triggerSource, "schedule");
  });
});

Deno.test("createRunTelemetry: records an error parent entry on finish(error)", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("webhook", "nightly");
    assertExists(telemetry);

    await telemetry.finish(new Error("step failed"));

    assertEquals(repo.saved.length, 1);
    assertEquals(repo.saved[0].result.status, "error");
    assertEquals(repo.saved[0].result.errorMessage, "step failed");
    assertEquals(repo.saved[0].triggerSource, "webhook");
  });
});

Deno.test("createRunTelemetry: children carry the run's parent invocation id", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("api", "nightly");
    assertExists(telemetry);

    await telemetry.sink.recordChildInvocation(
      {
        command: "model",
        subcommand: "method",
        args: ["run", "enricher", "enrich"],
        optionKeys: [],
        globalOptions: [],
      },
      new Date(),
      new Date(),
      null,
      telemetry.sink.parentInvocationId,
      {
        workflowName: "nightly",
        runId: "run-1",
        jobName: "main",
        stepName: "enrich",
      },
    );
    await telemetry.finish(null);

    const child = repo.saved[0];
    const parent = repo.saved[1];
    assertEquals(child.parentInvocationId, telemetry.sink.parentInvocationId);
    // The parent is the run itself, not the daemon's process invocation —
    // that entry is not written until serve exits, possibly weeks later.
    assertEquals(parent.id, telemetry.sink.parentInvocationId);
    assertEquals(child.triggerSource, "api");
  });
});

Deno.test("createRunTelemetry: each run gets a distinct parent identity", async () => {
  await withActiveService(() => {
    const first = createRunTelemetry("schedule", "nightly");
    const second = createRunTelemetry("schedule", "nightly");
    assertExists(first);
    assertExists(second);

    assertEquals(
      first.sink.parentInvocationId === second.sink.parentInvocationId,
      false,
    );
    return Promise.resolve();
  });
});

Deno.test("createRunTelemetry: the parent entry sends the workflow name", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("schedule", "nightly");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved[0].invocation.args, ["nightly"]);
    assertEquals(repo.saved[0].invocation.commandPath, ["workflow", "run"]);
    assertEquals("commandSpelling" in repo.saved[0].toData().invocation, false);
  });
});

Deno.test("createRunTelemetry: stamps initiatedBy on parent and child entries", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("api", "nightly", {
      initiatedBy: "user:abc-123",
    });
    assertExists(telemetry);

    await telemetry.sink.recordChildInvocation(
      {
        command: "model",
        subcommand: "method",
        args: ["run", "enricher", "enrich"],
        optionKeys: [],
        globalOptions: [],
      },
      new Date(),
      new Date(),
      null,
      telemetry.sink.parentInvocationId,
      {
        workflowName: "nightly",
        runId: "run-1",
        jobName: "main",
        stepName: "enrich",
      },
    );
    await telemetry.finish(null);

    const child = repo.saved[0];
    const parent = repo.saved[1];
    assertEquals(parent.initiatedBy, "user:abc-123");
    assertEquals(child.initiatedBy, "user:abc-123");
  });
});

Deno.test("createRunTelemetry: omits initiatedBy when not provided", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("schedule", "nightly");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved[0].initiatedBy, undefined);
  });
});

Deno.test("createCommandTelemetry: returns undefined when telemetry is disabled", () => {
  clearActiveTelemetryService();
  assertEquals(
    createCommandTelemetry(TARGET, { initiatedBy: "user:test" }),
    undefined,
  );
});

Deno.test("createCommandTelemetry: records a success entry with initiatedBy", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createCommandTelemetry(TARGET, {
      initiatedBy: "user:abc-123",
    });
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved.length, 1);
    const entry = repo.saved[0];
    assertEquals(entry.invocation.command, "model");
    assertEquals(entry.invocation.subcommand, "method run");
    assertEquals(entry.invocation.args, ["enricher", "enrich"]);
    assertEquals(entry.invocation.commandPath, ["model", "method", "run"]);
    assertEquals("commandSpelling" in entry.toData().invocation, false);
    assertEquals(entry.result.status, "success");
    assertEquals(entry.initiatedBy, "user:abc-123");
    assertEquals(entry.triggerSource, "api");
  });
});

Deno.test("createCommandTelemetry: records an error entry with initiatedBy", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createCommandTelemetry(TARGET, {
      initiatedBy: "user:abc-123",
    });
    assertExists(telemetry);

    await telemetry.finish(new Error("method failed"));

    assertEquals(repo.saved.length, 1);
    assertEquals(repo.saved[0].result.status, "error");
    assertEquals(repo.saved[0].result.errorMessage, "method failed");
    assertEquals(repo.saved[0].initiatedBy, "user:abc-123");
  });
});

Deno.test("createRunTelemetry: carries the client kind, integration id and serve collectives", async () => {
  const restore = setServeCollectivesSource(() => ["acme"]);
  try {
    await withActiveService(async (repo) => {
      const telemetry = createRunTelemetry("api", "nightly", {
        initiatedBy: "user:u1",
        client: "integration:acme-slack",
      });
      assertExists(telemetry);
      await telemetry.finish(null);

      const data = repo.saved[0].toData();
      assertEquals(data.client, "integration");
      assertEquals(data.integrationId, "acme-slack");
      assertEquals(data.serveCollectives, ["acme"]);
      assertEquals(data.initiatedBy, "user:u1");
    });
  } finally {
    restore();
  }
});

Deno.test("createCommandTelemetry: a direct client sends its kind, no id, and no empty collectives", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createCommandTelemetry(TARGET, {
      client: "direct:dashboard",
    });
    assertExists(telemetry);
    await telemetry.finish(null);

    const data = repo.saved[0].toData();
    assertEquals(data.client, "direct:dashboard");
    assertEquals("integrationId" in data, false);
    assertEquals("serveCollectives" in data, false);
  });
});

Deno.test("createCommandTelemetry: an integration or group behavior sends its type and no error message", async () => {
  await withActiveService(async (repo) => {
    const ceiling = createCommandTelemetry({
      modelName: "integration-acme-slack",
      methodName: "ceiling",
    });
    assertExists(ceiling);
    ceiling.resolveType("swamp/integration");
    await ceiling.finish(
      new UserError("Integration 'acme-slack' was revoked"),
    );

    const addMember = createCommandTelemetry({
      modelName: "payroll-admins",
      methodName: "add-member",
    });
    assertExists(addMember);
    addMember.resolveType("swamp/group");
    await addMember.finish(new Error("Group 'payroll-admins' does not exist"));

    const [first, second] = repo.saved.map((entry) => entry.toData());
    assertEquals(first.invocation.args, ["@swamp/integration", "ceiling"]);
    assertEquals(first.result, {
      status: "user_error",
      errorType: "UserError",
      exitCode: 1,
    });
    assertEquals(second.invocation.args, ["@swamp/group", "add-member"]);
    assertEquals(second.result.errorMessage, undefined);
    const sent = JSON.stringify(repo.saved.map((entry) => entry.toData()));
    assertEquals(sent.includes("acme-slack"), false);
    assertEquals(sent.includes("payroll-admins"), false);
  });
});

Deno.test("createCommandTelemetry: an integration name is concealed before its type resolves, and other types keep their name", async () => {
  await withActiveService(async (repo) => {
    const unresolved = createCommandTelemetry({
      modelName: "integration-acme-slack",
      methodName: "revoke",
    });
    assertExists(unresolved);
    await unresolved.finish(new Error("Integration 'acme-slack' not found"));

    const plain = createCommandTelemetry(TARGET);
    assertExists(plain);
    plain.resolveType("acme/enricher");
    await plain.finish(new Error("enrich failed"));

    const [first, second] = repo.saved.map((entry) => entry.toData());
    assertEquals(first.invocation.args, ["<REDACTED>", "revoke"]);
    assertEquals(first.result.errorMessage, undefined);
    assertEquals(second.invocation.args, ["enricher", "enrich"]);
    assertEquals(second.result.errorMessage, "enrich failed");
  });
});

Deno.test("createControlTelemetry: each action records one event with its command path and outcome", async () => {
  const restore = setServeCollectivesSource(() => ["acme", "beta"]);
  try {
    await withActiveService(async (repo) => {
      const caller = {
        initiatedBy: "user:u1",
        client: "integration:acme-slack",
      };
      const approve = createControlTelemetry("approve", caller);
      await approve.finish({ status: "success" });
      await approve.finish({ status: "error", errorType: "internal" });

      await createControlTelemetry("resume", caller).finish({
        status: "user_error",
        errorType: "resume_inputs_refused",
      });
      await createControlTelemetry("method cancel", caller).finish({
        status: "success",
      });
      await createControlTelemetry("cancel all", caller).finish({
        status: "success",
        cancelledCount: 4,
      });
      createControlTelemetry("signal", caller).discard();

      const sent = repo.saved.map((entry) => entry.toData());
      assertEquals(
        sent.map((data) => data.invocation.commandPath),
        [
          ["workflow", "approve"],
          ["workflow", "resume"],
          ["model", "method", "cancel"],
          ["cancel", "all"],
        ],
      );
      assertEquals(sent[0].result.status, "success");
      assertEquals(sent[1].result, {
        status: "user_error",
        errorType: "resume_inputs_refused",
        exitCode: 1,
      });
      assertEquals(sent[3].cancelledCount, 4);
      for (const data of sent) {
        assertEquals(data.invocation.args, []);
        assertEquals(data.triggerSource, "api");
        assertEquals(data.initiatedBy, "user:u1");
        assertEquals(data.client, "integration");
        assertEquals(data.integrationId, "acme-slack");
        assertEquals(data.serveCollectives, ["acme", "beta"]);
      }
    });
  } finally {
    restore();
  }
});

Deno.test("createControlTelemetry: records nothing when telemetry is disabled", async () => {
  clearActiveTelemetryService();
  await createControlTelemetry("approve", {}).finish({ status: "success" });
});
