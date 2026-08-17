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
import { createCommandTelemetry, createRunTelemetry } from "./telemetry.ts";
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

/** Installs an active service for the duration of `fn`. */
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
  // --no-telemetry, the marker opt-out, the user-level opt-out, and an init
  // failure all leave no active service. Serve must then stay exactly as
  // silent as it was before any of this was wired.
  clearActiveTelemetryService();
  assertEquals(createRunTelemetry("schedule"), undefined);
});

Deno.test("createRunTelemetry: records a success parent entry on finish(null)", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("schedule");
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
    const telemetry = createRunTelemetry("webhook");
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
    const telemetry = createRunTelemetry("api");
    assertExists(telemetry);

    await telemetry.sink.recordChildInvocation(
      {
        command: "model",
        subcommand: "method",
        args: ["run", "<REDACTED>", "enrich"],
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
    const first = createRunTelemetry("schedule");
    const second = createRunTelemetry("schedule");
    assertExists(first);
    assertExists(second);

    assertEquals(
      first.sink.parentInvocationId === second.sink.parentInvocationId,
      false,
    );
    return Promise.resolve();
  });
});

Deno.test("createRunTelemetry: the parent entry redacts the workflow name", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("schedule");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved[0].invocation.args, ["<REDACTED>"]);
  });
});

Deno.test("createRunTelemetry: stamps initiatedBy on parent and child entries", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createRunTelemetry("api", {
      initiatedBy: "user:abc-123",
    });
    assertExists(telemetry);

    await telemetry.sink.recordChildInvocation(
      {
        command: "model",
        subcommand: "method",
        args: ["run", "<REDACTED>", "enrich"],
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
    const telemetry = createRunTelemetry("schedule");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved[0].initiatedBy, undefined);
  });
});

Deno.test("createCommandTelemetry: returns undefined when telemetry is disabled", () => {
  clearActiveTelemetryService();
  assertEquals(createCommandTelemetry("user:test"), undefined);
});

Deno.test("createCommandTelemetry: records a success entry with initiatedBy", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createCommandTelemetry("user:abc-123");
    assertExists(telemetry);

    await telemetry.finish(null);

    assertEquals(repo.saved.length, 1);
    const entry = repo.saved[0];
    assertEquals(entry.invocation.command, "model");
    assertEquals(entry.invocation.subcommand, "method run");
    assertEquals(entry.result.status, "success");
    assertEquals(entry.initiatedBy, "user:abc-123");
    assertEquals(entry.triggerSource, "api");
  });
});

Deno.test("createCommandTelemetry: records an error entry with initiatedBy", async () => {
  await withActiveService(async (repo) => {
    const telemetry = createCommandTelemetry("user:abc-123");
    assertExists(telemetry);

    await telemetry.finish(new Error("method failed"));

    assertEquals(repo.saved.length, 1);
    assertEquals(repo.saved[0].result.status, "error");
    assertEquals(repo.saved[0].result.errorMessage, "method failed");
    assertEquals(repo.saved[0].initiatedBy, "user:abc-123");
  });
});
