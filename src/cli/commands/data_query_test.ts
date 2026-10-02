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

import { assertEquals, assertRejects } from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

/**
 * In-process serve endpoint answering every data.query frame with the given
 * response data, recording each request payload — enough to drive the
 * --server path without a subprocess.
 */
function queryServer(data: Record<string, unknown>): {
  url: string;
  payloads: Record<string, unknown>[];
  shutdown: () => Promise<void>;
} {
  const payloads: Record<string, unknown>[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const request = JSON.parse(event.data as string) as {
          type: string;
          id: string;
          payload: Record<string, unknown>;
        };
        payloads.push(request.payload);
        socket.send(
          JSON.stringify({
            type: request.type,
            id: request.id,
            payload: { data },
          }),
        );
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    payloads,
    shutdown: () => server.shutdown(),
  };
}

/** Runs `data query --single --json` against a scripted server; returns stdout lines. */
async function runSingleAgainst(
  server: { url: string },
): Promise<string[]> {
  const { dataQueryCommand } = await import("./data_query.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("query", dataQueryCommand);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    await root.parse([
      "query",
      "true",
      "--single",
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
    ]);
  } finally {
    console.log = originalLog;
  }
  return lines;
}

Deno.test("dataQueryCommand has --single option", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  const option = dataQueryCommand.getOption("single");
  assertEquals(option !== undefined, true);
});

Deno.test("dataQueryCommand --single conflicts with --limit", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  assertEquals(dataQueryCommand.getOption("single")?.conflicts, ["limit"]);
});

Deno.test("dataQueryCommand: --single without a predicate fails before opening the TUI", async () => {
  const { dataQueryCommand } = await import("./data_query.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("query", dataQueryCommand);

  await assertRejects(
    () => root.parse(["query", "--single"]),
    UserError,
    "A CEL predicate is required with --single",
  );
});

Deno.test("dataQueryCommand: --single over --server asks for two matches and prints the one as an object", async () => {
  const server = queryServer({
    predicate: "true",
    results: [{
      id: "record-1",
      name: "state",
      contentType: "application/json",
      attributes: { ok: true },
    }],
    total: 1,
    limited: false,
  });
  try {
    const lines = await runSingleAgainst(server);
    assertEquals(server.payloads[0].limit, 2);
    const output = JSON.parse(lines[0]) as Record<string, unknown>;
    assertEquals(output.name, "state");
    assertEquals(output.content, { ok: true });
  } finally {
    await server.shutdown();
  }
});

Deno.test("dataQueryCommand: --single over --server rejects several matches with their code", async () => {
  const server = queryServer({
    predicate: "true",
    results: [{ id: "a" }, { id: "b" }],
    total: 2,
    limited: true,
  });
  try {
    const error = await assertRejects(
      () => runSingleAgainst(server),
      UserError,
      "more than one",
    );
    assertEquals(error.code, "QUERY_MULTIPLE_MATCHES");
  } finally {
    await server.shutdown();
  }
});

Deno.test("dataQueryCommand: --single over --server rejects a response with no count", async () => {
  const server = queryServer({});
  try {
    const error = await assertRejects(
      () => runSingleAgainst(server),
      UserError,
    );
    assertEquals(error.code, "QUERY_NO_MATCH");
  } finally {
    await server.shutdown();
  }
});
