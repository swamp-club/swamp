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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("parseInputFlag: parses key=value", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  const result = parseInputFlag("channel=#security");
  assertEquals(result, { key: "channel", value: "#security" });
});

Deno.test("parseInputFlag: handles values with equals signs", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  const result = parseInputFlag("expr=a=b=c");
  assertEquals(result, { key: "expr", value: "a=b=c" });
});

Deno.test("parseInputFlag: throws on missing equals", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseInputFlag("no-equals"),
    Error,
    "Invalid --input format",
  );
});

Deno.test("parseInputFlag: throws on empty key", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseInputFlag("=value"),
    Error,
    "Invalid --input format",
  );
});

Deno.test("workflowTriggerSetCommand: has correct name and options", async () => {
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
  assertEquals(workflowTriggerSetCommand.getName(), "set");

  const options = workflowTriggerSetCommand.getOptions();
  const scheduleOpt = options.find((o) => o.name === "schedule");
  assertEquals(scheduleOpt !== undefined, true);

  const inputOpt = options.find((o) => o.name === "input");
  assertEquals(inputOpt !== undefined, true);
});

Deno.test("parseCatchUpFlags: no flags is no catch-up", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertEquals(parseCatchUpFlags(undefined, undefined), undefined);
});

Deno.test("parseCatchUpFlags: builds a catch-up from policy and max delay", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertEquals(parseCatchUpFlags("latest", "6h"), {
    policy: "latest",
    maxDelay: "6h",
  });
  assertEquals(parseCatchUpFlags("none", undefined), { policy: "none" });
});

Deno.test("parseCatchUpFlags: a max delay without a policy is a user error", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags(undefined, "6h"),
    UserError,
    "--catch-up-max-delay requires --catch-up latest",
  );
});

Deno.test("parseCatchUpFlags: an unknown policy names --catch-up", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags("sometimes", undefined),
    UserError,
    "Invalid --catch-up 'sometimes': expected none or latest",
  );
});

Deno.test("parseCatchUpFlags: latest without a max delay names --catch-up-max-delay", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags("latest", undefined),
    UserError,
    "--catch-up latest requires --catch-up-max-delay",
  );
  assertThrows(
    () => parseCatchUpFlags("latest", "32d"),
    UserError,
    "Invalid --catch-up-max-delay '32d': must be at most 31d",
  );
  assertThrows(
    () => parseCatchUpFlags("none", "6h"),
    UserError,
    "--catch-up-max-delay applies only to --catch-up latest",
  );
});

Deno.test("workflowTriggerSetCommand: has catch-up options", async () => {
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
  const names = workflowTriggerSetCommand.getOptions().map((o) => o.name);
  assertEquals(names.includes("catch-up"), true);
  assertEquals(names.includes("catch-up-max-delay"), true);
});

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
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
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
