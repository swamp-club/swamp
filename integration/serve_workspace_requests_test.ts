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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { provisionHostedWorkspace } from "../src/cli/hosted_workspace_provision.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import { workspaceServe } from "../src/domain/serve/managed_serve.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { HostedWorkspaceFileRepository } from "../src/infrastructure/persistence/hosted_workspace_file_repository.ts";
import { scanWorkspaces } from "../src/infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { HostedWorkspaceRootAccess } from "../src/libswamp/hosted_workspace/deps.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  NOT_A_HOST_ROOT_CODE,
  TOKEN_MODE_CREATE_REFUSED_CODE,
} from "../src/serve/handlers/workspace_handlers.ts";
import { hostRootWorkspaces } from "../src/serve/host_root_workspaces.ts";
import type { ListenedServe } from "../src/serve/listening_line.ts";
import { loadServeConfig } from "../src/serve/serve_config.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeProcessPort,
} from "../src/serve/host/serve_process.ts";
import { createStatusWriter } from "../src/serve/host/status_writer.ts";
import { createServeSupervisor } from "../src/serve/host/supervisor.ts";
import { createWorkspaceReconciler } from "../src/serve/host/workspace_reconciler.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  sendRequest,
  type ServeCtxOptions,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const ALICE: Principal = { kind: "user", id: "sub-alice" };
const BOB: Principal = { kind: "user", id: "sub-bob" };
const HOST_ADDRESS = "https://host.example";
const ROOT_ACCESS: HostedWorkspaceRootAccess = {
  mode: "oauth",
  oauthProvider: "https://club.example",
  allowedUsers: [],
  allowedCollectives: [],
  nameCache: {},
};
const ROOT_ADMIN_GRANT = (subject: string) =>
  grant({
    subject: { kind: "user", name: subject },
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
  });
const CHANGES = [
  "workspace.get",
  "workspace.suspend",
  "workspace.resume",
  "workspace.delete",
] as const;

/** a spawned child is ready at once and exits when asked */
class CountingPort implements ServeProcessPort {
  spawned: string[] = [];
  spawn(spec: Parameters<ServeProcessPort["spawn"]>[0]): ServeChild {
    this.spawned.push(spec.id.kind === "workspace" ? spec.id.name : "root");
    const exited = Promise.withResolvers<ServeChildExit>();
    const exit = () => exited.resolve({ code: 0, stderrTail: [] });
    return {
      listening: Promise.resolve<ListenedServe>({
        port: 40_000,
        authMode: "oauth",
      }),
      ready: Promise.resolve(),
      exited: exited.promise,
      terminate: exit,
      reload: () => {},
      kill: exit,
      release: () => Promise.resolve(),
    };
  }
}

interface Root {
  readonly repo: ServeRepo;
  readonly workspacesDir: string;
  readonly port: CountingPort;
  /** a root context over the host folder, deciding the given grants */
  ctx(options?: ServeCtxOptions): ConnectionContext;
  /** one host rescan, as the folder watcher runs it */
  rescan(): Promise<void>;
}

