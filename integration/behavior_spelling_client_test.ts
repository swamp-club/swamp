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

// The CLI sends grant selectors and audit filters in the model spelling, so a
// server that predates the behavior spelling (swamp-club#3334) still reads
// them, and sends model-spelled values byte-identically.

import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

interface Recorded {
  type: string;
  payload?: Record<string, unknown>;
}

/** A serve endpoint that records each request and answers with `payload`. */
function recordingServer(payload: Record<string, unknown>): {
  url: string;
  requests: Recorded[];
  shutdown: () => Promise<void>;
} {
  const requests: Recorded[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const request = JSON.parse(event.data as string) as Recorded & {
          id: string;
        };
        requests.push({ type: request.type, payload: request.payload });
        socket.send(
          JSON.stringify({ type: request.type, id: request.id, payload }),
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

const ANSWER = {
  principal: "user:adam",
  subject: "user:adam",
  decisions: [],
  grants: [],
  events: [],
  done: true,
  count: 0,
};

/** A root command that parses the args it is given. */
interface Root {
  parse(args: string[]): Promise<unknown>;
}

async function sentPayload(
  root: Root,
  name: string,
  args: string[],
  type: string,
): Promise<Record<string, unknown> | undefined> {
  const server = recordingServer(ANSWER);
  const previousExitCode = Deno.exitCode;
  try {
    await root.parse([
      name,
      ...args,
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
    ]);
    return server.requests.find((r) => r.type === type)?.payload;
  } finally {
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

const TEST = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  ...TEST,
  name: "access can-i: sends a behavior selector in the model spelling",
  fn: async () => {
    const { accessCanICommand } = await import(
      "../src/cli/commands/access_can_i.ts"
    );
    for (
      const [on, sent] of [
        ["behavior:@acme/*", "model:@acme/*"],
        ["model:@acme/*", "model:@acme/*"],
        ["behaviour:x", "behaviour:x"],
      ]
    ) {
      const payload = await sentPayload(
        new Command().globalOption("--json", "JSON output").command(
          "can-i",
          accessCanICommand,
        ),
        "can-i",
        [
          "--action",
          "run",
          "--on",
          on,
        ],
        "access.can-i",
      );
      assertEquals(payload?.resource, sent, on);
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "access check --server: sends a behavior selector in the model spelling",
  fn: async () => {
    const { accessCheckCommand } = await import(
      "../src/cli/commands/access_check.ts"
    );
    for (
      const [on, sent] of [
        ["behavior:web", "model:web"],
        ["model:web", "model:web"],
      ]
    ) {
      const payload = await sentPayload(
        new Command().globalOption("--json", "JSON output").command(
          "check",
          accessCheckCommand,
        ),
        "check",
        [
          "--subject",
          "user:adam",
          "--action",
          "run",
          "--on",
          on,
        ],
        "access.check",
      );
      assertEquals(payload?.resource, sent, on);
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "access grant list --server: sends a behavior selector in the model spelling",
  fn: async () => {
    const { accessGrantCommand } = await import(
      "../src/cli/commands/access_grant.ts"
    );
    for (
      const [on, sent] of [
        ["behavior:web", "model:web"],
        ["model:web", "model:web"],
      ]
    ) {
      const payload = await sentPayload(
        new Command().globalOption("--json", "JSON output").command(
          "grant",
          accessGrantCommand,
        ),
        "grant",
        ["list", "--on", on],
        "access.grant.list",
      );
      assertEquals(payload?.resource, sent, on);
    }
  },
});

Deno.test({
  ...TEST,
  name: "audit log: sends a behavior action in the model spelling",
  fn: async () => {
    const { auditLogCommand } = await import(
      "../src/cli/commands/audit_log.ts"
    );
    for (
      const [action, sent] of [
        ["behavior.method.run", "model.method.run"],
        ["model.method.run", "model.method.run"],
      ]
    ) {
      const payload = await sentPayload(
        new Command().globalOption("--json", "JSON output").command(
          "log",
          auditLogCommand,
        ),
        "log",
        [
          "--action",
          action,
        ],
        "audit.query",
      );
      assertEquals(payload?.action, sent, action);
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "audit export: sends a behavior action and resource in the model spelling",
  fn: async () => {
    const { auditExportCommand } = await import(
      "../src/cli/commands/audit_export.ts"
    );
    for (
      const [action, resource, sentAction, sentResource] of [
        [
          "behavior.method.run",
          "behavior:web",
          "model.method.run",
          "model:web",
        ],
        ["model.method.run", "model:web", "model.method.run", "model:web"],
      ]
    ) {
      const payload = await sentPayload(
        new Command().globalOption("--json", "JSON output").command(
          "export",
          auditExportCommand,
        ),
        "export",
        [
          "--since",
          "2026-09-01",
          "--until",
          "2026-09-02",
          "--action",
          action,
          "--resource",
          resource,
        ],
        "audit.export",
      );
      assertEquals(payload?.action, sentAction, action);
      assertEquals(payload?.resource, sentResource, resource);
    }
  },
});
