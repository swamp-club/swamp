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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { AuthMode } from "../src/domain/access/serve_auth_config.ts";
import { UserError } from "../src/domain/errors.ts";
import { serveIdKey } from "../src/domain/serve/managed_serve.ts";
import { HostConfig } from "../src/serve/host/host_config.ts";
import {
  type ServeHost,
  type ServeHostOptions,
  startServeHost,
} from "../src/serve/host/serve_host.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeChildSpec,
  ServeProcessPort,
} from "../src/serve/host/serve_process.ts";
import type { ListenedServe } from "../src/serve/listening_line.ts";
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

interface HostFolder extends AsyncDisposable {
  readonly dir: string;
}

async function hostFolder(): Promise<HostFolder> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-host-" });
  return {
    dir,
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}

async function makeRepo(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, ".swamp.yaml"), "");
}

async function start(
  dir: string,
  yaml: string,
  port: StandInPort,
  supervisor?: ServeHostOptions["supervisor"],
): Promise<ServeHost> {
  await Deno.writeTextFile(join(dir, "host.yaml"), yaml);
  const host = await startServeHost({
    config: HostConfig.parse(yaml, dir),
    processPort: port,
    childEnv: { PATH: "/usr/bin" },
    rescanMs: RESCAN_MS,
    supervisor,
  });
  return host;
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

Deno.test("serve host: a root and two workspaces made by hand answer at their own addresses", async () => {
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "root-repo"));
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  await makeRepo(join(folder.dir, "workspaces", "cost-reports"));
  const port = new StandInPort();
  const host = await start(
    folder.dir,
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
    assertEquals(edge.repoDir, join(folder.dir, "workspaces", "edge-dns"));
    assertEquals(edge.env, { PATH: "/usr/bin" });
    assertEquals(edge.oauthClient, null);
    assertEquals(
      port.of("root")[0].spec.address,
      "https://serve.acme.internal",
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a workspace folder added while the host runs answers, and one removed answers 404", async () => {
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  const port = new StandInPort();
  const host = await start(
    folder.dir,
    "address: http://127.0.0.1\nlisten: {port: 0}\n",
    port,
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;

    // the marker lands after the folder, as when an operator makes one by hand
    await Deno.mkdir(join(folder.dir, "workspaces", "late"));
    assertEquals((await get(`${base}/w/late/`)).status, 404);
    await Deno.writeTextFile(
      join(folder.dir, "workspaces", "late", ".swamp.yaml"),
      "",
    );
    await waitFor(
      () => answers(`${base}/w/late/`, "workspace:late"),
      "the added workspace to answer",
    );

    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "edge-dns to answer",
    );
    await Deno.remove(join(folder.dir, "workspaces", "edge-dns"), {
      recursive: true,
    });
    await waitFor(
      async () => (await get(`${base}/w/edge-dns/`)).status === 404,
      "the removed workspace to answer 404",
    );
    await waitFor(
      () => port.events.some((e) => e.startsWith("stop workspace:edge-dns")),
      "the removed workspace's serve to be stopped",
    );

    await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "the re-added workspace to answer",
    );
    assertEquals(port.of("workspace:edge-dns").length, 2);
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a workspace that failed starts again when its folder is removed and added", async () => {
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  const port = new StandInPort();
  port.crashing.add("edge-dns");
  const host = await start(
    folder.dir,
    "address: http://127.0.0.1\nlisten: {port: 0}\n",
    port,
    {
      policy: {
        restartDelayMs: 1,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
        crashWindowMs: 600_000,
        maxCrashesInWindow: 2,
      },
    },
  );
  try {
    const base = `http://127.0.0.1:${host.port}`;
    await waitFor(async () => {
      const { status, body } = await get(`${base}/w/edge-dns/`);
      return status === 503 && body.state === "failed";
    }, "the crashing workspace to fail");
    const crashes = port.crashes;

    await Deno.remove(join(folder.dir, "workspaces", "edge-dns"), {
      recursive: true,
    });
    await waitFor(
      async () => (await get(`${base}/w/edge-dns/`)).status === 404,
      "the removed workspace to answer 404",
    );
    assertEquals(port.crashes, crashes, "a removed workspace is not restarted");

    port.crashing.delete("edge-dns");
    await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
    await waitFor(
      () => answers(`${base}/w/edge-dns/`, "workspace:edge-dns"),
      "the re-added workspace to answer",
    );
  } finally {
    await host.shutdown();
  }
});

