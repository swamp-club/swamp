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

import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/model_validate_test.ts
// These tests verify the command module loads correctly

Deno.test("modelValidateCommand module loads", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(modelValidateCommand.getName(), "validate");
});

Deno.test("modelValidateCommand has correct description", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(
    modelValidateCommand.getDescription(),
    "Validate a model definition against its schema",
  );
});

/**
 * In-process serve endpoint answering every request frame with the given
 * payload — enough to drive the command's request/response --server path
 * without a subprocess.
 */
function payloadServer(
  payload: Record<string, unknown>,
): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const request = JSON.parse(event.data as string) as {
          type: string;
          id: string;
        };
        socket.send(
          JSON.stringify({ type: request.type, id: request.id, payload }),
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

/** Runs `model validate` against a scripted validation result; returns Deno.exitCode. */
async function runModelValidateAgainst(
  data: Record<string, unknown>,
): Promise<number> {
  const server = payloadServer({ data });
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { modelValidateCommand } = await import("./model_validate.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("validate", modelValidateCommand);
    await root.parse([
      "validate",
      "my-server",
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
    ]);
    return Deno.exitCode;
  } finally {
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

Deno.test({
  name: "modelValidateCommand: sets Deno.exitCode 1 when validation fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runModelValidateAgainst({
        modelName: "my-server",
        passed: false,
        validations: [
          { name: "schema", passed: false, message: "missing field" },
        ],
      }),
      1,
    );
  },
});

Deno.test({
  name: "modelValidateCommand: leaves Deno.exitCode 0 when validation passes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runModelValidateAgainst({
        modelName: "my-server",
        passed: true,
        validations: [{ name: "schema", passed: true }],
      }),
      0,
    );
  },
});
