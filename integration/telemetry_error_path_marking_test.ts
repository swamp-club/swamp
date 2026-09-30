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

/**
 * A path an error marks reaches the telemetry spool fully redacted, even when
 * its last segment has a space and it is not a value the command line or a
 * known directory supplied (swamp-club#2830). The error comes from a real
 * repository on a temp filesystem and travels each route that turns an error
 * into a string and back: the CLI's SwampError flattening, the workflow step
 * bridge, and a remote worker's dispatch result.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { markErrorPaths, UserError } from "../src/domain/errors.ts";
import { DispatchResultSchema } from "../src/domain/remote/protocol.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../src/infrastructure/persistence/json_telemetry_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { userErrorFromSwampError } from "../src/libswamp/mod.ts";
import {
  buildChildInvocation,
  WorkflowTelemetryBridge,
} from "../src/libswamp/workflows/telemetry_bridge.ts";

/** A vault id, and so a file name, whose last word the patterns cannot bound. */
const VAULT_ID = "final report";

interface Fixture {
  repoDir: string;
  spoolDir: string;
  /** A real error naming the broken vault file. */
  vaultError: Error;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-error-paths-" });
  try {
    const repoDir = join(dir, "repo");
    const typeDir = join(repoDir, "vaults", "local_encryption");
    await ensureDir(typeDir);
    await Deno.writeTextFile(
      join(typeDir, `${VAULT_ID}.yaml`),
      "name: [broken\n  : : :\n",
    );
    const vaultError = await assertRejects(() =>
      new YamlVaultConfigRepository(repoDir).findById(
        "local_encryption",
        VAULT_ID,
      )
    );
    assert(vaultError instanceof Error);
    await fn({ repoDir, spoolDir: join(dir, "spool"), vaultError });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function spooledErrorMessages(spoolDir: string): Promise<string[]> {
  const messages: string[] = [];
  for await (const entry of Deno.readDir(spoolDir)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const data = JSON.parse(
      await Deno.readTextFile(join(spoolDir, entry.name)),
    ) as { result?: { errorMessage?: string } };
    if (data.result?.errorMessage) messages.push(data.result.errorMessage);
  }
  return messages;
}

function assertFullyRedacted(message: string): void {
  assert(message.includes("<PATH>"), `no <PATH> in: ${message}`);
  assertEquals(message.includes("report"), false, message);
  assertEquals(message.includes("vaults"), false, message);
}

Deno.test("error path marking: a CLI-flattened stream error is spooled without its path", async () => {
  await withFixture(async ({ repoDir, spoolDir, vaultError }) => {
    const service = new TelemetryService(
      new JsonTelemetryRepository(repoDir, spoolDir),
      "test",
    );
    // As model method run reports a failure: a SwampError whose cause is the
    // thrown error, rebuilt by the renderer into the UserError runCli sees.
    const error = userErrorFromSwampError({
      code: "method_execution_failed",
      message: `Method execution failed: ${vaultError.message}`,
      cause: vaultError,
    });
    assert(error instanceof UserError);

    await service.recordError(
      buildChildInvocation("vaulted", "run"),
      new Date(),
      error,
    );

    const messages = await spooledErrorMessages(spoolDir);
    assertEquals(messages.length, 1);
    assertFullyRedacted(messages[0]);
  });
});

Deno.test("error path marking: a workflow step failure is spooled without its path", async () => {
  await withFixture(async ({ repoDir, spoolDir, vaultError }) => {
    const service = new TelemetryService(
      new JsonTelemetryRepository(repoDir, spoolDir),
      "test",
    );
    const bridge = new WorkflowTelemetryBridge({
      parentInvocationId: service.invocationId,
      recordChildInvocation: service.recordChildInvocation.bind(service),
    });

    // As the execution service reports a model-method step that threw.
    await bridge.observe({
      kind: "step_failed",
      jobId: "job",
      stepId: "step",
      runId: "run-1",
      error: vaultError.message,
      modelName: "vaulted",
      methodName: "run",
      errorPaths: [(vaultError as { path?: string }).path ?? ""],
    });
    await bridge.finalize();

    const messages = await spooledErrorMessages(spoolDir);
    assertEquals(messages.length, 1);
    assertFullyRedacted(messages[0]);
  });
});

Deno.test("error path marking: a remote worker's failure is spooled without its path", async () => {
  await withFixture(async ({ repoDir, spoolDir, vaultError }) => {
    const service = new TelemetryService(
      new JsonTelemetryRepository(repoDir, spoolDir),
      "test",
    );
    // The runner's result crosses the wire as JSON and the orchestrator
    // parses it with the protocol schema, as the worker gateway does.
    const wire = JSON.stringify({
      status: "error",
      error: vaultError.message,
      errorPaths: [(vaultError as { path?: string }).path],
      outputs: [],
      logs: [],
      durationMs: 1,
    });
    const result = DispatchResultSchema.parse(JSON.parse(wire));
    const error = markErrorPaths(
      new Error(result.error ?? "Remote execution failed"),
      result.errorPaths ?? [],
    );

    await service.recordError(
      buildChildInvocation("vaulted", "run"),
      new Date(),
      error,
    );

    const messages = await spooledErrorMessages(spoolDir);
    assertEquals(messages.length, 1);
    assertFullyRedacted(messages[0]);
  });
});
