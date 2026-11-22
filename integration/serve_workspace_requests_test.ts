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
import { parse as parseYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import {
  hostSwitcherEntries,
  parseHostWorkspaceList,
} from "../packages/dashboard/src/client/host_workspace_list.ts";
import { provisionHostedWorkspace } from "../src/cli/hosted_workspace_provision.ts";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import type { DelegationLookup } from "../src/domain/access/delegation_directory.ts";
import type { IntegrationLookup } from "../src/domain/access/integration_directory.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { DelegationRecord } from "../src/domain/models/access/delegation_model.ts";
import { workspaceServe } from "../src/domain/serve/managed_serve.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { HostedWorkspaceFileRepository } from "../src/infrastructure/persistence/hosted_workspace_file_repository.ts";
import { scanWorkspaces } from "../src/infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { HostedWorkspaceRootAccess } from "../src/libswamp/hosted_workspace/deps.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
} from "../src/serve/handlers/workspace_handlers.ts";
import {
  hostRootWorkspaces,
  hostWorkspacePlacement,
} from "../src/serve/host_root_workspaces.ts";
import { createdWorkspaceRemoval } from "../src/serve/host/serve_host.ts";
import {
  hostConfiguredParent,
  hostWorkspaceStore,
  RegistryProblemLog,
} from "../src/serve/host/workspace_registration.ts";
import { createWorkspaceRoster } from "../src/serve/host/workspace_roster.ts";
import type { ListenedServe } from "../src/serve/listening_line.ts";
import { loadServeConfig } from "../src/serve/serve_config.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeProcessPort,
} from "../src/serve/host/serve_process.ts";
import { createStatusWriter } from "../src/serve/host/status_writer.ts";
import { createServeSupervisor } from "../src/serve/host/supervisor.ts";
import {
  createWorkspaceReconciler,
  readWantedFiles,
} from "../src/serve/host/workspace_reconciler.ts";
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
  /** the host's state folder */
  readonly workspacesDir: string;
  /** where a create puts the repo */
  readonly location: string;
  readonly port: CountingPort;
  /** a root context over the host, deciding Alice's root admin and the given grants */
  ctx(options?: ServeCtxOptions, grants?: Grant[]): ConnectionContext;
  /** one host rescan, as the folder watcher runs it */
  rescan(): Promise<void>;
  tokenCtx(): ConnectionContext;
  readonly hosted: NonNullable<ConnectionContext["hostedWorkspaces"]>;
  importRepo(name: string): Promise<string>;
  corruptRegistry(): Promise<void>;
}

