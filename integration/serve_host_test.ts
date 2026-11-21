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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import type { AuthMode } from "../src/domain/access/serve_auth_config.ts";
import { UserError } from "../src/domain/errors.ts";
import { serveIdKey } from "../src/domain/serve/managed_serve.ts";
import type { WorkspaceOrigin } from "../src/domain/workspace/workspace_registry.ts";
import { HostConfig } from "../src/serve/host/host_config.ts";
import { hostLayout } from "../src/serve/host/host_layout.ts";
import {
  type ServeHost,
  type ServeHostOptions,
  startServeHost,
} from "../src/serve/host/serve_host.ts";
import type { RootWorkspace } from "../src/serve/host/root_workspace.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeChildSpec,
  ServeProcessPort,
} from "../src/serve/host/serve_process.ts";
import type { ListenedServe } from "../src/serve/listening_line.ts";
import type { WorkspaceChange } from "../src/serve/host/workspace_folder.ts";
import {
  hostConfiguredParent,
  hostWorkspaceStore,
} from "../src/serve/host/workspace_registration.ts";
import { WorkspaceRegistryFileRepository } from "../src/infrastructure/persistence/workspace_registry_file_repository.ts";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { HOST_STATE_LOCK_FILE } from "../src/infrastructure/persistence/host_state_lock.ts";
import { deletingFolderName } from "../src/infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { locateHostConfig } from "../src/cli/commands/serve_host.ts";
import {
  hostRootWorkspaces,
  hostWorkspacePlacement,
} from "../src/serve/host_root_workspaces.ts";
import { hostedWorkspaceCreate } from "../src/libswamp/hosted_workspace/create.ts";
import { hostedWorkspaceList } from "../src/libswamp/hosted_workspace/list.ts";
import { hostedWorkspaceDelete } from "../src/libswamp/hosted_workspace/delete.ts";
import type { HostedWorkspaceProvisionSpec } from "../src/libswamp/hosted_workspace/deps.ts";
import { provisionHostedWorkspace } from "../src/cli/hosted_workspace_provision.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  TEST_CA_PEM,
  TEST_LOCALHOST_CERT_PEM,
  TEST_LOCALHOST_KEY_PEM,
} from "./serve_host_tls_fixture.ts";

const RESCAN_MS = 50;

interface Echo {
  readonly serve: string;
  readonly path: string;
  readonly prefix: string | null;
}

/** an in-process serve on port 0 that answers /ready and echoes the rest */
class StandIn implements ServeChild {
  readonly listening: Promise<ListenedServe>;
  readonly ready: Promise<void>;
  readonly exited: Promise<ServeChildExit>;
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  readonly #exited = Promise.withResolvers<ServeChildExit>();
  #stopping: Promise<void> | undefined;
  reloads = 0;

  constructor(
    readonly spec: ServeChildSpec,
    authMode: AuthMode,
    private readonly onTerminate: (child: StandIn) => Promise<void>,
  ) {
    const serve = serveIdKey(spec.id);
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/ready") return new Response("ok");
        const echo: Echo = {
          serve,
          path: url.pathname,
          prefix: req.headers.get("x-forwarded-prefix"),
        };
        return Response.json(echo);
      },
    );
    this.listening = Promise.resolve({
      port: this.#server.addr.port,
      authMode,
    });
    this.ready = Promise.resolve();
    this.exited = this.#exited.promise;
  }

  get serve(): string {
    return serveIdKey(this.spec.id);
  }

  terminate(): void {
    this.#stopping ??= (async () => {
      await this.onTerminate(this);
      await this.#server.shutdown();
      this.#exited.resolve({ code: 0, stderrTail: [] });
    })();
  }

  reload(): void {
    this.reloads++;
  }

  kill(): void {
    this.terminate();
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  /** for a test that ends without a host shutdown */
  async close(): Promise<void> {
    this.terminate();
    await this.#stopping;
  }
}

/** a serve that exits with code 1 before it listens */
class Crashing implements ServeChild {
  readonly listening = Promise.reject(new Error("crashed"));
  readonly ready = Promise.reject(new Error("crashed"));
  readonly exited = Promise.resolve({ code: 1, stderrTail: ["crashed"] });

  constructor(readonly spec: ServeChildSpec) {
    this.listening.catch(() => {});
    this.ready.catch(() => {});
  }

  terminate(): void {}
  reload(): void {}
  kill(): void {}
  release(): Promise<void> {
    return Promise.resolve();
  }
}

class StandInPort implements ServeProcessPort {
  readonly children: StandIn[] = [];
  /** workspaces whose serve crashes at once */
  readonly crashing = new Set<string>();
  crashes = 0;
  readonly events: string[] = [];
  /** the host's own address, probed while each child stops */
  hostUrl: string | null = null;
  /** awaited while each child stops, before it exits */
  onStop: ((serve: string) => Promise<void> | void) | null = null;

  constructor(
    private readonly authModes: Readonly<Record<string, AuthMode>> = {},
  ) {}

  spawn(spec: ServeChildSpec): ServeChild {
    const name = spec.id.kind === "root" ? "root" : spec.id.name;
    if (this.crashing.has(name)) {
      this.crashes++;
      return new Crashing(spec);
    }
    const child = new StandIn(
      spec,
      this.authModes[name] ?? "token",
      async (stopping) => {
        // the host's own 404 proves its listener is still open
        const state = this.hostUrl === null ? "no host" : await fetch(
          `${this.hostUrl}/w/not-a-workspace`,
        ).then(async (r) => {
          await r.body?.cancel();
          return r.status === 404 ? "open" : `status ${r.status}`;
        }, () => "closed");
        this.events.push(`stop ${stopping.serve}: listener ${state}`);
        await this.onStop?.(stopping.serve);
      },
    );
    this.children.push(child);
    this.events.push(`spawn ${child.serve}`);
    return child;
  }

  of(serve: string): StandIn[] {
    return this.children.filter((child) => child.serve === serve);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.children.map((child) => child.close()));
  }
}

interface HostDirs extends AsyncDisposable {
  readonly dir: string;
  /** host.yaml and the registry; relative paths in host.yaml are taken from it */
  readonly configDir: string;
  readonly dataDir: string;
  /** the wanted, status and lock files */
  readonly stateDir: string;
  /** where a create puts a repo */
  readonly location: string;
  readonly registry: WorkspaceRegistryFileRepository;
}

async function hostDirs(): Promise<HostDirs> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-serve-host-" }),
  );
  const configDir = join(dir, "config");
  const dataDir = join(dir, "data");
  await Deno.mkdir(configDir);
  return {
    dir,
    configDir,
    dataDir,
    stateDir: join(dataDir, "host"),
    location: join(dataDir, "workspaces"),
    registry: new WorkspaceRegistryFileRepository(configDir),
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}

/** every repo records one repoId, so a wanted file a create wrote matches the repo in its folder */
const REPO_ID = "test-repo";

