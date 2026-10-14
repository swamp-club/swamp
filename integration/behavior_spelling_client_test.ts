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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
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

// ── --behavior flags and enum synonyms (swamp-club#3410) ───────────────────

/**
 * The payload a command sends, recorded before its response is rendered: the
 * recording server's generic answer may not render for every command, and
 * only the request matters here.
 */
async function sentPayloadOf(
  root: Root,
  name: string,
  args: string[],
  type: string,
): Promise<Record<string, unknown> | undefined> {
  const server = recordingServer(ANSWER);
  const previousExitCode = Deno.exitCode;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await root.parse([
      name,
      ...args,
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
    ]).catch(() => {});
    return server.requests.find((r) => r.type === type)?.payload;
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

/** A root carrying the completion types and --json, mounting `command`. */
async function rootWith(name: string, command: AnyCommand): Promise<Root> {
  const { registerCompletionTypes } = await import(
    "../src/cli/completion_types.ts"
  );
  return registerCompletionTypes(new Command())
    .globalOption("--json", "JSON output")
    .command(name, command);
}

Deno.test({
  ...TEST,
  name:
    "--behavior and --model: every flag consumer sends the same model-form payload",
  fn: async () => {
    const { dataGetCommand } = await import(
      "../src/cli/commands/data_get.ts"
    );
    const { dataListCommand } = await import(
      "../src/cli/commands/data_list.ts"
    );
    const { dataVersionsCommand } = await import(
      "../src/cli/commands/data_versions.ts"
    );
    const { dataDeleteCommand } = await import(
      "../src/cli/commands/data_delete.ts"
    );
    const { dataRenameCommand } = await import(
      "../src/cli/commands/data_rename.ts"
    );
    const { dataSearchCommand } = await import(
      "../src/cli/commands/data_search.ts"
    );
    const { reportGetCommand } = await import(
      "../src/cli/commands/report_get.ts"
    );
    const { reportSearchCommand } = await import(
      "../src/cli/commands/report_search.ts"
    );
    const cases: Array<
      [string, AnyCommand, string[], string, string, string]
    > = [
      [
        "get",
        dataGetCommand,
        ["--name", "state"],
        "data.get",
        "modelIdOrName",
        "data get",
      ],
      ["list", dataListCommand, [], "data.list", "modelIdOrName", "data list"],
      [
        "versions",
        dataVersionsCommand,
        ["--name", "state"],
        "data.versions",
        "modelIdOrName",
        "data versions",
      ],
      [
        "delete",
        dataDeleteCommand,
        ["--name", "state"],
        "data.delete",
        "modelIdOrName",
        "data delete",
      ],
      [
        "rename",
        dataRenameCommand,
        ["--name", "old", "--new-name", "new"],
        "data.rename",
        "modelIdOrName",
        "data rename",
      ],
      ["search", dataSearchCommand, [], "data.search", "model", "data search"],
      [
        "get",
        reportGetCommand,
        ["cost-summary"],
        "report.get",
        "model",
        "report get",
      ],
      [
        "search",
        reportSearchCommand,
        [],
        "report.search",
        "model",
        "report search",
      ],
    ];
    for (const [name, command, rest, type, key, label] of cases) {
      const root = await rootWith(name, command);
      const viaBehavior = await sentPayloadOf(
        root,
        name,
        [...rest, "--behavior", "web"],
        type,
      );
      const viaModel = await sentPayloadOf(
        root,
        name,
        [...rest, "--model", "web"],
        type,
      );
      assertEquals(viaBehavior?.[key], "web", label);
      assertEquals(
        JSON.stringify(viaBehavior),
        JSON.stringify(viaModel),
        label,
      );
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "report search --scope: sends behavior as model and every other scope as typed",
  fn: async () => {
    const { reportSearchCommand } = await import(
      "../src/cli/commands/report_search.ts"
    );
    const root = await rootWith("search", reportSearchCommand);
    for (
      const [scope, sent] of [
        ["behavior", "model"],
        ["model", "model"],
        ["method", "method"],
        ["workflow", "workflow"],
        ["behaviour", "behaviour"],
      ]
    ) {
      const payload = await sentPayloadOf(
        root,
        "search",
        ["--scope", scope],
        "report.search",
      );
      assertEquals(payload?.scope, sent, scope);
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "data search --owner-type: sends behavior-method as model-method and every other owner type as typed",
  fn: async () => {
    const { dataSearchCommand } = await import(
      "../src/cli/commands/data_search.ts"
    );
    const root = await rootWith("search", dataSearchCommand);
    for (
      const [ownerType, sent] of [
        ["behavior-method", "model-method"],
        ["model-method", "model-method"],
        ["workflow-step", "workflow-step"],
        ["manual", "manual"],
        ["behaviour-method", "behaviour-method"],
      ]
    ) {
      const payload = await sentPayloadOf(
        root,
        "search",
        ["--owner-type", ownerType],
        "data.search",
      );
      assertEquals(payload?.ownerType, sent, ownerType);
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "extension search --content-type: sends behaviors as models, once, and model values as typed",
  fn: async () => {
    const { extensionSearchCommand } = await import(
      "../src/cli/commands/extension_search.ts"
    );
    const root = await rootWith("search", extensionSearchCommand);
    for (
      const [types, sent] of [
        [["behaviors"], ["models"]],
        [["models"], ["models"]],
        [["behaviors", "models"], ["models"]],
        [["models", "reports", "behaviors"], ["models", "reports"]],
        [["models", "models"], ["models", "models"]],
        [["reports"], ["reports"]],
      ]
    ) {
      const payload = await sentPayloadOf(
        root,
        "search",
        types.flatMap((t) => ["--content-type", t]),
        "extension.search",
      );
      assertEquals(payload?.contentType, sent, types.join(","));
    }
  },
});

Deno.test({
  ...TEST,
  name:
    "extension search --content-type: behaviours is not a synonym and fails naming the value",
  fn: async () => {
    const { extensionSearchCommand } = await import(
      "../src/cli/commands/extension_search.ts"
    );
    const root = await rootWith("search", extensionSearchCommand);
    const server = recordingServer(ANSWER);
    try {
      const error = await assertRejects(() =>
        root.parse([
          "search",
          "--content-type",
          "behaviours",
          "--json",
          "--server",
          server.url,
          "--token",
          "test.token",
        ])
      );
      assertStringIncludes(String(error), '"behaviours"');
      assertEquals(server.requests, []);
    } finally {
      await server.shutdown();
    }
  },
});
