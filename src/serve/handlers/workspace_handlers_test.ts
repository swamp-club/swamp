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
import type { Action } from "../../domain/access/action.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import type { SignInCodeStore } from "../../domain/access/sign_in_code.ts";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import type {
  HostedWorkspaceProvisionSpec,
  HostedWorkspaceRootAccess,
} from "../../libswamp/hosted_workspace/deps.ts";
import {
  hostRootWorkspaces,
  hostWorkspacePlacement,
} from "../host_root_workspaces.ts";
import { hostWorkspaceStore } from "../host/workspace_registration.ts";
import {
  type ConnectionContext,
  setConnectionClient,
  setConnectionDelegation,
  setConnectionTokenExpiresAt,
} from "./shared.ts";
import {
  handleWorkspaceChange,
  handleWorkspaceCreate,
  handleWorkspaceGet,
  handleWorkspaceList,
  handleWorkspaceSignIn,
  NOT_A_HOST_ROOT_CODE,
  TOO_MANY_SIGN_IN_CODES_CODE,
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
    stepsRequireExplicitGrant: false,
  };
}

interface Folder extends AsyncDisposable {
  readonly dir: string;
  readonly signInCodes: SignInCodeStore;
  readonly specs: HostedWorkspaceProvisionSpec[];
  ctx(mode?: ServeAuthConfig["mode"]): ConnectionContext;
}

async function folder(): Promise<Folder> {
  const root = await Deno.makeTempDir({ prefix: "swamp-workspace-handlers-" });
  const dir = join(root, "state");
  const specs: HostedWorkspaceProvisionSpec[] = [];
  const host = hostRootWorkspaces(
    { dir, address: "https://host.example" },
    {},
    () => NONE_ACCESS,
    () =>
      hostWorkspaceStore({
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
      }),
    () =>
      hostWorkspacePlacement({
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
      }),
  )!;
  const hostedWorkspaces = {
    ...host,
    services: {
      ...host.services,
      provisioner: {
        async provision(target: string, spec: HostedWorkspaceProvisionSpec) {
          specs.push(spec);
          await Deno.writeTextFile(
            join(target, ".swamp.yaml"),
            `repoId: ${crypto.randomUUID()}\n`,
          );
        },
      },
    },
  };
  return {
    dir,
    specs,
    signInCodes: host.signInCodes,
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

Deno.test("handleWorkspaceList: a direct client lists every workspace, and an integration, a delegation or a malformed client only what its ceiling can get", async () => {
  await using f = await folder();
  await handleWorkspaceCreate(
    createMockSocket(),
    f.ctx(),
    "r0",
    { name: "edge-dns" },
    null,
  );
  const bob = { kind: "user", id: "bob" } as const;
  // token mode with no policy loaded refuses every decision, so a ceilinged caller sees none
  const cases: [string, (socket: WebSocket) => void, string[]][] = [
    ["direct:cli", (s) => setConnectionClient(s, "direct:cli"), ["edge-dns"]],
    [
      "direct:dashboard",
      (s) => setConnectionClient(s, "direct:dashboard"),
      ["edge-dns"],
    ],
    [
      "direct:token",
      (s) => setConnectionClient(s, "direct:token"),
      ["edge-dns"],
    ],
    ["integration:ops", (s) => setConnectionClient(s, "integration:ops"), []],
    // a delegation holds a caller to its ceiling even when its client is direct
    [
      "direct:cli under a delegation",
      (s) => {
        setConnectionClient(s, "direct:cli");
        setConnectionDelegation(s, "delegation-1");
      },
      [],
    ],
    ["a malformed client", (s) => setConnectionClient(s, "not-a-client"), []],
  ];
  for (const [label, bind, names] of cases) {
    const socket = createMockSocket();
    bind(socket);
    await handleWorkspaceList(socket, f.ctx("token"), "r", bob);
    const listed = frames(socket)[0].payload?.data.workspaces as
      | { name: string }[]
      | undefined;
    assertEquals(listed?.map((w) => w.name), names, label);
  }
});

function grantedCtx(
  base: ConnectionContext,
  actions: Action[],
): ConnectionContext {
  return {
    ...base,
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(
          [{
            id: crypto.randomUUID(),
            subject: { kind: "user", name: "alice" },
            effect: "allow",
            actions,
            resource: { kind: "workspace", pattern: "data-*" },
            state: "active",
            source: "method",
            createdBy: { kind: "user", id: "admin" },
            createdAt: "2026-01-01T00:00:00Z",
          }],
          [],
          createConditionEvaluator(),
        ),
      ),
    } as unknown as PolicySnapshotLoader,
  };
}

Deno.test("handleWorkspaceGet: each request needs its own action on workspace:<name>, and nothing else stands in", async () => {
  await using f = await folder();
  const alice = { kind: "user" as const, id: "alice" };
  const cases: {
    need: Action;
    run: (socket: WebSocket, ctx: ConnectionContext) => Promise<void>;
  }[] = [
    {
      need: "write",
      run: (socket, ctx) =>
        handleWorkspaceCreate(socket, ctx, "r", { name: "data-x" }, alice),
    },
    {
      need: "read",
      run: (socket, ctx) =>
        handleWorkspaceGet(socket, ctx, "r", { name: "data-y" }, alice),
    },
    {
      need: "admin",
      run: (socket, ctx) =>
        handleWorkspaceChange(
          "workspace.suspend",
          socket,
          ctx,
          "r",
          { name: "data-y" },
          alice,
        ),
    },
  ];
  for (const { need, run } of cases) {
    const others = (["read", "write", "admin"] as const).filter((a) =>
      a !== need
    );
    const refused = createMockSocket();
    await run(refused, grantedCtx(f.ctx("oauth"), [...others]));
    assertEquals(frames(refused)[0].error?.code, "unauthorized", need);
    const admitted = createMockSocket();
    await run(admitted, grantedCtx(f.ctx("oauth"), [need]));
    assertEquals(
      frames(admitted)[0].error?.code === "unauthorized",
      false,
      `${need}: ${admitted.sent[0]}`,
    );
  }
});

Deno.test("handleWorkspaceSignIn: a caller past their cap of unused codes is told so, and nothing more is issued", async () => {
  await using f = await folder();
  await handleWorkspaceCreate(
    createMockSocket(),
    f.ctx(),
    "r0",
    { name: "edge-dns" },
    null,
  );
  const alice = { kind: "user", id: "alice" } as const;
  const sent: Frame[] = [];
  for (let i = 0; i < 21; i++) {
    const socket = createMockSocket();
    setConnectionTokenExpiresAt(socket, "2099-01-01T00:00:00.000Z");
    await handleWorkspaceSignIn(
      socket,
      f.ctx("token"),
      `r${i + 1}`,
      { name: "edge-dns" },
      alice,
    );
    sent.push(...frames(socket));
  }
  assertEquals(
    sent.filter((frame) => frame.type === "workspace.sign-in").length,
    20,
  );
  assertEquals(sent.at(-1)?.error?.code, TOO_MANY_SIGN_IN_CODES_CODE);
  assertEquals(f.signInCodes.size, 20);
});