async function makeRepo(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, ".swamp.yaml"), `repoId: ${REPO_ID}\n`);
}

async function register(
  h: HostDirs,
  name: string,
  path: string,
  origin?: WorkspaceOrigin,
): Promise<void> {
  await h.registry.update((r) => {
    r.register({
      name,
      path,
      createdAt: "2026-11-20T10:00:00.000Z",
      ...(origin === undefined ? {} : { origin }),
    });
  });
}

async function unregister(h: HostDirs, name: string): Promise<void> {
  await h.registry.update((r) => r.remove(name));
}

async function want(h: HostDirs, name: string, yaml: string): Promise<void> {
  await Deno.mkdir(h.stateDir, { recursive: true });
  await Deno.writeTextFile(join(h.stateDir, `${name}.wanted.yaml`), yaml);
}

/** an imported repo turned on: registered, with an active wanted file naming its folder */
async function makeWorkspace(h: HostDirs, name: string): Promise<string> {
  const folder = join(h.dir, "projects", name);
  await makeRepo(folder);
  await register(h, name, folder);
  await want(h, name, `wanted: active\nfolder: ${folder}\n`);
  return folder;
}

const CREATOR = "user:sub-alice";

/** a workspace as a create left it: in the workspace location, registered as created, its wanted file naming its creator and folder */
async function ownWorkspace(h: HostDirs, name: string): Promise<string> {
  const folder = join(h.location, name);
  await makeRepo(folder);
  await register(h, name, folder, "created");
  await want(
    h,
    name,
    `wanted: active\ncreator: ${CREATOR}\nfolder: ${folder}\nrepoId: ${REPO_ID}\n`,
  );
  return folder;
}

function deleted(folder: string): string {
  return `wanted: deleted\ncreator: ${CREATOR}\nchangedAt: 2026-11-20T11:00:00Z\nfolder: ${folder}\nrepoId: ${REPO_ID}\n`;
}

async function start(
  h: HostDirs,
  yaml: string,
  port: StandInPort,
  supervisor?: ServeHostOptions["supervisor"],
  onWorkspaceChange?: ServeHostOptions["onWorkspaceChange"],
  rootWorkspace?: ServeHostOptions["rootWorkspace"],
): Promise<ServeHost> {
  await Deno.writeTextFile(join(h.configDir, "host.yaml"), yaml);
  return await startServeHost({
    config: HostConfig.parse(
      yaml,
      hostLayout({ configDir: h.configDir, dataDir: h.dataDir }),
    ),
    processPort: port,
    childEnv: { PATH: "/usr/bin" },
    workspaceStore: hostWorkspaceStore({
      dataDir: h.dataDir,
      configDir: h.configDir,
    }),
    configuredParent: hostConfiguredParent(h.configDir),
    rescanMs: RESCAN_MS,
    supervisor,
    onWorkspaceChange,
    rootWorkspace,
  });
}

/** as the command starts it: host.yaml found through the swamp dirs */
async function startLocated(
  h: HostDirs,
  yaml: string,
  port: StandInPort,
): Promise<ServeHost> {
  await Deno.writeTextFile(join(h.configDir, "host.yaml"), yaml);
  const { layout, text } = await withMockedEnv(
    { SWAMP_CONFIG_DIR: h.configDir, SWAMP_HOME: h.dataDir },
    () => locateHostConfig(),
  );
  return await startServeHost({
    config: HostConfig.parse(text, layout),
    processPort: port,
    childEnv: { PATH: "/usr/bin" },
    workspaceStore: hostWorkspaceStore({
      dataDir: h.dataDir,
      configDir: h.configDir,
    }),
    configuredParent: hostConfiguredParent(h.configDir),
    rescanMs: RESCAN_MS,
  });
}

async function get(
  url: string,
  client?: Deno.HttpClient,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, client ? { client } : {});
  return { status: response.status, body: await response.json() };
}

async function answers(url: string, serve: string): Promise<boolean> {
  const { status, body } = await get(url);
  return status === 200 && body.serve === serve;
}

const RESTART_FAST = {
  policy: {
    restartDelayMs: 1,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    crashWindowMs: 600_000,
    maxCrashesInWindow: 2,
  },
};

