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
import { join } from "@std/path";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import type {
  HostedWorkspaceProvisionSpec,
  HostedWorkspaceRootAccess,
} from "../../libswamp/hosted_workspace/deps.ts";
import { hostRootWorkspaces } from "../host_root_workspaces.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  handleWorkspaceChange,
  handleWorkspaceCreate,
  handleWorkspaceGet,
  handleWorkspaceList,
  NOT_A_HOST_ROOT_CODE,
} from "./workspace_handlers.ts";

const NONE_ACCESS: HostedWorkspaceRootAccess = {
  mode: "none",
  oauthProvider: null,
  allowedUsers: [],
  allowedCollectives: [],
  nameCache: {},
};

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

interface Frame {
  type: string;
  payload?: { data: Record<string, unknown> };
  error?: { code: string; message: string };
}

function frames(socket: { sent: string[] }): Frame[] {
  return socket.sent.map((s) => JSON.parse(s) as Frame);
}

function authConfig(mode: ServeAuthConfig["mode"]): ServeAuthConfig {
  return {
    mode,
    admins: [],
    allowedCollectives: [],
    allowedUsers: [],
    oauthProvider: "",
    groupsField: "",
    restrictedModelTypes: [],
    restrictedCommands: [],
    approveRequiresExplicitGrant: false,
    signalRequiresExplicitGrant: false,
    tagRequiresExplicitGrant: false,
  };
}

interface Folder extends AsyncDisposable {
  readonly dir: string;
  readonly specs: HostedWorkspaceProvisionSpec[];
  ctx(mode?: ServeAuthConfig["mode"]): ConnectionContext;
}

async function folder(): Promise<Folder> {
  const root = await Deno.makeTempDir({ prefix: "swamp-workspace-handlers-" });
  const dir = join(root, "workspaces");
  const specs: HostedWorkspaceProvisionSpec[] = [];
  const host = hostRootWorkspaces(
    { dir, address: "https://host.example" },
    {},
    () => NONE_ACCESS,
  )!;
  const hostedWorkspaces = {
    ...host,
    services: {
      ...host.services,
      provisioner: {
        async provision(target: string, spec: HostedWorkspaceProvisionSpec) {
          specs.push(spec);
          await Deno.writeTextFile(join(target, ".swamp.yaml"), "");
        },
      },
    },
  };
  return {
    dir,
    specs,
    ctx: (mode = "none") =>
      ({
        repoContext: { markDirty: () => {} },
        authConfig: authConfig(mode),
        hostedWorkspaces,
      }) as unknown as ConnectionContext,
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    },
  };
}

Deno.test("handleWorkspaceCreate: in none mode the creator is anonymous and the new workspace names no admin", async () => {
  await using f = await folder();
  const socket = createMockSocket();
  await handleWorkspaceCreate(
    socket,
    f.ctx(),
    "r1",
    { name: "edge-dns" },
    null,
  );
  assertEquals(frames(socket)[0].payload?.data.wanted, "suspended");
  const stored = await new HostedWorkspaceFileRepository(f.dir).findByName(
    "edge-dns",
  );
  assertEquals(
    stored.kind === "found" ? stored.workspace.creator : stored.kind,
    "anonymous",
  );
  assertEquals(f.specs.map((s) => s.admin), [null]);
});

Deno.test("handleWorkspaceGet: the services' own codes reach the caller, from get, change and create alike", async () => {
  await using f = await folder();
  const cases: [string, (socket: WebSocket) => Promise<void>, string][] = [
    [
      "get of an unknown workspace",
      (s) => handleWorkspaceGet(s, f.ctx(), "r", { name: "nope" }, null),
      "not_found",
    ],
    [
      "resume of an unknown workspace",
      (s) =>
        handleWorkspaceChange(
          "workspace.resume",
          s,
          f.ctx(),
          "r",
          { name: "nope" },
          null,
        ),
      "not_found",
    ],
    [
      "create with an invalid name",
      (s) => handleWorkspaceCreate(s, f.ctx(), "r", { name: "Bad_Name" }, null),
      "user_error",
    ],
  ];
  for (const [label, run, code] of cases) {
    const socket = createMockSocket();
    await run(socket);
    assertEquals(frames(socket)[0].error?.code, code, label);
  }
});

Deno.test("handleWorkspaceGet: authorization is decided before whether this serve is a host's root, and list needs none", async () => {
  await using f = await folder();
  const ctx = { ...f.ctx("token"), hostedWorkspaces: undefined };
  const admin = createMockSocket();
  await handleWorkspaceGet(
    admin,
    ctx,
    "r",
    { name: "edge-dns" },
    { kind: "user", id: "alice" },
  );
  // token mode with no policy loaded refuses every decision
  assertEquals(frames(admin)[0].error?.code, "access_not_configured");
  const listing = createMockSocket();
  await handleWorkspaceList(listing, ctx, "r", { kind: "user", id: "alice" });
  assertEquals(frames(listing)[0].error?.code, NOT_A_HOST_ROOT_CODE);
});