async function withRoot(fn: (root: Root) => Promise<void>): Promise<void> {
  await withServeRepo(async (repo) => {
    const hostDir = await Deno.makeTempDir({ prefix: "swamp-host-" });
    const workspacesDir = join(hostDir, "state");
    await Deno.mkdir(workspacesDir);
    // a registry and data dir inside the temp folder, never the user's
    const dataDir = join(hostDir, "data");
    const configDir = join(hostDir, "config");
    const store = hostWorkspaceStore({ dataDir, configDir });
    const port = new CountingPort();
    const statusWriter = createStatusWriter({ workspacesDir, retryMs: 10 });
    const supervisor = createServeSupervisor({
      processPort: port,
      onStatus: (status) => statusWriter.report(status),
    });
    const problems = new RegistryProblemLog();
    const wantedRepository = new HostedWorkspaceFileRepository(workspacesDir);
    const reconciler = createWorkspaceReconciler({
      workspacesDir,
      supervisor,
      specOf: (name, folder) => ({
        id: workspaceServe(name),
        repoDir: folder,
        address: `${HOST_ADDRESS}/w/${name}`,
        trustedHost: "host.example",
        env: {},
      }),
      repository: wantedRepository,
      statusWriter,
      created: createdWorkspaceRemoval({
        workspaceStore: store,
        configuredParent: hostConfiguredParent(configDir),
        stateDir: workspacesDir,
      }),
    });
    const roster = createWorkspaceRoster({
      rootRepo: null,
      store,
      problems,
    });
    const root = hostRootWorkspaces(
      { dir: workspacesDir, address: HOST_ADDRESS },
      {},
      () => ROOT_ACCESS,
      () => store,
      () => hostWorkspacePlacement({ dataDir, configDir }),
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
        location: join(dataDir, "workspaces"),
        port,
        ctx: (options = {}, grants = []) =>
          createServeCtx(
            repo,
            [ROOT_ADMIN_GRANT(ALICE.id), ROOT_ADMIN_GRANT("alice"), ...grants],
            {
              authMode: "oauth",
              resolvedUserNames: { [ALICE.id]: "alice", [BOB.id]: "bob" },
              hostedWorkspaces,
              ...options,
            },
          ),
        rescan: async () => {
          const scan = await scanWorkspaces(workspacesDir);
          const reads = await readWantedFiles(wantedRepository, scan);
          reconciler.reconcile(scan, reads, await roster.read(reads));
        },
        tokenCtx: () =>
          createServeCtx(repo, [ROOT_ADMIN_GRANT("alice")], {
            authMode: "token",
            hostedWorkspaces: {
              ...hostedWorkspaces,
              rootAccess: () => ({ ...ROOT_ACCESS, mode: "token" }),
            },
          }),
        hosted: hostedWorkspaces,
        corruptRegistry: () =>
          Deno.writeTextFile(
            join(hostDir, "config", "workspaces.json"),
            "{not json",
          ),
        importRepo: async (name) => {
          const made = join(hostDir, "projects", name);
          await Deno.mkdir(made, { recursive: true });
          await Deno.writeTextFile(join(made, ".swamp.yaml"), "");
          const folder = await Deno.realPath(made);
          await store.registry.update((registry) => {
            registry.register({ name, path: folder, createdAt: "t" });
          });
          return folder;
        },
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
      join(root.location, "edge-dns"),
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

Deno.test("serve workspace requests: a caller who is not a root admin, signed in through the CLI, lists every workspace and is refused everything else", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const cli = { client: "direct:cli" };
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), BOB, cli),
      "workspace.list",
    ) as { workspaces: { name: string }[] };
    assertEquals(listed.workspaces.map((w) => w.name), ["edge-dns"]);
    for (const type of ["workspace.create", ...CHANGES]) {
      const frames = await sendRequest(
        ctx,
        request(type, "edge-dns"),
        BOB,
        cli,
      );
      assertEquals(errorFrame(frames)?.error?.code, "unauthorized", type);
    }
  });
});

Deno.test("serve workspace requests: a caller acting through an integration whose ceiling names no workspace lists none", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), ALICE, {
        client: "integration:dash",
      }),
      "workspace.list",
    ) as { workspaces: unknown[] };
    assertEquals(listed.workspaces, []);
  });
});