Deno.test("serve host: a root and two registered workspaces answer at their own addresses", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  const edgeDns = await makeWorkspace(h, "edge-dns");
  await makeWorkspace(h, "cost-reports");
  const port = new StandInPort();
  const host = await start(
    h,
    "address: https://serve.acme.internal\nlisten: {port: 0}\nroot: root-repo\n",
    port,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    assertEquals(host.workspaces, ["cost-reports", "edge-dns"]);
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );

    assertEquals(await get(`${base}/w/edge-dns/api/v1/x`), {
      status: 200,
      body: {
        serve: "workspace:edge-dns",
        path: "/api/v1/x",
        prefix: "/w/edge-dns",
      },
    });
    await waitFor(
      () => answers(`${base}/w/cost-reports/`, "workspace:cost-reports"),
      "cost-reports to answer",
    );
    await waitFor(
      () => answers(`${base}/health`, "root"),
      "the root to answer",
    );
    assertEquals((await get(`${base}/health`)).body.prefix, null);

    const edge = port.of("workspace:edge-dns")[0].spec;
    assertEquals(edge.address, "https://serve.acme.internal/w/edge-dns");
    assertEquals(edge.trustedHost, "serve.acme.internal");
    assertEquals(edge.repoDir, edgeDns);
    assertEquals(edge.env, { PATH: "/usr/bin" });
    assertEquals(edge.oauthClient, null);
    assertEquals(edge.hostWorkspaces, undefined);
    assertEquals(edge.rootAddress, "https://serve.acme.internal");
    assertEquals(
      port.of("workspace:cost-reports")[0].spec.rootAddress,
      "https://serve.acme.internal",
    );
    assertEquals(port.of("root")[0].spec.rootAddress, undefined);
    assertEquals(
      port.of("root")[0].spec.address,
      "https://serve.acme.internal",
    );
    assertEquals(port.of("root")[0].spec.hostWorkspaces, {
      dir: h.stateDir,
      address: "https://serve.acme.internal",
    });
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a workspace registered while the host runs answers, and one whose entry is removed answers 404", async () => {
  await using h = await hostDirs();
  const edgeDns = await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;

    const late = join(h.dir, "projects", "late");
    await makeRepo(late);
    await want(h, "late", `wanted: active\nfolder: ${late}\n`);
    assertEquals((await get(`${base}/w/late/`)).status, 404);
    await register(h, "late", late);
    await waitFor(
      () => answers(`${base}/w/late/`, "workspace:late"),
      "the registered workspace to answer",
    );
    // a host with no root has nowhere for a workspace to sign in through
    assertEquals(port.of("workspace:late")[0].spec.rootAddress, undefined);

    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await unregister(h, "edge-dns");
    await waitFor(
      async () => (await get(`${base}/w/edge-dns/`)).status === 404,
      "the unregistered workspace to answer 404",
    );
    await waitFor(
      () => port.events.some((e) => e.startsWith("stop workspace:edge-dns")),
      "the unregistered workspace's serve to be stopped",
    );
    await waitFor(
      async () => !(await exists(join(h.stateDir, "edge-dns.wanted.yaml"))),
      "its wanted file to be removed",
    );
    assert(await exists(join(edgeDns, ".swamp.yaml")), "its folder is kept");

    await register(h, "edge-dns", edgeDns);
    await want(h, "edge-dns", `wanted: active\nfolder: ${edgeDns}\n`);
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "the re-imported workspace to answer",
    );
    assertEquals(port.of("workspace:edge-dns").length, 2);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a workspace that failed starts again when its entry is removed and registered again", async () => {
  await using h = await hostDirs();
  const edgeDns = await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  port.crashing.add("edge-dns");
  const host = await start(h, NO_ROOT, port, RESTART_FAST);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(async () => {
      const { status, body } = await get(`${base}/w/edge-dns/`);
      return status === 503 && body.state === "failed";
    }, "the crashing workspace to fail");
    const crashes = port.crashes;

    await unregister(h, "edge-dns");
    await waitFor(
      async () => (await get(`${base}/w/edge-dns/`)).status === 404,
      "the unregistered workspace to answer 404",
    );
    assertEquals(port.crashes, crashes, "a removed workspace is not restarted");
    await waitFor(
      async () => !(await exists(join(h.stateDir, "edge-dns.wanted.yaml"))),
      "its wanted file to be removed",
    );

    port.crashing.delete("edge-dns");
    await register(h, "edge-dns", edgeDns);
    await want(h, "edge-dns", `wanted: active\nfolder: ${edgeDns}\n`);
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "the re-registered workspace to answer",
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a host with no root answers 404 outside /w/", async () => {
  await using h = await hostDirs();
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const { status, body } = await get(`http://127.0.0.1:${host.port}/health`);
    assertEquals(status, 404);
    assertEquals(body, { error: "No workspace answers at this address." });
    assertEquals(port.children.length, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a reload reaches every ready serve and stops none", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const host = await start(
    h,
    "address: https://serve.acme.internal\nlisten: {port: 0}\nroot: root-repo\n",
    port,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await waitFor(
      () => answers(`${base}/health`, "root"),
      "the root to answer",
    );

    host.reload();
    assertEquals(port.children.map((child) => child.reloads), [1, 1]);
    assert(await answers(`${base}/w/edge-dns/`, "workspace:edge-dns"));
    assertEquals(port.children.length, 2);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: listens with TLS using the certificate host.yaml names", async () => {
  await using h = await hostDirs();
  await Deno.writeTextFile(
    join(h.configDir, "cert.pem"),
    TEST_LOCALHOST_CERT_PEM,
  );
  await Deno.writeTextFile(
    join(h.configDir, "key.pem"),
    TEST_LOCALHOST_KEY_PEM,
  );
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const host = await start(
    h,
    "address: https://localhost\nlisten: {port: 0, cert-file: cert.pem, key-file: key.pem}\n",
    port,
  );
  const client = Deno.createHttpClient({ caCerts: [TEST_CA_PEM] });
  try {
    await waitFor(async () => {
      const { status, body } = await get(
        `https://localhost:${host.port}/w/edge-dns/`,
        client,
      );
      return status === 200 && body.serve === "workspace:edge-dns";
    }, "edge-dns to answer over TLS");
    assertEquals(
      (await get(`https://localhost:${host.port}/w/edge-dns/`, client)).body
        .prefix,
      "/w/edge-dns",
    );
  } finally {
    client.close();
    await host.shutdown();
  }
});

Deno.test("serve host: behind a proxy, declared or not, a workspace in auth mode none is refused unless host.yaml allows it", async () => {
  const cases = [
    { proxy: ["trust-proxy: true"], allow: false },
    { proxy: ["trust-proxy: true"], allow: true },
    // a public address on a loopback listener means an undeclared proxy
    { proxy: [], allow: false },
    { proxy: [], allow: true },
  ];
  for (const { proxy, allow } of cases) {
    await using h = await hostDirs();
    await makeWorkspace(h, "open");
    await makeWorkspace(h, "guarded");
    const port = new StandInPort({ open: "none", guarded: "token" });
    const yaml = [
      "address: https://serve.acme.internal",
      "listen: {port: 0}",
      ...proxy,
      ...(allow ? ["allow-unauthenticated-behind-proxy: true"] : []),
    ].join("\n");
    const host = await start(h, yaml, port);
    try {
      const base = `http://127.0.0.1:${host.port}`;
      await waitFor(
        () => answers(`${base}/w/guarded/`, "workspace:guarded"),
        "the token workspace to answer",
      );
      if (allow) {
        await waitFor(
          () => answers(`${base}/w/open/`, "workspace:open"),
          "the allowed none workspace to answer",
        );
      } else {
        await waitFor(async () => {
          const { status, body } = await get(`${base}/w/open/`);
          return status === 503 && body.state === "refused";
        }, "the none workspace to answer refused");
        assertEquals(
          port.of("workspace:open").length,
          1,
          "a refused serve is not restarted",
        );
      }
    } finally {
      await host.shutdown();
    }
  }
});

Deno.test("serve host: a listener that cannot bind starts no serve", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  using taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = new StandInPort();
  const error = await assertRejects(
    () =>
      start(
        h,
        `address: http://127.0.0.1\nlisten: {port: ${taken.addr.port}}\n`,
        port,
      ),
    UserError,
  );
  assert(error.message.includes("cannot listen"), error.message);
  assertEquals(port.children.length, 0);
});

Deno.test("serve host: a root that is not a swamp repo refuses to start and starts no serve", async () => {
  await using h = await hostDirs();
  await Deno.mkdir(join(h.configDir, "root-repo"));
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const error = await assertRejects(
    () => start(h, `${NO_ROOT}root: root-repo\n`, port),
    UserError,
  );
  assert(error.message.includes("is not a swamp repo"), error.message);
  assertEquals(port.children.length, 0);
});

