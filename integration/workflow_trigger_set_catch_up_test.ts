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

import "../src/domain/models/models.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { Command } from "@cliffy/command";
import { UserError } from "../src/domain/errors.ts";
import { workflowTriggerSetCommand } from "../src/cli/commands/workflow_trigger_set.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

function versionedTriggerServer(capabilities: string[] | undefined): {
  url: string;
  shutdown: () => Promise<void>;
  requests: { type: string; payload?: Record<string, unknown> }[];
} {
  const requests: { type: string; payload?: Record<string, unknown> }[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          type: string;
          id: string;
          payload?: Record<string, unknown>;
        };
        requests.push({ type: request.type, payload: request.payload });
        if (request.type === "server.version") {
          socket.send(JSON.stringify({
            type: "server.version",
            id: request.id,
            payload: {
              version: "test",
              gitSha: "test",
              ...(capabilities ? { capabilities } : {}),
            },
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: "workflow.trigger.set",
          id: request.id,
          payload: {
            data: {
              workflowName: request.payload?.workflowName,
              entry: {
                schedule: request.payload?.schedule,
                ...(request.payload?.catchUp
                  ? { catchUp: request.payload.catchUp }
                  : {}),
              },
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
    requests,
  };
}

async function triggerSetOverServer(
  url: string,
  extra: string[],
): Promise<void> {
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("set", workflowTriggerSetCommand);
  await root.parse([
    "set",
    "nightly",
    "--json",
    "--schedule",
    "0 3 * * *",
    ...extra,
    "--server",
    url,
    "--token",
    "test.token",
  ]);
}

const CATCH_UP_FLAGS = ["--catch-up", "latest", "--catch-up-max-delay", "6h"];

Deno.test({
  name:
    "workflowTriggerSetCommand: --catch-up is refused by a server that does not list schedule-catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (
      const capabilities of [undefined, ["literal-inputs", "resume-from-job"]]
    ) {
      const server = versionedTriggerServer(capabilities);
      try {
        await assertRejects(
          () => triggerSetOverServer(server.url, CATCH_UP_FLAGS),
          UserError,
          "does not support --catch-up",
        );
        // an older serve would save the override without its catch-up
        assertEquals(server.requests.map((r) => r.type), ["server.version"]);
      } finally {
        await server.shutdown();
      }
    }
  },
});

Deno.test({
  name:
    "workflowTriggerSetCommand: --catch-up none is refused by a server that does not list schedule-catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = versionedTriggerServer(undefined);
    try {
      await assertRejects(
        () => triggerSetOverServer(server.url, ["--catch-up", "none"]),
        UserError,
        "does not support --catch-up",
      );
      assertEquals(server.requests.map((r) => r.type), ["server.version"]);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "workflowTriggerSetCommand: --catch-up is sent to a server that lists schedule-catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = versionedTriggerServer(["schedule-catch-up"]);
    try {
      await triggerSetOverServer(server.url, CATCH_UP_FLAGS);
      assertEquals(server.requests.map((r) => r.type), [
        "server.version",
        "workflow.trigger.set",
      ]);
      assertEquals(server.requests[1].payload?.catchUp, {
        policy: "latest",
        maxDelay: "6h",
      });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "workflowTriggerSetCommand: without --catch-up an older server gets the override and no probe",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = versionedTriggerServer(undefined);
    try {
      await triggerSetOverServer(server.url, []);
      assertEquals(server.requests.map((r) => r.type), [
        "workflow.trigger.set",
      ]);
      assertEquals(server.requests[0].payload?.catchUp, undefined);
    } finally {
      await server.shutdown();
    }
  },
});
