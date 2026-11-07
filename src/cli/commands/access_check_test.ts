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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { VERSION } from "./version.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

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

async function runAccessCheckAgainst(
  decisions: Record<string, unknown>[],
): Promise<number> {
  const server = payloadServer({
    subject: "user:adam",
    action: "run",
    resource: "workflow:@acme/deploy",
    collectives: [],
    groups: [],
    decisions,
  });
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    const { accessCheckCommand } = await import("./access_check.ts");
    const root = new Command()
      .globalOption("--json", "JSON output")
      .command("check", accessCheckCommand);
    await root.parse([
      "check",
      "--json",
      "--server",
      server.url,
      "--token",
      "test.token",
      "--subject",
      "user:adam",
      "--action",
      "run",
      "--on",
      "workflow:@acme/deploy",
    ]);
    return Deno.exitCode;
  } finally {
    Deno.exitCode = previousExitCode;
    await server.shutdown();
  }
}

Deno.test("accessCheckCommand: module loads", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(accessCheckCommand.getName(), "check");
});

Deno.test("accessCheckCommand: has correct description", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  assertEquals(
    accessCheckCommand.getDescription(),
    "Explain whether a subject can perform an action on a resource",
  );
});

Deno.test("accessCheckCommand: has --subject option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "subject");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --action option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "action");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --on option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "on");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --collectives option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "collectives");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --server option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "server");
  assertEquals(opt !== undefined, true);
});

Deno.test("accessCheckCommand: has --field option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  const opt = options.find((o) => o.name === "field");
  assertEquals(opt !== undefined, true);
});

Deno.test({
  name: "accessCheckCommand: sets Deno.exitCode 1 when access is denied",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(await runAccessCheckAgainst([]), 1);
  },
});

Deno.test({
  name:
    "accessCheckCommand: sets Deno.exitCode 1 when the first decision denies",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runAccessCheckAgainst([
        { effect: "deny", grantId: "grant-1" },
      ]),
      1,
    );
  },
});

Deno.test({
  name: "accessCheckCommand: leaves Deno.exitCode 0 when access is allowed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runAccessCheckAgainst([
        { effect: "allow", grantId: "grant-1" },
      ]),
      0,
    );
  },
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-access-check-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
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

async function runAccess(
  command: "check" | "grant" | "integration",
  args: string[],
): Promise<{ output: string; exitCode: number }> {
  const root = new Command().globalOption("--json", "JSON output");
  if (command === "integration") {
    const { accessIntegrationCommand } = await import(
      "./access_integration.ts"
    );
    root.command("integration", accessIntegrationCommand);
  } else if (command === "check") {
    root.command(
      "check",
      (await import("./access_check.ts")).accessCheckCommand,
    );
  } else {
    root.command(
      "grant",
      (await import("./access_grant.ts")).accessGrantCommand,
    );
  }
  const printed: string[] = [];
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  console.log = (...data: unknown[]) => printed.push(data.join(" "));
  Deno.exitCode = 0;
  try {
    await root.parse([command, ...args, "--json"]);
    return { output: printed.join("\n"), exitCode: Deno.exitCode };
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
}

async function withShellModelRepo(
  grants: string[][],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await new YamlDefinitionRepository(dir).save(
      ModelType.create("command/shell"),
      Definition.create({ name: "team-x-probe", tags: { team: "team-x" } }),
    );
    for (const grant of grants) {
      await runAccess("grant", ["create", ...grant, "--repo-dir", dir]);
    }
    await fn(dir);
  });
}

function checkEffect(output: string): string {
  return (JSON.parse(output) as { effect: string }).effect;
}

const ALLOW_PREFIX_WRITE = [
  "--subject",
  "user:alice",
  "--allow",
  "write",
  "--on",
  "model:team-x-*",
];
const DENY_SHELL_WRITE = [
  "--subject",
  "user:alice",
  "--deny",
  "write",
  "--on",
  "model:command/shell",
];

Deno.test({
  name:
    "accessCheckCommand: a local check applies a deny on the named model's stored type (swamp-club#3224)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo(
      [ALLOW_PREFIX_WRITE, DENY_SHELL_WRITE],
      async (dir) => {
        const { output, exitCode } = await runAccess("check", [
          "--subject",
          "user:alice",
          "--action",
          "write",
          "--on",
          "model:team-x-probe",
          "--repo-dir",
          dir,
        ]);
        assertEquals(checkEffect(output), "deny");
        assertEquals(exitCode, 1);
      },
    );
  },
});

Deno.test({
  name:
    "accessCheckCommand: a local check evaluates conditions on the named model's stored tags (swamp-club#3224)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo(
      [[
        "--subject",
        "user:alice",
        "--allow",
        "run",
        "--on",
        "model:*",
        "--when",
        'tags.team == "team-x"',
      ]],
      async (dir) => {
        const { output, exitCode } = await runAccess("check", [
          "--subject",
          "user:alice",
          "--action",
          "run",
          "--on",
          "model:team-x-probe",
          "--repo-dir",
          dir,
        ]);
        assertEquals(checkEffect(output), "allow");
        assertEquals(exitCode, 0);
      },
    );
  },
});

Deno.test({
  name:
    "accessCheckCommand: --field overrides the field resolved from the repo (swamp-club#3224)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo(
      [ALLOW_PREFIX_WRITE, DENY_SHELL_WRITE],
      async (dir) => {
        const { output } = await runAccess("check", [
          "--subject",
          "user:alice",
          "--action",
          "write",
          "--on",
          "model:team-x-probe",
          "--field",
          "modelType=@scope/tracker",
          "--repo-dir",
          dir,
        ]);
        assertEquals(checkEffect(output), "allow");
      },
    );
  },
});