Deno.test("serve host: the root, every workspace and one registered later are started with the OAuth client host.yaml names", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  await makeWorkspace(h, "edge-dns");
  await makeWorkspace(h, "cost-reports");
  await Deno.mkdir(join(h.configDir, "secrets"));
  await Deno.writeTextFile(
    join(h.configDir, "secrets", "oauth-client"),
    "client-secret\n",
  );
  const port = new StandInPort();
  const host = await start(
    h,
    [
      "address: https://serve.acme.internal",
      "listen: {port: 0}",
      "root: root-repo",
      "oauth-client:",
      "  id: client-123",
      "  secret-file: secrets/oauth-client",
    ].join("\n"),
    port,
  );
  try {
    await makeWorkspace(h, "billing");
    await waitFor(
      () => port.of("workspace:billing").length > 0,
      "the added workspace to be started",
    );
    const expected = {
      id: "client-123",
      secretFile: join(h.configDir, "secrets", "oauth-client"),
    };
    for (
      const serve of [
        "root",
        "workspace:edge-dns",
        "workspace:cost-reports",
        "workspace:billing",
      ]
    ) {
      assertEquals(port.of(serve)[0].spec.oauthClient, expected, serve);
    }
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a missing or empty OAuth client secret file refuses to start, naming the field and the path, and starts no serve", async () => {
  for (const write of [false, true]) {
    await using h = await hostDirs();
    await makeWorkspace(h, "edge-dns");
    const secretFile = join(h.configDir, "oauth-client-secret");
    if (write) await Deno.writeTextFile(secretFile, "  \n");
    const port = new StandInPort();
    const error = await assertRejects(
      () =>
        start(
          h,
          [
            "address: http://127.0.0.1",
            "listen: {port: 0}",
            "oauth-client:",
            "  id: client-123",
            "  secret-file: oauth-client-secret",
          ].join("\n"),
          port,
        ),
      UserError,
    );
    assert(
      error.message.includes("host.yaml oauth-client.secret-file"),
      error.message,
    );
    assert(error.message.includes(secretFile), error.message);
    assert(
      error.message.includes(write ? "is empty" : "not found"),
      error.message,
    );
    assertEquals(port.children.length, 0);
  }
});

Deno.test("serve host: shutdown stops every serve while the listener is still open, then closes it", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  await makeWorkspace(h, "edge-dns");
  await makeWorkspace(h, "cost-reports");
  const port = new StandInPort();
  const host = await start(h, `${NO_ROOT}root: root-repo\n`, port);
  const base = `http://127.0.0.1:${host.port}`;
  port.hostUrl = base;
  try {
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await waitFor(
      () => answers(`${base}/w/cost-reports/`, "workspace:cost-reports"),
      "cost-reports to answer",
    );
    await waitFor(
      () => answers(`${base}/health`, "root"),
      "the root to answer",
    );
    await host.shutdown();
    await host.finished;

    assertEquals(
      port.events.filter((e) => e.startsWith("stop")).sort(),
      [
        "stop root: listener open",
        "stop workspace:cost-reports: listener open",
        "stop workspace:edge-dns: listener open",
      ],
    );
    await assertRejects(() => fetch(`${base}/`));
  } finally {
    await host.shutdown();
    await port.closeAll();
  }
});

