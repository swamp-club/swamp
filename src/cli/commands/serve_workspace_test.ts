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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { RequestResponseOptions } from "../remote_run.ts";
import { ServerResponseError } from "../remote_run.ts";
import type {
  WorkspaceRequest,
  WorkspaceRequestDeps,
} from "../serve_workspace_request.ts";
import { createServeWorkspaceCommand } from "./serve_workspace.ts";
import {
  runServeWorkspaceCreate,
  serveWorkspaceCreateCommand,
} from "./serve_workspace_create.ts";
import { runServeWorkspaceGet } from "./serve_workspace_get.ts";
import { runServeWorkspaceList } from "./serve_workspace_list.ts";
import { runServeWorkspaceResume } from "./serve_workspace_resume.ts";
import {
  runServeWorkspaceRm,
  serveWorkspaceRmCommand,
} from "./serve_workspace_rm.ts";
import { runServeWorkspaceSuspend } from "./serve_workspace_suspend.ts";

await initializeLogging({});

const SERVER = "https://host.example";
const OPTIONS = { server: SERVER };

interface Fake {
  sent: WorkspaceRequest[];
  deps: WorkspaceRequestDeps;
}

function fake(reply: unknown): Fake {
  const sent: WorkspaceRequest[] = [];
  return {
    sent,
    deps: {
      request: <T>(
        _options: RequestResponseOptions,
        request: WorkspaceRequest,
      ) => {
        sent.push(request);
        return reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve(reply as T);
      },
      resolveToken: () => Promise.resolve("root-token"),
    },
  };
}

async function output(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message: string) => lines.push(message);
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return stripAnsiCode(lines.join("\n"));
}

const SUMMARY = {
  name: "edge-dns",
  address: `${SERVER}/w/edge-dns`,
  wanted: "active",
  state: "ready",
  restarts: 1,
  reason: null,
};

function changeReply(wanted: string) {
  return {
    data: {
      name: "edge-dns",
      wanted,
      changedAt: "2026-11-18T00:00:00.000Z",
    },
  };
}

const CREATED = {
  data: {
    name: "edge-dns",
    address: `${SERVER}/w/edge-dns`,
    wanted: "suspended",
  },
};

Deno.test("runServeWorkspaceCreate: sends workspace.create and reports the workspace stopped, naming resume, in json", async () => {
  const { sent, deps } = fake(CREATED);
  const out = await output(() =>
    runServeWorkspaceCreate(OPTIONS, "edge-dns", "json", deps)
  );
  assertEquals(sent, [{
    type: "workspace.create",
    payload: { name: "edge-dns" },
  }]);
  const parsed = JSON.parse(out);
  assertEquals(parsed.state, "stopped");
  assertEquals(parsed.address, `${SERVER}/w/edge-dns`);
  assertEquals(
    parsed.start,
    `swamp serve workspace resume edge-dns --server ${SERVER}`,
  );
});

Deno.test("runServeWorkspaceCreate: reports the workspace stopped, naming resume, in log", async () => {
  const { deps } = fake(CREATED);
  const out = await output(() =>
    runServeWorkspaceCreate(OPTIONS, "edge-dns", "log", deps)
  );
  assertStringIncludes(out, `Address: ${SERVER}/w/edge-dns`);
  assertStringIncludes(out, "State: stopped");
  assertStringIncludes(
    out,
    `swamp serve workspace resume edge-dns --server ${SERVER}`,
  );
});

Deno.test("runServeWorkspaceCreate: an invalid name is refused before any request", async () => {
  const { sent, deps } = fake(CREATED);
  await assertRejects(
    () => runServeWorkspaceCreate(OPTIONS, "Edge DNS", "log", deps),
    UserError,
  );
  assertEquals(sent, []);
});

Deno.test("runServeWorkspaceCreate: an older token-mode root's refusal reaches the caller as its message", async () => {
  const message = "A root in token mode cannot create a workspace yet.";
  const { deps } = fake(
    new ServerResponseError({ code: "token_mode_create_refused", message }),
  );
  const error = await assertRejects(
    () => runServeWorkspaceCreate(OPTIONS, "edge-dns", "json", deps),
    UserError,
  );
  assertEquals(error.message, message);
});

Deno.test("runServeWorkspaceList: sends workspace.list and renders each mode", async () => {
  for (const mode of ["log", "json"] as OutputMode[]) {
    const { sent, deps } = fake({ data: { workspaces: [SUMMARY] } });
    const out = await output(() => runServeWorkspaceList(OPTIONS, mode, deps));
    assertEquals(sent, [{ type: "workspace.list" }]);
    if (mode === "json") {
      assertEquals(JSON.parse(out), { workspaces: [SUMMARY] });
    } else {
      assertStringIncludes(out, "edge-dns");
      assertStringIncludes(out, `${SERVER}/w/edge-dns`);
      assertStringIncludes(out, "ready");
    }
  }
});