async function withRoot(fn: (root: Root) => Promise<void>): Promise<void> {
  await withServeRepo(async (repo) => {
    const hostDir = await Deno.makeTempDir({ prefix: "swamp-host-" });
    const workspacesDir = join(hostDir, "workspaces");
    await Deno.mkdir(workspacesDir);
    const port = new CountingPort();
    const statusWriter = createStatusWriter({ workspacesDir, retryMs: 10 });
    const supervisor = createServeSupervisor({
      processPort: port,
      onStatus: (status) => statusWriter.report(status),
    });
    const reconciler = createWorkspaceReconciler({
      workspacesDir,
      supervisor,
      specOf: (name) => ({
        id: workspaceServe(name),
        repoDir: join(workspacesDir, name),
        address: `${HOST_ADDRESS}/w/${name}`,
        trustedHost: "host.example",
        env: {},
      }),
      repository: new HostedWorkspaceFileRepository(workspacesDir),
      statusWriter,
    });
    const root = hostRootWorkspaces(
      { dir: workspacesDir, address: HOST_ADDRESS },
      {},
      () => ROOT_ACCESS,
    )!;
    const hostedWorkspaces = {
      ...root,
      services: {
        ...root.services,
        provisioner: {
          provision: (dir, spec) => provisionHostedWorkspace(dir, spec),
        },
      },
    } satisfies ConnectionContext["hostedWorkspaces"];
    try {
      await fn({
        repo,
        workspacesDir,
        port,
        ctx: (options = {}) =>
          createServeCtx(
            repo,
            [ROOT_ADMIN_GRANT(ALICE.id), ROOT_ADMIN_GRANT("alice")],
            {
              authMode: "oauth",
              resolvedUserNames: { [ALICE.id]: "alice", [BOB.id]: "bob" },
              hostedWorkspaces,
              ...options,
            },
          ),
        rescan: async () =>
          await reconciler.reconcile(await scanWorkspaces(workspacesDir)),
      });
    } finally {
      await supervisor.shutdown();
      await reconciler.drain();
      await statusWriter.drain();
      if (Deno.build.os === "windows") {
        await Deno.remove(hostDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(hostDir, { recursive: true });
      }
    }
  });
}

function request(type: string, name?: string) {
  return {
    type,
    id: crypto.randomUUID(),
    ...(name === undefined ? {} : { payload: { name } }),
  };
}

function reply(frames: Frame[], type: string): Record<string, unknown> {
  const frame = frames.find((f) => f.type === type);
  assert(frame, `no ${type} reply in ${JSON.stringify(frames)}`);
  return (frame.payload as { data: Record<string, unknown> }).data;
}

function recordAudit(ctx: ConnectionContext): AuditEvent[] {
  const audit: AuditEvent[] = [];
  (ctx as { auditEmitter?: unknown }).auditEmitter = {
    emit: (event: AuditEvent) => audit.push(event),
  };
  return audit;
}

Deno.test("serve workspace requests: a root admin creates, lists, gets, resumes, suspends and deletes a workspace, and only resume starts it", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    const created = reply(
      await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE),
      "workspace.create",
    );
    assertEquals(created, {
      name: "edge-dns",
      address: `${HOST_ADDRESS}/w/edge-dns`,
      wanted: "suspended",
    });
    const stored = await new HostedWorkspaceFileRepository(root.workspacesDir)
      .findByName("edge-dns");
    assert(stored.kind === "found");
    assertEquals(stored.workspace.creator, "user:sub-alice");
    const auth = loadServeConfig(
      undefined,
      join(root.workspacesDir, "edge-dns"),
    )
      ?.auth;
    assertEquals(auth?.admins, ["alice"]);

    await root.rescan();
    await root.rescan();
    assertEquals(root.port.spawned, [], "create starts no serve");
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), ALICE),
      "workspace.list",
    ) as { workspaces: { name: string; wanted: string }[] };
    assertEquals(
      listed.workspaces.map(({ name, wanted }) => ({ name, wanted })),
      [{ name: "edge-dns", wanted: "suspended" }],
    );
    const got = reply(
      await sendRequest(ctx, request("workspace.get", "edge-dns"), ALICE),
      "workspace.get",
    );
    assertEquals(got.address, `${HOST_ADDRESS}/w/edge-dns`);
    assertEquals(got.wanted, "suspended");

    const resumed = reply(
      await sendRequest(ctx, request("workspace.resume", "edge-dns"), ALICE),
      "workspace.resume",
    );
    assertEquals(resumed.wanted, "active");
    await root.rescan();
    assertEquals(root.port.spawned, ["edge-dns"]);

    for (
      const [type, wanted] of [
        ["workspace.suspend", "suspended"],
        ["workspace.delete", "deleted"],
      ] as const
    ) {
      const changed = reply(
        await sendRequest(ctx, request(type, "edge-dns"), ALICE),
        type,
      );
      assertEquals(changed.wanted, wanted, type);
    }
  });
});

Deno.test("serve workspace requests: a caller who is not a root admin may list and is refused everything else", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), BOB),
      "workspace.list",
    ) as { workspaces: { name: string }[] };
    assertEquals(listed.workspaces.map((w) => w.name), ["edge-dns"]);
    for (const type of ["workspace.create", ...CHANGES]) {
      const frames = await sendRequest(ctx, request(type, "edge-dns"), BOB);
      assertEquals(errorFrame(frames)?.error?.code, "unauthorized", type);
    }
    const stored = await new HostedWorkspaceFileRepository(root.workspacesDir)
      .findByName("edge-dns");
    assert(stored.kind === "found");
    assertEquals(stored.workspace.wanted, "suspended");
  });
});

