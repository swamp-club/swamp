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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Command } from "@cliffy/command";
import { parseLabels, vaultAnnotateCommand } from "./vault_annotate.ts";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { validateServerRequest } from "../../serve/connection.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("parseLabels: undefined input returns undefined", () => {
  const result = parseLabels(undefined);
  assertEquals(result, undefined);
});

Deno.test("parseLabels: empty array returns undefined", () => {
  const result = parseLabels([]);
  assertEquals(result, undefined);
});

Deno.test("parseLabels: single label parses correctly", () => {
  const result = parseLabels(["env=prod"]);
  assertEquals(result, { env: "prod" });
});

Deno.test("parseLabels: multiple labels parse correctly", () => {
  const result = parseLabels(["env=prod", "team=infra", "region=us-east-1"]);
  assertEquals(result, { env: "prod", team: "infra", region: "us-east-1" });
});

Deno.test("parseLabels: label with multiple = signs keeps value intact", () => {
  const result = parseLabels(["key=val=ue"]);
  assertEquals(result, { key: "val=ue" });
});

Deno.test("parseLabels: empty key throws UserError", () => {
  assertThrows(
    () => parseLabels(["=value"]),
    UserError,
    "key cannot be empty",
  );
});

Deno.test("parseLabels: missing = sign throws UserError", () => {
  assertThrows(
    () => parseLabels(["noequalssign"]),
    UserError,
    "Expected key=value",
  );
});

Deno.test("parseLabels: empty value is allowed", () => {
  const result = parseLabels(["key="]);
  assertEquals(result, { key: "" });
});

/**
 * In-process serve endpoint that records the first request frame and answers
 * it with a completed annotation — enough to drive the --server path without
 * a subprocess.
 */
function frameCapturingServer(): {
  url: string;
  shutdown: () => Promise<void>;
  frame: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          type: string;
          id: string;
        };
        captured ??= request;
        socket.send(JSON.stringify({
          type: request.type,
          id: request.id,
          payload: {
            data: {
              vaultName: "my-vault",
              secretKey: "API_KEY",
              vaultType: "local_encryption",
              fieldsUpdated: ["labels"],
              cleared: false,
              timestamp: new Date().toISOString(),
              annotation: null,
            },
          },
        }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    frame: () => captured,
  };
}

function annotateRoot() {
  return new Command()
    .globalOption("--json", "JSON output")
    .command("annotate", vaultAnnotateCommand);
}

Deno.test({
  name:
    "vaultAnnotateCommand: --server sends labels as a key-value map the server accepts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = frameCapturingServer();
    try {
      await annotateRoot().parse([
        "annotate",
        "my-vault",
        "API_KEY",
        "--label",
        "team=infra",
        "--label",
        "env=prod",
        "--json",
        "--server",
        server.url,
        "--token",
        "test.token",
      ]);
      const frame = server.frame();
      assertEquals(
        (frame?.payload as Record<string, unknown> | undefined)?.labels,
        { team: "infra", env: "prod" },
      );
      assertEquals(typeof validateServerRequest(frame), "object");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "vaultAnnotateCommand: --server rejects --clear combined with --label before sending",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = frameCapturingServer();
    try {
      await assertRejects(
        () =>
          annotateRoot().parse([
            "annotate",
            "my-vault",
            "API_KEY",
            "--clear",
            "--label",
            "team=infra",
            "--json",
            "--server",
            server.url,
            "--token",
            "test.token",
          ]),
        UserError,
        "--clear cannot be combined",
      );
      assertEquals(server.frame(), undefined);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "vaultAnnotateCommand: --server rejects a call with no annotation fields before sending",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = frameCapturingServer();
    try {
      await assertRejects(
        () =>
          annotateRoot().parse([
            "annotate",
            "my-vault",
            "API_KEY",
            "--json",
            "--server",
            server.url,
            "--token",
            "test.token",
          ]),
        UserError,
        "No annotation fields specified",
      );
      assertEquals(server.frame(), undefined);
    } finally {
      await server.shutdown();
    }
  },
});