async function readStatus(
  h: HostDirs,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    return parseYaml(
      await Deno.readTextFile(join(h.stateDir, `${name}.status.yaml`)),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** what the state folder holds; the host's own lock file is left out */
async function stateEntries(h: HostDirs): Promise<string[]> {
  try {
    return (await Array.fromAsync(Deno.readDir(h.stateDir)))
      .map((e) => e.name).filter((name) => name !== HOST_STATE_LOCK_FILE)
      .sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name)
      .sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function isState(url: string, state: string): Promise<boolean> {
  const { status, body } = await get(url);
  return status === 503 && body.state === state;
}

const NO_ROOT = "address: http://127.0.0.1\nlisten: {port: 0}\n";

Deno.test("serve host: editing a wanted file suspends and resumes a workspace, and its status file follows", async () => {
  await using h = await hostDirs();
  const folder = await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await waitFor(
      async () => (await readStatus(h, "edge-dns"))?.state === "ready",
      "the status file to say ready",
    );

    await want(h, "edge-dns", `wanted: suspended\nfolder: ${folder}\n`);
    await waitFor(
      () => isState(url, "stopped"),
      "the suspended workspace to answer 503",
    );
    await waitFor(async () => {
      const status = await readStatus(h, "edge-dns");
      return status?.state === "stopped" && status.wanted === "suspended";
    }, "the status file to say suspended");
    assert(
      port.events.some((e) => e.startsWith("stop workspace:edge-dns")),
      "the serve was stopped",
    );

    await want(h, "edge-dns", `wanted: active\nfolder: ${folder}\n`);
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "the resumed workspace to answer",
    );
    await waitFor(async () => {
      const status = await readStatus(h, "edge-dns");
      return status?.state === "ready" && status.reason === null &&
        status.wanted === "active";
    }, "the status file to say ready again");
    assertEquals(port.of("workspace:edge-dns").length, 2);
  } finally {
    await host.shutdown();
  }
  assertEquals(
    (await readStatus(h, "edge-dns"))?.state,
    "stopped",
    "the last status lands before shutdown returns",
  );
});

Deno.test("serve host: a failed workspace names its reason and restarts, and resumes when its wanted file is rewritten", async () => {
  await using h = await hostDirs();
  const folder = await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  port.crashing.add("edge-dns");
  const host = await start(h, NO_ROOT, port, RESTART_FAST);
  try {
    const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
    await waitFor(async () => {
      const status = await readStatus(h, "edge-dns");
      return status?.state === "failed";
    }, "the status file to say failed");
    const status = await readStatus(h, "edge-dns");
    assertEquals(status?.reason, "crashed");
    assertEquals(status?.restarts, 1);
    assert(await isState(url, "failed"));

    port.crashing.delete("edge-dns");
    await want(
      h,
      "edge-dns",
      `wanted: active\nchangedAt: 2026-11-17T12:00:00Z\nfolder: ${folder}\n`,
    );
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "the resumed workspace to answer",
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a shutdown marks a failed workspace's status file stopped", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  port.crashing.add("edge-dns");
  const host = await start(h, NO_ROOT, port, RESTART_FAST);
  try {
    await waitFor(
      async () => (await readStatus(h, "edge-dns"))?.state === "failed",
      "the status file to say failed",
    );
  } finally {
    await host.shutdown();
  }
  const status = await readStatus(h, "edge-dns");
  assertEquals(status?.state, "stopped");
  assertEquals(status?.reason, null);
});

Deno.test("serve host: at startup a suspended workspace and a wanted file with no entry start nothing, and the entry's import starts it", async () => {
  await using h = await hostDirs();
  const parked = join(h.dir, "projects", "parked");
  await makeRepo(parked);
  await register(h, "parked", parked);
  await want(h, "parked", `wanted: suspended\nfolder: ${parked}\n`);
  const coming = join(h.dir, "projects", "coming");
  await makeRepo(coming);
  await want(h, "coming", `wanted: active\nfolder: ${coming}\n`);
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    assertEquals(host.workspaces, ["parked"]);
    assert(await isState(`${base}/w/parked/`, "stopped"));
    assertEquals((await get(`${base}/w/coming/`)).status, 404);
    assertEquals(port.children.length, 0);

    await register(h, "coming", coming);
    await waitFor(
      () => answers(`${base}/w/coming/`, "workspace:coming"),
      "the workspace to start once registered",
    );
    assert((await stateEntries(h)).includes("coming.wanted.yaml"));
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a registered repo with no wanted file is listed and stopped until its wanted file says active, while the root starts", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  const folder = join(h.dir, "projects", "edge-dns");
  await makeRepo(folder);
  await register(h, "edge-dns", folder);
  const port = new StandInPort();
  const host = await start(h, `${NO_ROOT}root: root-repo\n`, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    assertEquals(host.workspaces, ["edge-dns"]);
    await waitFor(() => answers(`${base}/health`, "root"), "the root");
    assert(await isState(`${base}/w/edge-dns/`, "stopped"));
    await waitFor(async () => {
      const status = await readStatus(h, "edge-dns");
      return status?.state === "stopped" && status.wanted === "suspended";
    }, "the status file to say stopped");
    assertEquals(port.of("workspace:edge-dns").length, 0);
    assert(
      !(await stateEntries(h)).includes("edge-dns.wanted.yaml"),
      "the host writes no wanted file",
    );

    await want(h, "edge-dns", `wanted: active\nfolder: ${folder}\n`);
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "the workspace to start once wanted active",
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: after a restart a workspace resumed before it is served and one never resumed is not", async () => {
  await using h = await hostDirs();
  const resumed = join(h.dir, "projects", "resumed");
  const never = join(h.dir, "projects", "never");
  await makeRepo(resumed);
  await makeRepo(never);
  await register(h, "resumed", resumed);
  await register(h, "never", never);
  const first = new StandInPort();
  const host = await start(h, NO_ROOT, first);
  try {
    await want(h, "resumed", `wanted: active\nfolder: ${resumed}\n`);
    await waitFor(
      () =>
        answers(
          `http://127.0.0.1:${host.port}/w/resumed/`,
          "workspace:resumed",
        ),
      "the resumed workspace to answer",
    );
  } finally {
    await host.shutdown();
  }
  await first.closeAll();

  const second = new StandInPort();
  const again = await start(h, NO_ROOT, second);
  try {
    const base = `http://127.0.0.1:${again.port}`;
    await waitFor(
      () => answers(`${base}/w/resumed/`, "workspace:resumed"),
      "the resumed workspace to answer after the restart",
    );
    assert(await isState(`${base}/w/never/`, "stopped"));
    assertEquals(second.of("workspace:never").length, 0);
  } finally {
    await again.shutdown();
  }
});

Deno.test("serve host: a created workspace marked deleted is stopped, then its folder, its entry and both files are removed", async () => {
  await using h = await hostDirs();
  const folder = await ownWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const folderAtStop: boolean[] = [];
  port.onStop = async () => {
    folderAtStop.push(await exists(folder));
  };
  const host = await start(h, NO_ROOT, port);
  try {
    const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await want(h, "edge-dns", deleted(folder));
    await waitFor(
      async () => (await stateEntries(h)).length === 0,
      "both files to be removed",
    );
    assertEquals(
      folderAtStop,
      [true],
      "the serve stopped before its folder went",
    );
    assertEquals(await entriesOf(h.location), []);
    assertEquals((await h.registry.load())?.get("edge-dns"), undefined);
    assertEquals((await get(url)).status, 404);
    assertEquals(port.of("workspace:edge-dns").length, 1);
  } finally {
    await host.shutdown();
  }
  assertEquals(await stateEntries(h), [], "no status file comes back");
});

Deno.test("serve host: a delete interrupted before or during the removal finishes at the next start", async () => {
  await using h = await hostDirs();
  const before = await ownWorkspace(h, "edge-dns");
  await want(h, "edge-dns", deleted(before));
  await Deno.writeTextFile(
    join(h.stateDir, "edge-dns.status.yaml"),
    "state: stopped\n",
  );
  // renamed to its hidden name, the entry not yet removed
  const during = join(h.location, "half");
  await register(h, "half", during, "created");
  await want(h, "half", deleted(during));
  await makeRepo(join(h.location, deletingFolderName("half")));
  // a create that stopped before it registered, then deleted
  await want(h, "gone", deleted(join(h.location, "gone")));
  const port = new StandInPort();
  const changes: WorkspaceChange[] = [];
  const host = await start(
    h,
    NO_ROOT,
    port,
    undefined,
    (change) => changes.push(change),
  );
  try {
    assertEquals(host.workspaces, []);
    await waitFor(
      async () => (await stateEntries(h)).length === 0,
      "the files the interrupted deletes left to be removed",
    );
    assertEquals(await entriesOf(h.location), []);
    assertEquals(
      (await h.registry.load())?.list().map((e) => e.name),
      [],
    );
    await makeWorkspace(h, "later");
    await waitFor(
      () => changes.some((c) => c.added.includes("later")),
      "a later workspace to be reported",
    );
    assertEquals(
      changes.flatMap((c) => c.removed),
      [],
      "a workspace never announced is never reported removed",
    );
    assertEquals(port.of("workspace:edge-dns").length, 0);
    assertEquals(
      (await get(`http://127.0.0.1:${host.port}/w/edge-dns/`)).status,
      404,
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: an unreadable wanted file leaves a running workspace running and names the reason", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await want(h, "edge-dns", "wanted: [suspended\n");
    await waitFor(async () => {
      const reason = (await readStatus(h, "edge-dns"))?.reason;
      return typeof reason === "string" && reason.includes("not valid YAML");
    }, "the status file to name the unreadable wanted file");
    assert(await answers(url, "workspace:edge-dns"));
    assertEquals(port.of("workspace:edge-dns").length, 1);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a host shut down while a removal waits on the stopping serve leaves nothing under the workspace's name", async () => {
  await using h = await hostDirs();
  const folder = await ownWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const stopping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  port.onStop = async () => {
    stopping.resolve();
    await release.promise;
  };
  const host = await start(h, NO_ROOT, port);
  try {
    const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
    await waitFor(
      () => answers(url, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await want(h, "edge-dns", deleted(folder));
    await stopping.promise;
    const shutdown = host.shutdown();
    release.resolve();
    await shutdown;
  } finally {
    release.resolve();
    await host.shutdown();
  }
  assert(!(await exists(folder)), "the folder is not left under its name");

  const again = await start(h, NO_ROOT, new StandInPort());
  try {
    assertEquals(again.workspaces, []);
    await waitFor(
      async () => (await stateEntries(h)).length === 0,
      "the next start to leave nothing behind",
    );
    assertEquals(await entriesOf(h.location), []);
  } finally {
    await again.shutdown();
  }
});

function registryFile(h: HostDirs): string {
  return join(h.configDir, "workspaces.json");
}

async function writeRegistry(
  h: HostDirs,
  workspaces: { name: string; path: string }[],
): Promise<void> {
  await Deno.writeTextFile(
    registryFile(h),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: workspaces.map((w) => ({ ...w, createdAt: "t" })),
    }),
  );
}

/** `fn` sees the records as they arrive */
async function hostLogs(
  fn: (records: readonly LogRecord[]) => Promise<void>,
): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "host"],
        lowestLevel: "info",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn(records);
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records;
}

const logText = (record: LogRecord) => record.message.map(String).join("");

function logged(records: readonly LogRecord[], text: string): boolean {
  return records.some((r) =>
    logText(r).includes(text) || String(r.properties.reason).includes(text)
  );
}

Deno.test("serve host registry: a host with no registry file and no workspaces writes no file", async () => {
  await using h = await hostDirs();
  const host = await start(h, NO_ROOT, new StandInPort());
  await host.shutdown();
  assertEquals(await exists(registryFile(h)), false);
});

Deno.test("serve host registry: a registry that cannot be read leaves the host serving each active wanted file's folder, deletes nothing, and is never written", async () => {
  for (
    const content of [
      "{nope",
      JSON.stringify({ schemaVersion: 99, workspaces: [] }),
    ]
  ) {
    await using h = await hostDirs();
    const folder = await ownWorkspace(h, "edge-dns");
    await Deno.writeTextFile(registryFile(h), content);
    const records = await hostLogs(async () => {
      const host = await start(h, NO_ROOT, new StandInPort());
      try {
        const url = `http://127.0.0.1:${host.port}/w/edge-dns/`;
        await waitFor(() => answers(url, "workspace:edge-dns"), "served");
        await want(h, "edge-dns", deleted(folder));
        await waitFor(
          async () => (await get(url)).status === 404,
          "stopped, not removed",
        );
      } finally {
        await host.shutdown();
      }
    });
    assert(logged(records, "cannot be read"));
    assert(await exists(join(folder, ".swamp.yaml")), "its folder is kept");
    assertEquals(await Deno.readTextFile(registryFile(h)), content);
  }
});

Deno.test("serve host registry: a workspace registered by another spelling of its folder is one workspace, served from its real folder, and the registry is left as it is", async () => {
  await using h = await hostDirs();
  const projects = join(h.dir, "projects");
  for (const name of ["edge-dns", "cost-reports"]) {
    await makeRepo(join(projects, name));
    await want(
      h,
      name,
      `wanted: active\nfolder: ${join(projects, name)}\n`,
    );
  }
  await writeRegistry(h, [
    {
      name: "edge-dns",
      path: [projects, "..", "projects", "edge-dns"].join(SEPARATOR),
    },
    { name: "cost-reports", path: join(projects, "cost-reports") + SEPARATOR },
  ]);
  const before = await Deno.readTextFile(registryFile(h));
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    assertEquals(host.workspaces, ["cost-reports", "edge-dns"]);
    for (const name of ["edge-dns", "cost-reports"]) {
      await waitFor(
        () => answers(`${base}/w/${name}/`, `workspace:${name}`),
        `${name} to answer`,
      );
      const children = port.of(`workspace:${name}`);
      assertEquals(children.length, 1);
      assertEquals(children[0].spec.repoDir, join(projects, name));
    }
  } finally {
    await host.shutdown();
  }
  assertEquals(await Deno.readTextFile(registryFile(h)), before);
});

Deno.test("serve host registry: a repo imported while the host runs is listed stopped, served from its folder once resumed, and stopped and forgotten when removed", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const outside = join(h.dir, "projects", "outside");
  await makeRepo(outside);
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await register(h, "outside", outside);
    await waitFor(
      () => isState(`${base}/w/outside/`, "stopped"),
      "outside listed and stopped",
    );
    assertEquals(port.of("workspace:outside").length, 0);
    await waitFor(
      async () => (await readStatus(h, "outside"))?.state === "stopped",
      "outside's status file to say stopped",
    );

    await want(h, "outside", `wanted: active\nfolder: ${outside}\n`);
    await waitFor(
      () => answers(`${base}/w/outside/`, "workspace:outside"),
      "outside served",
    );
    assertEquals(port.of("workspace:outside")[0].spec.repoDir, outside);

    await want(h, "outside", `wanted: suspended\nfolder: ${outside}\n`);
    await waitFor(
      () => isState(`${base}/w/outside/`, "stopped"),
      "outside suspended",
    );

    await unregister(h, "outside");
    await waitFor(
      async () =>
        (await get(`${base}/w/outside/`)).status === 404 &&
        !(await stateEntries(h)).some((e) => e.startsWith("outside.")),
      "outside gone with its files",
    );
    assert(await exists(join(outside, ".swamp.yaml")), "its folder is kept");

    await register(h, "outside", outside);
    await waitFor(
      () => isState(`${base}/w/outside/`, "stopped"),
      "outside listed again",
    );
    assertEquals(port.of("workspace:outside").length, 1);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host registry: a registered folder that is the root's repo gets no second serve", async () => {
  await using h = await hostDirs();
  const root = join(h.configDir, "root-repo");
  await makeRepo(root);
  await register(h, "main", root);
  await want(h, "main", `wanted: active\nfolder: ${root}\n`);
  const port = new StandInPort();
  const host = await start(h, `${NO_ROOT}root: root-repo\n`, port);
  try {
    await waitFor(
      () => answers(`http://127.0.0.1:${host.port}/health`, "root"),
      "the root to answer",
    );
    assertEquals(host.workspaces, []);
    assertEquals(port.of("workspace:main").length, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host registry: a host started on an unreadable registry starts each active wanted file in the folder it names", async () => {
  await using h = await hostDirs();
  const outside = join(h.dir, "projects", "outside");
  await makeRepo(outside);
  await want(h, "outside", `wanted: active\nfolder: ${outside}\n`);
  await want(h, "plain", "wanted: active\n");
  await Deno.writeTextFile(registryFile(h), "{not json");
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(
      () => answers(`${base}/w/outside/`, "workspace:outside"),
      "outside served from the folder its wanted file names",
    );
    assertEquals(port.of("workspace:outside")[0].spec.repoDir, outside);
    assertEquals((await get(`${base}/w/plain/`)).status, 404);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host registry: a registry that turns unreadable while the host runs stops nothing, and no rescan fails", async () => {
  for (const spoil of ["corrupt", "folder"] as const) {
    await using h = await hostDirs();
    await makeWorkspace(h, "edge-dns");
    await ownWorkspace(h, "made");
    const port = new StandInPort();
    const records = await hostLogs(async (seen) => {
      const host = await start(h, NO_ROOT, port);
      try {
        const base = `http://127.0.0.1:${host.port}`;
        await waitFor(
          () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
          "edge-dns to answer",
        );
        await waitFor(
          () => answers(`${base}/w/made/`, "workspace:made"),
          "made to answer",
        );
        if (spoil === "corrupt") {
          await Deno.writeTextFile(registryFile(h), "{nope");
        } else {
          await Deno.remove(registryFile(h));
          await Deno.mkdir(registryFile(h));
        }
        await waitFor(
          () => logged(seen, "cannot be read"),
          `${spoil}: the unreadable registry to be logged`,
        );
        assert(await answers(`${base}/w/edge-dns/`, "workspace:edge-dns"));
        assert(await answers(`${base}/w/made/`, "workspace:made"));
        assertEquals(port.of("workspace:edge-dns").length, 1, "never stopped");
        assertEquals(port.of("workspace:made").length, 1, "never stopped");
      } finally {
        await host.shutdown();
      }
    });
    assertEquals(
      records.filter((r) => logText(r).includes("Rescanning")).map(logText),
      [],
      `${spoil}: no rescan failed`,
    );
  }
});

Deno.test("serve host registry: a registry file removed while the host runs stops nothing and is not written, and its return is read again", async () => {
  await using h = await hostDirs();
  const personal = await makeWorkspace(h, "personal");
  const port = new StandInPort();
  await hostLogs(async (seen) => {
    const host = await start(h, NO_ROOT, port);
    try {
      const base = `http://127.0.0.1:${host.port}`;
      const url = `${base}/w/personal/`;
      await waitFor(() => answers(url, "workspace:personal"), "served");
      const saved = await Deno.readTextFile(registryFile(h));
      await Deno.remove(registryFile(h));
      await waitFor(
        () => logged(seen, "is gone"),
        "the missing registry file to be logged",
      );
      assert(await answers(url, "workspace:personal"));
      assert((await stateEntries(h)).includes("personal.wanted.yaml"));
      assertEquals(
        await exists(registryFile(h)),
        false,
        "the host does not write a registry without the entries it had",
      );

      await Deno.writeTextFile(registryFile(h), saved);
      const later = join(h.dir, "projects", "later");
      await makeRepo(later);
      await register(h, "later", later);
      await waitFor(
        () => isState(`${base}/w/later/`, "stopped"),
        "an entry added after the return to be listed",
      );
      assert(await answers(url, "workspace:personal"));
      assertEquals(port.of("workspace:personal").length, 1, "never restarted");
      assertEquals((await h.registry.load())?.get("personal")?.path, personal);
    } finally {
      await host.shutdown();
    }
  });
});

Deno.test("serve host: reads the config dir's host.yaml, keeps its state under the data dir, serves its root and a resumed registered workspace, and creates and deletes in the workspace location", async () => {
  await using h = await hostDirs();
  const stateDir = h.stateDir;
  await makeRepo(join(h.configDir, "root-repo"));
  await makeRepo(join(h.dir, "projects", "mine"));
  await makeRepo(join(h.dir, "projects", "idle"));
  // a repo someone put in the state folder is never a workspace
  await makeRepo(join(stateDir, "stray"));
  const mine = join(h.dir, "projects", "mine");
  await writeRegistry(h, [
    { name: "mine", path: mine },
    { name: "idle", path: join(h.dir, "projects", "idle") },
  ]);
  await want(h, "mine", `wanted: active\nfolder: ${mine}\n`);
  const port = new StandInPort();
  const host = await startLocated(
    h,
    "address: https://serve.acme.internal\nlisten: {port: 0}\nroot: root-repo\n",
    port,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(() => answers(`${base}/health`, "root"), "the root");
    await waitFor(
      () => answers(`${base}/w/mine/`, "workspace:mine"),
      "the resumed registered workspace",
    );
    await waitFor(() => isState(`${base}/w/idle/`, "stopped"), "idle listed");
    assertEquals((await get(`${base}/w/stray/`)).status, 404);
    assertEquals(port.of("workspace:stray"), []);
    assertEquals(port.of("workspace:mine")[0].spec.repoDir, mine);
    const root = port.of("root")[0].spec;
    assertEquals(root.repoDir, join(h.configDir, "root-repo"));
    assertEquals(root.hostWorkspaces, {
      dir: stateDir,
      address: "https://serve.acme.internal",
    });
    await waitFor(
      async () => (await readStatus(h, "mine"))?.state === "ready",
      "mine's status file in the state folder",
    );

    const dirs = { dataDir: h.dataDir, configDir: h.configDir };
    const rootServices = hostRootWorkspaces(
      {
        dir: root.hostWorkspaces!.dir,
        address: root.hostWorkspaces!.address,
      },
      {},
      () => ({
        mode: "token",
        oauthProvider: null,
        allowedUsers: [],
        allowedCollectives: [],
        nameCache: {},
      }),
      () => hostWorkspaceStore(dirs),
      () => hostWorkspacePlacement(dirs),
    )!.services;
    const services = {
      ...rootServices,
      provisioner: {
        provision: (dir: string, spec: HostedWorkspaceProvisionSpec) =>
          provisionHostedWorkspace(dir, spec),
      },
    };
    const created = await collect(
      hostedWorkspaceCreate(createLibSwampContext(), services, {
        name: "fresh",
        caller: { principal: "user:alice", username: "alice" },
        access: {
          mode: "token",
          oauthProvider: null,
          allowedUsers: [],
          allowedCollectives: [],
          nameCache: {},
        },
      }),
    );
    assertEquals(created.map((e) => e.kind), ["completed"]);
    const fresh = join(h.location, "fresh");
    assert(await exists(join(fresh, ".swamp.yaml")), "fresh is a repo");
    const listed = await collect(
      hostedWorkspaceList(createLibSwampContext(), services),
    );
    const done = listed.find((e) => e.kind === "completed");
    assertEquals(
      done?.kind === "completed"
        ? done.data.workspaces.map((w) => [w.name, w.owner])
        : null,
      [["fresh", "host"], ["idle", "operator"], ["mine", "operator"]],
    );
    await waitFor(() => isState(`${base}/w/fresh/`, "stopped"), "fresh listed");

    const deletedEvents = await collect(
      hostedWorkspaceDelete(createLibSwampContext(), services, {
        name: "fresh",
      }),
    );
    assertEquals(deletedEvents.map((e) => e.kind), ["completed"]);
    await waitFor(
      async () => !(await exists(join(stateDir, "fresh.wanted.yaml"))),
      "fresh's wanted file removed last",
    );
    assert(!(await exists(fresh)), "fresh's folder is removed");
    assertEquals(await entriesOf(dirname(fresh)), []);
    assertEquals(
      (await h.registry.load())?.list().map((e) => e.name).sort(),
      ["idle", "mine"],
    );
    assert(!(await exists(join(stateDir, "fresh.status.yaml"))));
  } finally {
    await host.shutdown();
  }
  assertEquals(
    (await entriesOf(stateDir)).filter((name) =>
      !name.endsWith(".status.yaml")
    ),
    [".host-lock", "mine.wanted.yaml", "stray"],
  );
});

Deno.test("serve host: an operator's wanted file is left byte for byte, the lock and status files the only new entries", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const wanted = join(h.stateDir, "edge-dns.wanted.yaml");
  const before = await Deno.readTextFile(wanted);
  const port = new StandInPort();
  const host = await start(h, NO_ROOT, port);
  try {
    await waitFor(
      () =>
        answers(
          `http://127.0.0.1:${host.port}/w/edge-dns/`,
          "workspace:edge-dns",
        ),
      "edge-dns to answer",
    );
  } finally {
    await host.shutdown();
  }
  assertEquals(await Deno.readTextFile(wanted), before);
  assertEquals(await entriesOf(h.stateDir), [
    ".host-lock",
    "edge-dns.status.yaml",
    "edge-dns.wanted.yaml",
  ]);
});

Deno.test("serve host: a second host on one state folder is refused, the first keeps serving, and a restart after shutdown starts", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const port = new StandInPort();
  const first = await start(h, NO_ROOT, port);
  try {
    const error = await assertRejects(
      () => startLocated(h, NO_ROOT, new StandInPort()),
      UserError,
    );
    assert(error.message.includes(h.stateDir), error.message);
    await waitFor(
      () =>
        answers(
          `http://127.0.0.1:${first.port}/w/edge-dns/`,
          "workspace:edge-dns",
        ),
      "the first host still serves",
    );
  } finally {
    await first.shutdown();
  }
  const again = await start(h, NO_ROOT, new StandInPort());
  await again.shutdown();
});

Deno.test("serve host: a start that fails after taking the lock leaves the state folder free", async () => {
  await using h = await hostDirs();
  await assertRejects(
    () =>
      start(
        h,
        "address: https://serve.acme.internal\nlisten: {port: 0, cert-file: missing.pem, key-file: missing.key}\n",
        new StandInPort(),
      ),
    UserError,
    "listen.cert-file",
  );
  const host = await start(h, NO_ROOT, new StandInPort());
  await host.shutdown();
});

Deno.test("serve host: a workspace whose folder holds the OAuth secret file is not started, though host.yaml names it through a symlinked spelling", async () => {
  await using h = await hostDirs();
  const edgeDns = await makeWorkspace(h, "edge-dns");
  await makeWorkspace(h, "cost-reports");
  const linked = join(h.dir, "linked-projects");
  await Deno.symlink(join(h.dir, "projects"), linked, { type: "dir" });
  await Deno.writeTextFile(join(edgeDns, "oauth"), "s3cret");
  const secret = join(linked, "edge-dns", "oauth");
  const port = new StandInPort();
  const host = await start(
    h,
    `${NO_ROOT}oauth-client:\n  id: c\n  secret-file: ${secret}\n`,
    port,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(
      () => answers(`${base}/w/cost-reports/`, "workspace:cost-reports"),
      "the workspace without the secret starts",
    );
    await waitFor(async () => {
      const status = await readStatus(h, "edge-dns");
      return typeof status?.reason === "string" &&
        status.reason.includes("oauth-client.secret-file");
    }, "edge-dns held with the secret-file reason");
    assertEquals(port.of("workspace:edge-dns"), []);
  } finally {
    await host.shutdown();
  }
});

/** a root workspace as resolveRootWorkspace leaves one: a registered repo in the workspace location */
async function rootWorkspaceOf(
  h: HostDirs,
  calls: { count: number },
  folder = join(h.location, "host-root"),
): Promise<() => Promise<RootWorkspace>> {
  await makeRepo(folder);
  await register(h, "host-root", folder, "created");
  return () => {
    calls.count++;
    return Promise.resolve({
      name: "host-root",
      folder,
      created: false,
      leftFolder: null,
    });
  };
}

Deno.test("serve host: with no root in host.yaml the root workspace answers at the address, is never listed, and has no address under /w/", async () => {
  await using h = await hostDirs();
  await makeWorkspace(h, "edge-dns");
  const calls = { count: 0 };
  const rootWorkspace = await rootWorkspaceOf(h, calls);
  const port = new StandInPort();
  const host = await start(
    h,
    "address: https://serve.acme.internal\nlisten: {port: 0}\n",
    port,
    undefined,
    undefined,
    rootWorkspace,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    assertEquals(calls.count, 1);
    assertEquals(host.rootWorkspace?.name, "host-root");
    assertEquals(host.workspaces, ["edge-dns"]);
    await waitFor(
      () => answers(`${base}/health`, "root"),
      "the root to answer",
    );
    const root = port.of("root")[0].spec;
    assertEquals(root.repoDir, join(h.location, "host-root"));
    assertEquals(root.address, "https://serve.acme.internal");
    assertEquals(root.hostWorkspaces, {
      dir: h.stateDir,
      address: "https://serve.acme.internal",
    });
    assertEquals((await get(`${base}/w/host-root/`)).status, 404);
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    assertEquals(
      port.of("workspace:edge-dns")[0].spec.rootAddress,
      "https://serve.acme.internal",
    );
    assertEquals(port.of("workspace:host-root").length, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: an explicit root never asks for a root workspace, and one made earlier is an ordinary workspace", async () => {
  await using h = await hostDirs();
  await makeRepo(join(h.configDir, "root-repo"));
  const calls = { count: 0 };
  const rootWorkspace = await rootWorkspaceOf(h, calls);
  const port = new StandInPort();
  const host = await start(
    h,
    `${NO_ROOT}root: root-repo\n`,
    port,
    undefined,
    undefined,
    rootWorkspace,
  );
  try {
    assertEquals(calls.count, 0);
    assertEquals(host.rootWorkspace, null);
    assertEquals(host.workspaces, ["host-root"]);
    assertEquals(
      port.of("root")[0].spec.repoDir,
      join(h.configDir, "root-repo"),
    );
    assertEquals(
      (await Deno.stat(join(h.location, "host-root", ".swamp.yaml"))).isFile,
      true,
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: behind a proxy the root workspace in auth mode none is refused, and its refusal names its serve.yaml", async () => {
  await using h = await hostDirs();
  const calls = { count: 0 };
  const rootWorkspace = await rootWorkspaceOf(h, calls);
  const port = new StandInPort({ root: "none" });
  const serveYaml = join(h.location, "host-root", ".swamp", "serve.yaml");
  await hostLogs(async (records) => {
    const host = await start(
      h,
      "address: https://serve.acme.internal\nlisten: {port: 0}\ntrust-proxy: true\n",
      port,
      undefined,
      undefined,
      rootWorkspace,
    );
    try {
      const base = `http://127.0.0.1:${host.port}`;
      await waitFor(async () => {
        const { status, body } = await get(`${base}/health`);
        return status === 503 && body.state === "refused";
      }, "the root to answer refused");
      await waitFor(
        () => Promise.resolve(logged(records, serveYaml)),
        "the refusal to name the root workspace's serve.yaml",
      );
    } finally {
      await host.shutdown();
    }
  });
});

Deno.test("serve host: a root workspace whose folder is inside the state folder refuses to start and starts no serve", async () => {
  await using h = await hostDirs();
  const calls = { count: 0 };
  const rootWorkspace = await rootWorkspaceOf(
    h,
    calls,
    join(h.stateDir, "nested", "host-root"),
  );
  const port = new StandInPort();
  const error = await assertRejects(
    () => start(h, NO_ROOT, port, undefined, undefined, rootWorkspace),
    UserError,
  );
  assert(
    error.message.includes("cannot be the host's root"),
    error.message,
  );
  assertEquals(port.children.length, 0);
});
