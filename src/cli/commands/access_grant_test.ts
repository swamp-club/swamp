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
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { VERSION } from "./version.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

/**
 * In-process serve endpoint streaming the given run events followed by a
 * `done` frame — enough to drive the command's streaming --server path
 * without a subprocess.
 */
function runEventServer(
  events: Record<string, unknown>[],
): { url: string; requests: () => number; shutdown: () => Promise<void> } {
  let requests = 0;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        requests++;
        const request = JSON.parse(message.data as string) as { id: string };
        for (const event of events) {
          socket.send(
            JSON.stringify({ type: "event", id: request.id, event }),
          );
        }
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    requests: () => requests,
    shutdown: () => server.shutdown(),
  };
}

/** Runs `access grant create` against a scripted run result; returns Deno.exitCode. */
async function runGrantCreateAgainst(
  run: Record<string, unknown>,
): Promise<number> {
  const server = runEventServer([{ kind: "completed", run }]);
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { accessGrantCommand } = await import("./access_grant.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("grant", accessGrantCommand);
    await root.parse([
      "grant",
      "create",
      "--subject",
      "user:adam",
      "--allow",
      "run",
      "--on",
      "workflow:@acme/deploy",
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

Deno.test("accessGrantCommand: module loads", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  assertEquals(accessGrantCommand.getName(), "grant");
});

Deno.test("accessGrantCommand: has policy alias", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  assertEquals(accessGrantCommand.getAliases().includes("policy"), true);
});

Deno.test("accessGrantCommand: has correct description", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  assertEquals(
    accessGrantCommand.getDescription(),
    "Manage authorization grants",
  );
});

Deno.test("accessGrantCommand: has create subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});

Deno.test("accessGrantCommand: has list subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});

Deno.test("accessGrantCommand: has revoke subcommand", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke");
  assertEquals(revokeCmd !== undefined, true);
});

Deno.test("accessGrantCommand: create has --subject option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const subjectOpt = options.find((o) => o.name === "subject");
  assertEquals(subjectOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --allow option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const allowOpt = options.find((o) => o.name === "allow");
  assertEquals(allowOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --deny option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const denyOpt = options.find((o) => o.name === "deny");
  assertEquals(denyOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --on option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const onOpt = options.find((o) => o.name === "on");
  assertEquals(onOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --when option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const whenOpt = options.find((o) => o.name === "when");
  assertEquals(whenOpt !== undefined, true);
});

Deno.test("accessGrantCommand: create has --server option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("accessGrantCommand: list has --server option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list")!;
  const options = listCmd.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("accessGrantCommand: revoke has --server option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke")!;
  const options = revokeCmd.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test("accessGrantCommand: revoke accepts grant_id argument", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const revokeCmd = commands.find((c) => c.getName() === "revoke")!;
  const args = revokeCmd.getArguments();
  assertEquals(args.length, 1);
});

Deno.test({
  name: "accessGrantCommand: create sets Deno.exitCode 1 when the run fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runGrantCreateAgainst({ status: "failed" }), 1);
  },
});

Deno.test({
  name:
    "accessGrantCommand: create leaves Deno.exitCode 0 when the run succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runGrantCreateAgainst({ status: "succeeded" }), 0);
  },
});

Deno.test("accessGrantCommand: create has --methods option", async () => {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const commands = accessGrantCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create")!;
  const options = createCmd.getOptions();
  const methodsOpt = options.find((o) => o.name === "methods");
  assertEquals(methodsOpt !== undefined, true);
});

/** Each refusal the grant model raises inside `create`, with its message. */
const REFUSED_CREATES: { label: string; args: string[]; message: string }[] = [
  {
    label: "a subject with no kind",
    args: ["--subject", "adam", "--allow", "run", "--on", "model:@acme/deploy"],
    message: 'Invalid subject "adam"',
  },
  {
    label: "a CEL syntax error",
    args: [
      "--subject",
      "user:adam",
      "--allow",
      "run",
      "--on",
      "model:@acme/deploy",
      "--when",
      "tags.env ==",
    ],
    message: "Invalid grant condition: CEL syntax error",
  },
  {
    label: "a modelType literal not spelled as stored",
    args: [
      "--subject",
      "user:adam",
      "--allow",
      "run",
      "--on",
      "model:@acme/deploy",
      "--when",
      'modelType == "ACME::Deploy"',
    ],
    message: "Invalid grant condition:\n  - modelType is compared with",
  },
];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-access-grant-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(dir: string): Promise<void> {
  const homeDir = join(dir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(dir), { tools: [] });
}

/** Runs `access grant <args>` with --json, returning what it printed. */
async function runGrant(args: string[]): Promise<string> {
  const { accessGrantCommand } = await import("./access_grant.ts");
  const printed: string[] = [];
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  console.log = (...data: unknown[]) => printed.push(data.join(" "));
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .command("grant", accessGrantCommand)
      .parse(["grant", ...args, "--json"]);
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
  return printed.join("\n");
}

/** Every file under `path`, or none when it does not exist. */
async function filesUnder(path: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) found.push(...await filesUnder(child));
      else found.push(child);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found;
}

for (const refused of REFUSED_CREATES) {
  Deno.test({
    name:
      `accessGrantCommand: create refuses ${refused.label} without sending it to --server (swamp-club#3182)`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const server = runEventServer([]);
      try {
        await assertRejects(
          () =>
            runGrant([
              "create",
              ...refused.args,
              "--server",
              server.url,
              "--token",
              "test.token",
            ]),
          UserError,
          refused.message,
        );
        assertEquals(server.requests(), 0);
      } finally {
        await server.shutdown();
      }
    },
  });

  Deno.test({
    name:
      `accessGrantCommand: a local create refusing ${refused.label} leaves no definition or run behind (swamp-club#3182)`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withTempDir(async (dir) => {
        await initRepo(dir);
        await assertRejects(
          () => runGrant(["create", ...refused.args, "--repo-dir", dir]),
          UserError,
          refused.message,
        );
        assertEquals(
          await filesUnder(
            join(dir, ".swamp", "auto-definitions", "swamp", "grant"),
          ),
          [],
        );
        assertEquals(
          await filesUnder(join(dir, ".swamp", "outputs", "swamp", "grant")),
          [],
        );
      });
    },
  });
}

Deno.test({
  name:
    "accessGrantCommand: a local create stores its grant and its --methods (swamp-club#3182, swamp-club#3187)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      await initRepo(dir);
      await runGrant([
        "create",
        "--subject",
        "user:adam",
        "--allow",
        "run",
        "--on",
        "model:@acme/deploy",
        "--when",
        'tags.env == "prod"',
        "--methods",
        "deploy, ,plan",
        "--repo-dir",
        dir,
      ]);
      assertEquals(
        (await filesUnder(
          join(dir, ".swamp", "auto-definitions", "swamp", "grant"),
        )).length,
        1,
      );
      // The refused-create tests read this directory as empty; a run writes
      // here, so their check is not vacuous.
      assertEquals(
        (await filesUnder(join(dir, ".swamp", "outputs", "swamp", "grant")))
          .length > 0,
        true,
      );
      const grants = JSON.parse(
        await runGrant(["list", "--repo-dir", dir]),
      ) as { subject: unknown; condition?: string; methods?: string[] }[];
      assertEquals(grants.length, 1);
      assertEquals(grants[0].subject, { kind: "user", name: "adam" });
      assertEquals(grants[0].condition, 'tags.env == "prod"');
      assertEquals(grants[0].methods, ["deploy", "plan"]);
    });
  },
});