Deno.test("serve workspace requests: the dashboard switcher reads the root's list as each workspace's name and state, and a resumed workspace changes state at the next read", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    for (const name of ["edge-dns", "cost"]) {
      await sendRequest(ctx, request("workspace.create", name), ALICE);
    }
    await root.rescan();
    const dashboard = { client: "direct:dashboard" };
    const read = async () =>
      parseHostWorkspaceList(
        (await sendRequest(ctx, request("workspace.list"), BOB, dashboard))
          .find((f) => f.type === "workspace.list")?.payload,
      );
    const first = await read();
    assertEquals(first?.map((w) => w.name), ["cost", "edge-dns"]);
    assert(first?.every((w) => w.state !== "ready"));
    assertEquals(
      hostSwitcherEntries("edge-dns", first).map((e) => e.href),
      ["/dashboard/", "/dashboard/w/cost/", "/dashboard/w/edge-dns/"],
    );

    await sendRequest(ctx, request("workspace.resume", "edge-dns"), ALICE);
    await root.rescan();
    await waitFor(
      async () =>
        (await read())?.find((w) => w.name === "edge-dns")?.state === "ready",
      "edge-dns listed ready",
    );
    const after = await read();
    assertEquals(
      after?.find((w) => w.name === "cost")?.state,
      first?.[0].state,
    );
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

Deno.test("serve workspace requests: a token-mode root creates a workspace whose admin is its creator, and suspends and resumes it", async () => {
  await withRoot(async (root) => {
    const tokenRoot = root.tokenCtx();
    const alice: Principal = { kind: "user", id: "alice" };
    const created = reply(
      await sendRequest(
        tokenRoot,
        request("workspace.create", "billing"),
        alice,
      ),
      "workspace.create",
    );
    assertEquals(created.name, "billing");
    const auth = loadServeConfig(undefined, join(root.location, "billing"))
      ?.auth;
    assertEquals(auth?.mode, "token");
    assertEquals(auth?.admins, ["user:alice"]);
    for (
      const [type, wanted] of [
        ["workspace.resume", "active"],
        ["workspace.suspend", "suspended"],
      ] as const
    ) {
      const changed = reply(
        await sendRequest(tokenRoot, request(type, "billing"), alice),
        type,
      );
      assertEquals(changed.wanted, wanted, type);
    }
  });
});

const ROOT_TOKEN_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const ALICE_LOGIN = {
  tokenExpiresAt: ROOT_TOKEN_EXPIRES_AT,
  identity: { username: "alice", email: "alice@example.com" },
  collectives: ["acme"],
  groups: ["ops"],
};

Deno.test("serve workspace requests: any person signed in to the root gets a code the named workspace redeems once for who they are", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const issued = reply(
      await sendRequest(ctx, request("workspace.sign-in", "edge-dns"), BOB, {
        login: { ...ALICE_LOGIN, identity: { username: "bob" } },
      }),
      "workspace.sign-in",
    ) as { name: string; code: string; expiresAt: string };
    assertEquals(issued.name, "edge-dns");
    assert(Date.parse(issued.expiresAt) - Date.now() <= 60_000);
    assertEquals(
      await root.hosted.signInCodes.redeem(issued.code, "edge-dns"),
      {
        kind: "redeemed",
        grant: {
          principal: "user:sub-bob",
          username: "bob",
          email: null,
          collectives: ["acme"],
          groups: ["ops"],
          expiresAt: ROOT_TOKEN_EXPIRES_AT,
        },
      },
    );
    assertEquals(
      await root.hosted.signInCodes.redeem(issued.code, "edge-dns"),
      { kind: "unknown" },
    );
  });
});

Deno.test("serve workspace requests: sign-in tells no one which workspaces exist, and an invalid name issues nothing", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    const unknown = await sendRequest(
      ctx,
      request("workspace.sign-in", "no-such-workspace"),
      ALICE,
      { login: ALICE_LOGIN },
    );
    reply(unknown, "workspace.sign-in");
    const invalid = await sendRequest(
      ctx,
      request("workspace.sign-in", "Edge-DNS"),
      ALICE,
      { login: ALICE_LOGIN },
    );
    assertEquals(errorFrame(invalid)?.error?.code, "user_error");
    assertEquals(root.hosted.signInCodes.size, 1);
  });
});

Deno.test("serve workspace requests: sign-in is refused to an integration, a worker, a socket with no token expiry, a none-mode root and a serve that is no root", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const cases: [string, Promise<Frame[]>][] = [
      [
        SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
        sendRequest(ctx, request("workspace.sign-in", "edge-dns"), ALICE, {
          client: "integration:dash",
          login: ALICE_LOGIN,
        }),
      ],
      [
        SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
        sendRequest(
          ctx,
          request("workspace.sign-in", "edge-dns"),
          { kind: "worker", id: "edge-1" },
          { login: ALICE_LOGIN },
        ),
      ],
      [
        SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
        sendRequest(ctx, request("workspace.sign-in", "edge-dns"), ALICE),
      ],
      [
        SIGN_IN_NOT_OFFERED_CODE,
        sendRequest(
          createServeCtx(root.repo, undefined, {
            hostedWorkspaces: root.hosted,
          }),
          request("workspace.sign-in", "edge-dns"),
          null,
        ),
      ],
      [
        NOT_A_HOST_ROOT_CODE,
        sendRequest(
          root.ctx({ hostedWorkspaces: undefined }),
          request("workspace.sign-in", "edge-dns"),
          ALICE,
          { login: ALICE_LOGIN },
        ),
      ],
    ];
    for (const [code, frames] of cases) {
      assertEquals(errorFrame(await frames)?.error?.code, code);
    }
    assertEquals(root.hosted.signInCodes.size, 0);
  });
});