Deno.test("runServeWorkspaceGet: sends workspace.get and renders each mode", async () => {
  const failed = {
    ...SUMMARY,
    state: "failed",
    restarts: 6,
    reason: "Its serve keeps failing to start.",
  };
  for (const mode of ["log", "json"] as OutputMode[]) {
    const { sent, deps } = fake({ data: failed });
    const out = await output(() =>
      runServeWorkspaceGet(OPTIONS, "edge-dns", mode, deps)
    );
    assertEquals(sent, [{
      type: "workspace.get",
      payload: { name: "edge-dns" },
    }]);
    if (mode === "json") {
      assertEquals(JSON.parse(out), failed);
    } else {
      assertStringIncludes(out, "State: failed");
      assertStringIncludes(out, "Restarts: 6");
      assertStringIncludes(out, "Reason: Its serve keeps failing to start.");
    }
  }
});

Deno.test("runServeWorkspaceGet: an unknown workspace reads as the root's message", async () => {
  const { deps } = fake(
    new ServerResponseError({
      code: "not_found",
      message: "No hosted workspace named edge-dns.",
    }),
  );
  const error = await assertRejects(
    () => runServeWorkspaceGet(OPTIONS, "edge-dns", "log", deps),
    UserError,
  );
  assertEquals(error.message, "No hosted workspace named edge-dns.");
});

Deno.test("runServeWorkspaceSuspend and runServeWorkspaceResume: send their request and render each mode", async () => {
  const cases = [
    {
      run: runServeWorkspaceSuspend,
      type: "workspace.suspend" as const,
      wanted: "suspended",
      says: "stops its serve",
    },
    {
      run: runServeWorkspaceResume,
      type: "workspace.resume" as const,
      wanted: "active",
      says: "starts its serve",
    },
  ];
  for (const { run, type, wanted, says } of cases) {
    for (const mode of ["log", "json"] as OutputMode[]) {
      const { sent, deps } = fake(changeReply(wanted));
      const out = await output(() => run(OPTIONS, "edge-dns", mode, deps));
      assertEquals(sent, [{ type, payload: { name: "edge-dns" } }]);
      if (mode === "json") {
        assertEquals(JSON.parse(out), changeReply(wanted).data);
      } else {
        assertStringIncludes(out, says);
      }
    }
  }
});

Deno.test("runServeWorkspaceRm: --yes and --force send workspace.delete without asking", async () => {
  for (const flag of [{ yes: true }, { force: true }]) {
    const { sent, deps } = fake(changeReply("deleted"));
    let asked = false;
    const out = await output(() =>
      runServeWorkspaceRm(
        { ...OPTIONS, ...flag },
        "edge-dns",
        "log",
        deps,
        () => {
          asked = true;
          return Promise.resolve(true);
        },
      )
    );
    assertEquals(asked, false);
    assertEquals(sent, [{
      type: "workspace.delete",
      payload: { name: "edge-dns" },
    }]);
    assertStringIncludes(out, "removes its folder");
  }
});

Deno.test("runServeWorkspaceRm: log mode asks first and sends the request on a yes", async () => {
  const { sent, deps } = fake(changeReply("deleted"));
  const prompts: string[] = [];
  await output(() =>
    runServeWorkspaceRm(OPTIONS, "edge-dns", "log", deps, (message) => {
      prompts.push(message);
      return Promise.resolve(true);
    })
  );
  assertEquals(prompts.length, 1);
  assertStringIncludes(prompts[0], "Remove workspace edge-dns?");
  assertEquals(sent.length, 1);
});

Deno.test("runServeWorkspaceRm: a declined prompt sends nothing and says nothing was removed", async () => {
  const { sent, deps } = fake(changeReply("deleted"));
  const out = await output(() =>
    runServeWorkspaceRm(
      OPTIONS,
      "edge-dns",
      "log",
      deps,
      () => Promise.resolve(false),
    )
  );
  assertEquals(sent, []);
  assertStringIncludes(out, "Nothing was removed");
});

Deno.test("runServeWorkspaceRm: json mode never asks", async () => {
  const { sent, deps } = fake(changeReply("deleted"));
  let asked = false;
  const out = await output(() =>
    runServeWorkspaceRm(OPTIONS, "edge-dns", "json", deps, () => {
      asked = true;
      return Promise.resolve(false);
    })
  );
  assertEquals(asked, false);
  assertEquals(sent.length, 1);
  assertEquals(JSON.parse(out), changeReply("deleted").data);
});

Deno.test("runServeWorkspaceRm: an invalid name is refused before the prompt", async () => {
  const { sent, deps } = fake(changeReply("deleted"));
  let asked = false;
  await assertRejects(
    () =>
      runServeWorkspaceRm(OPTIONS, "../x", "log", deps, () => {
        asked = true;
        return Promise.resolve(true);
      }),
    UserError,
  );
  assertEquals(asked, false);
  assertEquals(sent, []);
});

Deno.test("createServeWorkspaceCommand: holds the six subcommands", async () => {
  const group = await createServeWorkspaceCommand();
  assertEquals(
    group.getCommands().map((command: { getName(): string }) =>
      command.getName()
    ),
    ["create", "list", "get", "suspend", "resume", "rm"],
  );
});

Deno.test("serve workspace commands: take --server and rm takes --yes and --force", () => {
  assert(serveWorkspaceCreateCommand.getOption("server") !== undefined);
  assert(serveWorkspaceRmCommand.getOption("yes") !== undefined);
  assert(serveWorkspaceRmCommand.getOption("force") !== undefined);
});