Deno.test({
  name:
    "accessCheckCommand: a local check on a model that does not exist is judged by name (swamp-club#3224)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo(
      [ALLOW_PREFIX_WRITE, DENY_SHELL_WRITE],
      async (dir) => {
        const { output } = await runAccess("check", [
          "--subject",
          "user:alice",
          "--action",
          "write",
          "--on",
          "model:team-x-new",
          "--repo-dir",
          dir,
        ]);
        assertEquals(checkEffect(output), "allow");
      },
    );
  },
});

Deno.test("accessCheckCommand: has --method option", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const options = accessCheckCommand.getOptions();
  assertEquals(options.some((o) => o.name === "method"), true);
});

Deno.test({
  name:
    "accessCheckCommand: --method decides a methods-scoped grant by the method checked",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo(
      [[
        "--subject",
        "user:alice",
        "--allow",
        "run",
        "--on",
        "model:team-x-probe",
        "--methods",
        "execute",
      ]],
      async (dir) => {
        const check = (method?: string) =>
          runAccess("check", [
            "--subject",
            "user:alice",
            "--action",
            "run",
            "--on",
            "model:team-x-probe",
            ...(method ? ["--method", method] : []),
            "--repo-dir",
            dir,
          ]);
        const named = await check("execute");
        assertEquals(checkEffect(named.output), "allow");
        assertEquals(JSON.parse(named.output).method, "execute");
        assertEquals(checkEffect((await check("other")).output), "deny");
        const unnamed = await check();
        assertEquals(checkEffect(unnamed.output), "deny");
        assertEquals(unnamed.exitCode, 1);
      },
    );
  },
});

Deno.test("accessCheckCommand: --client is refused with --server, since a request cannot name a client", async () => {
  const { accessCheckCommand } = await import("./access_check.ts");
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("check", accessCheckCommand);
  const refusal = await assertRejects(() =>
    root.parse([
      "check",
      "--json",
      "--server",
      "ws://127.0.0.1:1",
      "--token",
      "test.token",
      "--subject",
      "user:adam",
      "--action",
      "run",
      "--on",
      "workflow:w",
      "--client",
      "integration:slack",
    ])
  );
  assertStringIncludes(
    (refusal as Error).message,
    "--client is not supported with --server",
  );
});

Deno.test({
  name:
    "accessCheckCommand: a local --client reaches the decision and is named in the result",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo([
      ["--subject", "user:a", "--allow", "read", "--on", "workflow:*"],
      [
        "--subject",
        "user:a",
        "--deny",
        "read",
        "--on",
        "workflow:*",
        "--when",
        'client == "integration:slack"',
      ],
    ], async (dir) => {
      const check = (...extra: string[]) =>
        runAccess("check", [
          "--repo-dir",
          dir,
          "--subject",
          "user:a",
          "--action",
          "read",
          "--on",
          "workflow:w",
          ...extra,
        ]);
      const slack = await check("--client", "integration:slack");
      assertEquals(slack.exitCode, 1);
      assertEquals(JSON.parse(slack.output).client, "integration:slack");
      const direct = await check();
      assertEquals(direct.exitCode, 0);
      assertEquals(JSON.parse(direct.output).client, undefined);
      await assertRejects(() => check("--client", "nonsense"));
      await assertRejects(() => check("--field", "client=direct:cli"));
    });
  },
});

Deno.test({
  name:
    "accessCheckCommand: a local --field run decides like a whole run, and a partial one is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo([
      ["--subject", "user:a", "--allow", "approve", "--on", "workflow:*"],
      [
        "--subject",
        "user:a",
        "--deny",
        "approve",
        "--on",
        "workflow:*",
        "--when",
        "principal.sub == run.initiator.sub || !run.serveDriven",
      ],
    ], async (dir) => {
      const check = (...extra: string[]) =>
        runAccess("check", [
          "--repo-dir",
          dir,
          "--subject",
          "user:a",
          "--action",
          "approve",
          "--on",
          "workflow:w",
          ...extra,
        ]);
      const own = await check("--field", "run.initiator.sub=a");
      assertEquals(own.exitCode, 1);
      const other = await check("--field", "run.initiator.sub=b");
      assertEquals(other.exitCode, 0);
      const member = await check(
        "--field",
        "run.initiator.sub=b",
        "--field",
        "run.serveDriven=false",
      );
      assertEquals(member.exitCode, 1);
      await assertRejects(() => check("--field", "run.serveDriven=false"));
      await assertRejects(() =>
        check("--field", "run.initiator.sub=b", "--field", "run.nope=1")
      );
    });
  },
});

Deno.test({
  name:
    "accessCheckCommand: a local --client integration is judged against its registered ceiling",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withShellModelRepo([
      ["--subject", "user:a", "--allow", "read,run", "--on", "workflow:*"],
    ], async (dir) => {
      const check = (action: string, client: string) =>
        runAccess("check", [
          "--repo-dir",
          dir,
          "--subject",
          "user:a",
          "--action",
          action,
          "--on",
          "workflow:w",
          "--client",
          client,
        ]);
      const unknown = await check("read", "integration:slack");
      assertEquals(unknown.exitCode, 1);
      assertStringIncludes(unknown.output, "builtin:integration-unknown");
      await runAccess("integration", [
        "register",
        "slack",
        "--repo-dir",
        dir,
        "--name",
        "Slack",
        "--ceiling",
        "read=workflow:w",
      ]);
      assertEquals((await check("read", "integration:slack")).exitCode, 0);
      const above = await check("run", "integration:slack");
      assertEquals(above.exitCode, 1);
      assertStringIncludes(above.output, "builtin:integration-ceiling");
    });
  },
});