Deno.test("serve host: a host with no root answers 404 outside /w/", async () => {
  await using folder = await hostFolder();
  const port = new StandInPort();
  const host = await start(
    folder.dir,
    "address: http://127.0.0.1\nlisten: {port: 0}\n",
    port,
  );
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
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "root-repo"));
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  const port = new StandInPort();
  const host = await start(
    folder.dir,
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
  await using folder = await hostFolder();
  await Deno.writeTextFile(
    join(folder.dir, "cert.pem"),
    TEST_LOCALHOST_CERT_PEM,
  );
  await Deno.writeTextFile(join(folder.dir, "key.pem"), TEST_LOCALHOST_KEY_PEM);
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  const port = new StandInPort();
  const host = await start(
    folder.dir,
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
    await using folder = await hostFolder();
    await makeRepo(join(folder.dir, "workspaces", "open"));
    await makeRepo(join(folder.dir, "workspaces", "guarded"));
    const port = new StandInPort({ open: "none", guarded: "token" });
    const yaml = [
      "address: https://serve.acme.internal",
      "listen: {port: 0}",
      ...proxy,
      ...(allow ? ["allow-unauthenticated-behind-proxy: true"] : []),
    ].join("\n");
    const host = await start(folder.dir, yaml, port);
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
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  using taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = new StandInPort();
  const error = await assertRejects(
    () =>
      start(
        folder.dir,
        `address: http://127.0.0.1\nlisten: {port: ${taken.addr.port}}\n`,
        port,
      ),
    UserError,
  );
  assert(error.message.includes("cannot listen"), error.message);
  assertEquals(port.children.length, 0);
});

Deno.test("serve host: a root that is not a swamp repo refuses to start and starts no serve", async () => {
  await using folder = await hostFolder();
  await Deno.mkdir(join(folder.dir, "root-repo"));
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  const port = new StandInPort();
  const error = await assertRejects(
    () =>
      start(
        folder.dir,
        "address: http://127.0.0.1\nlisten: {port: 0}\nroot: root-repo\n",
        port,
      ),
    UserError,
  );
  assert(error.message.includes("is not a swamp repo"), error.message);
  assertEquals(port.children.length, 0);
});

Deno.test("serve host: the root, every workspace and one added later are started with the OAuth client host.yaml names", async () => {
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "root-repo"));
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  await makeRepo(join(folder.dir, "workspaces", "cost-reports"));
  await Deno.mkdir(join(folder.dir, "secrets"));
  await Deno.writeTextFile(
    join(folder.dir, "secrets", "oauth-client"),
    "client-secret\n",
  );
  const port = new StandInPort();
  const host = await start(
    folder.dir,
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
    await makeRepo(join(folder.dir, "workspaces", "billing"));
    await waitFor(
      () => port.of("workspace:billing").length > 0,
      "the added workspace to be started",
    );
    const expected = {
      id: "client-123",
      secretFile: join(folder.dir, "secrets", "oauth-client"),
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
    await using folder = await hostFolder();
    await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
    const secretFile = join(folder.dir, "oauth-client-secret");
    if (write) await Deno.writeTextFile(secretFile, "  \n");
    const port = new StandInPort();
    const error = await assertRejects(
      () =>
        start(
          folder.dir,
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
  await using folder = await hostFolder();
  await makeRepo(join(folder.dir, "root-repo"));
  await makeRepo(join(folder.dir, "workspaces", "edge-dns"));
  await makeRepo(join(folder.dir, "workspaces", "cost-reports"));
  const port = new StandInPort();
  const host = await start(
    folder.dir,
    "address: http://127.0.0.1\nlisten: {port: 0}\nroot: root-repo\n",
    port,
  );
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