Deno.test("serve workspace requests: a direct CLI client signs in like any person", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const frames = await sendRequest(
      ctx,
      request("workspace.sign-in", "edge-dns"),
      ALICE,
      { client: "direct:cli", login: ALICE_LOGIN },
    );
    reply(frames, "workspace.sign-in");
  });
});

Deno.test("serve workspace requests: a sign-in is audited with the caller and the workspace, and the code is in no audit record", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx();
    await sendRequest(ctx, request("workspace.create", "edge-dns"), ALICE);
    const audit = recordAudit(ctx);
    const issued = reply(
      await sendRequest(ctx, request("workspace.sign-in", "edge-dns"), ALICE, {
        login: ALICE_LOGIN,
      }),
      "workspace.sign-in",
    ) as { code: string };
    const response = audit.find((event) =>
      event.action === "workspace.sign-in" && event.stage === "response"
    );
    assertEquals(response?.principalId, ALICE.id);
    assertEquals(response?.resourceName, "edge-dns");
    assertEquals(response?.outcome, "success");
    assert(!JSON.stringify(audit).includes(issued.code.split(".")[1]));
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
        action: "admin",
        resourceKind: "workspace",
        resourceName: "edge-dns",
        principalId: BOB.id,
        outcome: "denied",
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
  });
});

const workspaceGrant = (
  subject: Principal,
  actions: Grant["actions"],
  pattern: string,
  effect: Grant["effect"] = "allow",
): Grant =>
  grant({
    subject: { kind: "user", name: subject.id },
    effect,
    actions,
    resource: { kind: "workspace", pattern },
  });

/** whether the request got past authorization, whatever the services then said */
async function admittedTo(
  ctx: ConnectionContext,
  type: string,
  name: string,
  principal: Principal,
  client?: string,
): Promise<boolean> {
  const frames = await sendRequest(ctx, request(type, name), principal, {
    client,
  });
  return errorFrame(frames)?.error?.code !== "unauthorized";
}

async function seed(root: Root, ...names: string[]): Promise<void> {
  const ctx = root.ctx();
  for (const name of names) {
    reply(
      await sendRequest(ctx, request("workspace.create", name), ALICE),
      "workspace.create",
    );
  }
}

Deno.test("serve workspace requests: write and admin on workspace:data-* create, resume, suspend and delete data-x, and nothing on ops-x", async () => {
  await withRoot(async (root) => {
    await seed(root, "ops-x");
    const ctx = root.ctx({}, [
      workspaceGrant(BOB, ["write", "admin"], "data-*"),
    ]);
    for (
      const type of [
        "workspace.create",
        "workspace.resume",
        "workspace.suspend",
        "workspace.delete",
      ]
    ) {
      const frames = await sendRequest(ctx, request(type, "data-x"), BOB);
      assertEquals(errorFrame(frames), undefined, type);
      assertEquals(
        await admittedTo(ctx, type, "ops-x", BOB),
        false,
        `${type} ops-x`,
      );
    }
  });
});

Deno.test("serve workspace requests: write alone creates data-x and is refused its resume", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx({}, [workspaceGrant(BOB, ["write"], "data-*")]);
    reply(
      await sendRequest(ctx, request("workspace.create", "data-x"), BOB),
      "workspace.create",
    );
    assertEquals(
      await admittedTo(ctx, "workspace.resume", "data-x", BOB),
      false,
    );
  });
});