Deno.test("serve workspace requests: a caller acting through an integration is refused list", async () => {
  await withRoot(async (root) => {
    const frames = await sendRequest(
      root.ctx(),
      request("workspace.list"),
      ALICE,
      { client: "integration:dash" },
    );
    assertEquals(errorFrame(frames)?.error?.code, "unauthorized");
  });
});

Deno.test("serve workspace requests: a serve that is not a host's root refuses every request", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx({ hostedWorkspaces: undefined });
    for (const type of ["workspace.create", "workspace.list", ...CHANGES]) {
      const name = type === "workspace.list" ? undefined : "edge-dns";
      const frames = await sendRequest(ctx, request(type, name), ALICE);
      const error = errorFrame(frames)?.error;
      assertEquals(error?.code, NOT_A_HOST_ROOT_CODE, type);
      assertStringIncludes(error?.message ?? "", "root of a swamp serve host");
    }
    assertEquals((await scanWorkspaces(root.workspacesDir)).wantedFiles, []);
  });
});

Deno.test("serve workspace requests: a token-mode root refuses create, naming why, and still suspends and resumes", async () => {
  await withRoot(async (root) => {
    await sendRequest(
      root.ctx(),
      request("workspace.create", "edge-dns"),
      ALICE,
    );
    const tokenRoot = root.ctx({ authMode: "token" });
    const alice: Principal = { kind: "user", id: "alice" };
    const refused = errorFrame(
      await sendRequest(
        tokenRoot,
        request("workspace.create", "billing"),
        alice,
      ),
    )?.error;
    assertEquals(refused?.code, TOKEN_MODE_CREATE_REFUSED_CODE);
    assertStringIncludes(refused?.message ?? "", "token mode");
    assertEquals(
      (await scanWorkspaces(root.workspacesDir)).wantedFiles,
      ["edge-dns"],
    );
    for (
      const [type, wanted] of [
        ["workspace.resume", "active"],
        ["workspace.suspend", "suspended"],
      ] as const
    ) {
      const changed = reply(
        await sendRequest(tokenRoot, request(type, "edge-dns"), alice),
        type,
      );
      assertEquals(changed.wanted, wanted, type);
    }
  });
});

Deno.test("serve workspace requests: each request, allowed or refused, is audited with the caller and the workspace name", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    const audit = recordAudit(ctx);
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    await sendRequest(ctx, request("workspace.list"), BOB);
    await sendRequest(ctx, request("workspace.delete", "edge-dns"), BOB);
    const notRoot = root.ctx({ hostedWorkspaces: undefined });
    const notRootAudit = recordAudit(notRoot);
    await sendRequest(notRoot, request("workspace.get", "edge-dns"), ALICE);

    const responses = [...audit, ...notRootAudit]
      .filter((event) =>
        event.stage === "response" && event.resourceKind === "workspace"
      )
      .map(({ action, resourceKind, resourceName, principalId, outcome }) => ({
        action,
        resourceKind,
        resourceName,
        principalId,
        outcome,
      }));
    assertEquals(responses, [
      {
        action: "workspace.create",
        resourceKind: "workspace",
        resourceName: "edge-dns",
        principalId: ALICE.id,
        outcome: "success",
      },
      {
        action: "workspace.list",
        resourceKind: "workspace",
        resourceName: "*",
        principalId: BOB.id,
        outcome: "success",
      },
      {
        action: "workspace.delete",
        resourceKind: "workspace",
        resourceName: "edge-dns",
        principalId: BOB.id,
        outcome: "failure",
      },
      {
        action: "workspace.get",
        resourceKind: "workspace",
        resourceName: "edge-dns",
        principalId: ALICE.id,
        outcome: "failure",
      },
    ]);
    assert(
      audit.some((event) =>
        event.outcome === "denied" && event.principalId === BOB.id
      ),
      "the refused delete's denial is audited",
    );
  });
});