Deno.test("serve workspace requests: read on workspace:data-x gets it and is refused its suspend", async () => {
  await withRoot(async (root) => {
    await seed(root, "data-x");
    const ctx = root.ctx({}, [workspaceGrant(BOB, ["read"], "data-x")]);
    const got = reply(
      await sendRequest(ctx, request("workspace.get", "data-x"), BOB),
      "workspace.get",
    );
    assertEquals(got.name, "data-x");
    assertEquals(
      await admittedTo(ctx, "workspace.suspend", "data-x", BOB),
      false,
    );
  });
});

Deno.test("serve workspace requests: a deny on workspace:data-x refuses a principal an allow would admit, and a root admin too", async () => {
  await withRoot(async (root) => {
    await seed(root, "data-x", "data-y");
    const ctx = root.ctx({}, [
      workspaceGrant(BOB, ["read", "admin"], "data-*"),
      workspaceGrant(BOB, ["admin"], "data-x", "deny"),
      workspaceGrant(ALICE, ["admin"], "data-x", "deny"),
    ]);
    assertEquals(
      await admittedTo(ctx, "workspace.suspend", "data-y", BOB),
      true,
    );
    assertEquals(
      await admittedTo(ctx, "workspace.suspend", "data-x", BOB),
      false,
    );
    assertEquals(await admittedTo(ctx, "workspace.get", "data-x", BOB), true);
    assertEquals(
      await admittedTo(ctx, "workspace.suspend", "data-x", ALICE),
      false,
    );
  });
});

const WORKSPACE_CEILING = Ceiling.parse({
  version: 1,
  ceiling: [{ actions: ["read"], resource: "workspace:data-*" }],
});
const WORKSPACE_INTEGRATION: IntegrationLookup = {
  standingOf: () => ({ kind: "active", ceiling: WORKSPACE_CEILING }),
};
const CONSENTED_TO_WORKSPACES: DelegationLookup = {
  standingOf: () => ({ kind: "standing", ceiling: WORKSPACE_CEILING }),
  recordOf: (id) => ({ integrationId: id }) as DelegationRecord,
};

Deno.test("serve workspace requests: a delegated caller whose ceiling names workspace:data-* gets and lists data-x, and nothing on ops-x", async () => {
  await withRoot(async (root) => {
    await seed(root, "data-x", "ops-x");
    const ctx = root.ctx(
      {
        integrations: WORKSPACE_INTEGRATION,
        delegations: CONSENTED_TO_WORKSPACES,
      },
      [workspaceGrant(BOB, ["read", "write", "admin"], "*")],
    );
    const app = "integration:app";
    assertEquals(
      await admittedTo(ctx, "workspace.get", "data-x", BOB, app),
      true,
    );
    assertEquals(
      await admittedTo(ctx, "workspace.get", "ops-x", BOB, app),
      false,
    );
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), BOB, { client: app }),
      "workspace.list",
    ) as { workspaces: { name: string }[] };
    assertEquals(listed.workspaces.map((w) => w.name), ["data-x"]);
    for (
      const type of ["workspace.create", "workspace.resume", "workspace.delete"]
    ) {
      assertEquals(
        await admittedTo(ctx, type, "data-y", BOB, app),
        false,
        `${type} is above the ceiling`,
      );
    }
  });
});

Deno.test("serve workspace requests: each refusal of a workspace grant is in the audit log, naming the workspace", async () => {
  await withRoot(async (root) => {
    await seed(root, "data-x");
    const ctx = root.ctx({}, [workspaceGrant(BOB, ["read"], "data-*")]);
    const audit = recordAudit(ctx);
    await sendRequest(ctx, request("workspace.suspend", "data-x"), BOB);
    await sendRequest(ctx, request("workspace.create", "ops-x"), BOB);
    const denials = audit
      .filter((event) => event.outcome === "denied")
      .map(({ action, resourceKind, resourceName, principalId }) => ({
        action,
        resourceKind,
        resourceName,
        principalId,
      }));
    assertEquals(denials, [
      {
        action: "admin",
        resourceKind: "workspace",
        resourceName: "data-x",
        principalId: BOB.id,
      },
      {
        action: "write",
        resourceKind: "workspace",
        resourceName: "ops-x",
        principalId: BOB.id,
      },
    ]);
  });
});

Deno.test("serve workspace requests: a workspace grant on a serve that is not a host's root is accepted, and the request still refused", async () => {
  await withRoot(async (root) => {
    const ctx = root.ctx({ hostedWorkspaces: undefined }, [
      workspaceGrant(BOB, ["read"], "data-*"),
    ]);
    const frames = await sendRequest(
      ctx,
      request("workspace.get", "data-x"),
      BOB,
    );
    assertEquals(errorFrame(frames)?.error?.code, NOT_A_HOST_ROOT_CODE);
  });
});

/** can-i's verdict: a matching deny refuses, else a matching allow admits */
async function canI(
  ctx: ConnectionContext,
  principal: Principal,
  action: string,
  name: string,
  client?: string,
): Promise<boolean> {
  const frames = await sendRequest(
    ctx,
    {
      type: "access.can-i",
      id: crypto.randomUUID(),
      payload: { action, resource: `workspace:${name}` },
    },
    principal,
    { client },
  );
  const payload = frames.find((f) => f.type === "access.can-i")
    ?.payload as { decisions: { effect: string }[] } | undefined;
  assert(payload, JSON.stringify(frames));
  return payload.decisions.length > 0 &&
    payload.decisions.every((d) => d.effect === "allow");
}

Deno.test("serve workspace requests: access can-i answers as the requests do for workspace grants, and lists no grant for a root admin's fallback", async () => {
  await withRoot(async (root) => {
    await seed(root, "data-x", "data-y", "ops-x");
    const grants = [
      workspaceGrant(BOB, ["read", "admin"], "data-*"),
      workspaceGrant(BOB, ["admin"], "data-y", "deny"),
    ];
    const ctx = root.ctx({}, grants);
    const cases = [
      ["read", "workspace.get", "data-x"],
      ["read", "workspace.get", "ops-x"],
      ["admin", "workspace.suspend", "data-x"],
      ["admin", "workspace.suspend", "data-y"],
      ["admin", "workspace.suspend", "ops-x"],
      ["write", "workspace.create", "data-z"],
    ] as const;
    for (const [action, type, name] of cases) {
      assertEquals(
        await canI(ctx, BOB, action, name),
        await admittedTo(ctx, type, name, BOB),
        `${action} ${name}`,
      );
    }
    const delegated = root.ctx(
      {
        integrations: WORKSPACE_INTEGRATION,
        delegations: CONSENTED_TO_WORKSPACES,
      },
      grants,
    );
    const app = "integration:app";
    for (const [action, type, name] of cases) {
      assertEquals(
        await canI(delegated, BOB, action, name, app),
        await admittedTo(delegated, type, name, BOB, app),
        `${action} ${name} through the integration`,
      );
    }
    assertEquals(await canI(ctx, ALICE, "admin", "ops-x"), false);
    assertEquals(
      await admittedTo(ctx, "workspace.suspend", "ops-x", ALICE),
      true,
    );
  });
});

Deno.test("serve workspace requests: admin on a workspace pattern does not reach an imported repo, whose suspend and resume are refused and audited", async () => {
  await withRoot(async (root) => {
    await root.importRepo("data-mine");
    const ctx = root.ctx({}, [
      workspaceGrant(BOB, ["read", "admin"], "data-*"),
    ]);
    const audit = recordAudit(ctx);
    for (const type of ["workspace.resume", "workspace.suspend"]) {
      const frames = await sendRequest(ctx, request(type, "data-mine"), BOB);
      const error = errorFrame(frames)?.error;
      assertEquals(error?.code, "operator_workspace", type);
      assertStringIncludes(String(error?.message), "root's admins");
    }
    const got = reply(
      await sendRequest(ctx, request("workspace.get", "data-mine"), BOB),
      "workspace.get",
    );
    assertEquals(got.owner, "operator");
    const denials = audit
      .filter((event) => event.outcome === "denied")
      .map(({ action, resourceKind, resourceName, principalId }) => ({
        action,
        resourceKind,
        resourceName,
        principalId,
      }));
    assertEquals(denials, [
      {
        action: "admin",
        resourceKind: "workspace",
        resourceName: "data-mine",
        principalId: BOB.id,
      },
      {
        action: "admin",
        resourceKind: "workspace",
        resourceName: "data-mine",
        principalId: BOB.id,
      },
    ]);
    const created = await sendRequest(
      root.ctx({}, [workspaceGrant(BOB, ["write", "admin"], "data-*")]),
      request("workspace.create", "data-made"),
      BOB,
    );
    assertEquals(errorFrame(created), undefined);
    for (const type of ["workspace.resume", "workspace.suspend"]) {
      const frames = await sendRequest(ctx, request(type, "data-made"), BOB);
      assertEquals(errorFrame(frames), undefined, type);
    }
  });
});

Deno.test("serve workspace requests: a root admin resumes and suspends an imported repo, which the host serves from its folder, and is refused its delete", async () => {
  await withRoot(async (root) => {
    const folder = await root.importRepo("mine");
    const ctx = root.ctx();
    await root.rescan();
    assertEquals(root.port.spawned, []);
    const listed = reply(
      await sendRequest(ctx, request("workspace.list"), ALICE),
      "workspace.list",
    ) as { workspaces: { name: string; owner?: string; wanted: string }[] };
    assertEquals(listed.workspaces, [
      { ...listed.workspaces[0], name: "mine", owner: "operator" },
    ]);
    assertEquals(listed.workspaces[0].wanted, "suspended");

    reply(
      await sendRequest(ctx, request("workspace.resume", "mine"), ALICE),
      "workspace.resume",
    );
    const wanted = parseYaml(
      await Deno.readTextFile(join(root.workspacesDir, "mine.wanted.yaml")),
    ) as Record<string, unknown>;
    assertEquals(wanted.folder, folder);
    await root.rescan();
    await waitFor(() => root.port.spawned.includes("mine"), "mine started");

    reply(
      await sendRequest(ctx, request("workspace.suspend", "mine"), ALICE),
      "workspace.suspend",
    );
    const refused = errorFrame(
      await sendRequest(ctx, request("workspace.delete", "mine"), ALICE),
    )?.error;
    assertEquals(refused?.code, "operator_workspace");
    assertStringIncludes(String(refused?.message), "swamp workspace remove");
    assert((await Deno.stat(join(folder, ".swamp.yaml"))).isFile);
  });
});

Deno.test("serve workspace requests: create refuses the name of an imported repo", async () => {
  await withRoot(async (root) => {
    await root.importRepo("mine");
    const error = errorFrame(
      await sendRequest(root.ctx(), request("workspace.create", "mine"), ALICE),
    )?.error;
    assertEquals(error?.code, "already_exists");
  });
});

Deno.test("serve workspace requests: while the registry cannot be read, an imported repo keeps its refusals", async () => {
  await withRoot(async (root) => {
    await root.importRepo("data-personal");
    const admin = root.ctx();
    reply(
      await sendRequest(
        admin,
        request("workspace.suspend", "data-personal"),
        ALICE,
      ),
      "workspace.suspend",
    );
    await root.corruptRegistry();

    const grantee = root.ctx({}, [
      workspaceGrant(BOB, ["read", "admin"], "data-*"),
    ]);
    const audit = recordAudit(grantee);
    const resumed = errorFrame(
      await sendRequest(
        grantee,
        request("workspace.resume", "data-personal"),
        BOB,
      ),
    )?.error;
    assertEquals(resumed?.code, "operator_workspace");
    assertEquals(
      audit.filter((e) => e.outcome === "denied").map((e) => e.resourceName),
      ["data-personal"],
    );
    const deleted = errorFrame(
      await sendRequest(
        admin,
        request("workspace.delete", "data-personal"),
        ALICE,
      ),
    )?.error;
    assertEquals(deleted?.code, "operator_workspace");
    const wanted = parseYaml(
      await Deno.readTextFile(
        join(root.workspacesDir, "data-personal.wanted.yaml"),
      ),
    ) as Record<string, unknown>;
    assertEquals(wanted.wanted, "suspended");
  });
});
