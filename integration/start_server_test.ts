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

// Integration test: the `swamp start` loopback server on port 0, wired to
// fake start dependencies and a temp dashboard dist folder. Covers the
// DNS-rebinding Host check, the Origin and token checks on the WebSocket
// upgrade, choosing and leaving workspaces (and their claims), the full
// message sequence, launch de-duplication, the sign-in projection, asset
// serving, the liveness ping, shutdown and the end conditions.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { AuthLoginEvent } from "../src/libswamp/auth/login.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import type {
  SignedInState,
  StartDeps,
  StartHarnessInfo,
  StartStatus,
  StartWorkspaceSummary,
} from "../src/libswamp/start/start.ts";
import type { HarnessLaunchSpec } from "../src/domain/start/harness.ts";
import type { WorkspaceHub } from "../src/serve/local/workspace_hub.ts";
import { StartSessionFileRepository } from "../src/infrastructure/persistence/start_session_file_repository.ts";
import { WorkspaceRegistryFileRepository } from "../src/infrastructure/persistence/workspace_registry_file_repository.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  probeStartServer,
  START_PING_TOKEN_HEADER,
} from "../src/infrastructure/process/start_instance_probe.ts";
import {
  type StartServerEnd,
  type StartServerHandle,
  type StartServerTimeouts,
  startStartServer,
  type StartWorkspaceClaims,
} from "../src/serve/start/start_server.ts";

const TOKEN = "test-token-" + crypto.randomUUID();
const LONG: StartServerTimeouts = {
  afterLaunchIdleMs: 60_000,
  beforeLaunchIdleMs: 60_000,
  copyFallbackMs: 60_000,
};

interface Fakes {
  deps: StartDeps;
  opened: HarnessLaunchSpec[];
  /** Resolved to let a pending `open` finish. */
  releaseOpen: () => void;
  openGate: Promise<void> | null;
  signInEvents: AuthLoginEvent[];
  /** When set, sign-in waits on it after its first event. */
  signInGate: Promise<void> | null;
  /** Whether the fake terminal reports the window as opened. */
  launchOpened: boolean;
  signedIn: SignedInState;
  /** The folder the fake chooser answers with; null is a cancel. */
  picked: string | null;
  /** When set, the fake chooser waits on it before answering. */
  pickGate: Promise<void> | null;
  picks: number;
  /** What the fake chooser was asked, in order. */
  prompts: string[];
}

function makeFakes(dataDir: string): Fakes {
  const f: Fakes = {
    deps: undefined as unknown as StartDeps,
    opened: [],
    releaseOpen: () => {},
    openGate: null,
    signInEvents: [],
    signInGate: null,
    launchOpened: true,
    signedIn: { kind: "signed_in", username: "ada", source: "file" },
    picked: null,
    pickGate: null,
    picks: 0,
    prompts: [],
  };
  const tools = new Map<string, string[]>();
  f.deps = {
    dataDir,
    os: "darwin",
    checkSignedIn: () => Promise.resolve(f.signedIn),
    apiKeyFromEnv: () => false,
    repo: {
      isRepo: async (path) => {
        try {
          await Deno.stat(join(path, ".swamp.yaml"));
          return true;
        } catch {
          return false;
        }
      },
      init: (path) => Deno.writeTextFile(join(path, ".swamp.yaml"), "x: 1\n"),
      enrolledTools: (path) => Promise.resolve(tools.get(path) ?? []),
      setTools: (path, list) => {
        tools.set(path, [...list]);
        return Promise.resolve();
      },
    },
    sessions: new StartSessionFileRepository(),
    lookup: (name) =>
      Promise.resolve(name === "claude" ? ["/usr/local/bin/claude"] : []),
    terminalLauncher: {
      open: async (spec) => {
        f.opened.push(spec);
        if (f.openGate) await f.openGate;
        return {
          method: "macos_terminal",
          opened: f.launchOpened,
          command: "cd '/w' && 'claude'",
        };
      },
    },
    writeBrief: () => Promise.resolve(),
    signals: () =>
      Promise.resolve({
        kubeconfig: false,
        awsConfig: false,
        gcloudAdc: false,
      }),
    signIn: async function* () {
      let first = true;
      for (const event of f.signInEvents) {
        yield event;
        if (first && f.signInGate) await f.signInGate;
        first = false;
      }
    },
    now: () => new Date("2026-10-03T10:00:00.000Z"),
    randomUUID: () => crypto.randomUUID(),
    random: () => 0,
    isRunning: () => Promise.resolve(false),
    registry: new WorkspaceRegistryFileRepository(join(dataDir, ".config")),
    folderPicker: {
      available: () => Promise.resolve(true),
      pick: async (prompt) => {
        f.picks++;
        f.prompts.push(prompt);
        if (f.pickGate) await f.pickGate;
        return f.picked;
      },
    },
  };
  return f;
}

/** A claims fake that records each claim and release. */
interface Claims {
  readonly claims: StartWorkspaceClaims;
  readonly claimed: string[];
  readonly released: string[];
  /** When set, every release throws after recording itself. */
  failRelease: boolean;
}

function makeClaims(): Claims {
  const c: Claims = {
    claimed: [],
    released: [],
    failRelease: false,
    claims: {
      claim: (_name, path, open) => {
        c.claimed.push(path);
        return open();
      },
      release: (path) => {
        c.released.push(path);
        return c.failRelease
          ? Promise.reject(new Error("release failed"))
          : Promise.resolve();
      },
    },
  };
  return c;
}

interface Env {
  handle: StartServerHandle;
  fakes: Fakes;
  claims: Claims;
  dataDir: string;
  dist: string;
  /** Workspaces the server reported opening, with whether it created them. */
  opened: Array<{ path: string; created: boolean }>;
  /** Shuts the server down; the cleanup's own shutdown then does nothing. */
  shutdown: () => Promise<void>;
}

const workspaceDir = (dataDir: string, name: string) =>
  join(dataDir, "workspaces", name);

async function withStartServer(
  fn: (env: Env) => Promise<void>,
  timeouts: StartServerTimeouts = LONG,
  hub?: WorkspaceHub,
  startPage?: boolean,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-start-server-" });
  const dist = join(dir, "dist");
  const dataDir = join(dir, "data");
  await Deno.mkdir(join(dist, "assets"), { recursive: true });
  await Deno.mkdir(dataDir);
  await Deno.writeTextFile(join(dist, "index.html"), "<html>start</html>");
  await Deno.writeTextFile(join(dist, "assets", "app.js"), "export {};");
  const fakes = makeFakes(dataDir);
  const claims = makeClaims();
  const opened: Array<{ path: string; created: boolean }> = [];
  const handle = startStartServer({
    ctx: createLibSwampContext(),
    deps: fakes.deps,
    token: TOKEN,
    distDir: dist,
    claims: claims.claims,
    onWorkspaceOpened: (path, created) => opened.push({ path, created }),
    timeouts,
    hub,
    startPage,
  });
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await handle.shutdown();
  };
  try {
    await fn({ handle, fakes, claims, dataDir, dist, opened, shutdown });
  } finally {
    fakes.releaseOpen();
    await shutdown();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Sends one raw HTTP/1.1 request and returns the status code. */
async function rawStatus(port: number, headers: string[]): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const hasConnection = headers.some((h) => /^connection:/i.test(h));
    const request = [
      ...headers,
      ...(hasConnection ? [] : ["Connection: close"]),
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(4096);
    let text = "";
    while (!text.includes("\r\n")) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
    const match = /^HTTP\/1\.1 (\d{3})/.exec(text);
    assert(match, `no status line in ${JSON.stringify(text)}`);
    return Number(match[1]);
  } finally {
    conn.close();
  }
}

function upgradeHeaders(
  port: number,
  options: { origin?: string; protocol?: string; host?: string },
): string[] {
  return [
    "GET /start/ws HTTP/1.1",
    `Host: ${options.host ?? `127.0.0.1:${port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...(options.origin ? [`Origin: ${options.origin}`] : []),
    ...(options.protocol
      ? [`Sec-WebSocket-Protocol: ${options.protocol}`]
      : []),
  ];
}

/** A request's answer: a status, the harness list or the workspace list. */
type Payload = Partial<StartStatus> & {
  readonly harnesses?: readonly StartHarnessInfo[];
  readonly workspaces?: readonly StartWorkspaceSummary[];
  readonly suggestedName?: string;
  readonly defaultLocation?: string;
  // start.workspace.location.check
  readonly field?: string;
  readonly message?: string;
  // start.folder.pick
  readonly path?: string | null;
  // start.folder.check
  readonly ok?: boolean;
  readonly code?: string;
  readonly registeredAs?: string;
};

/** One frame the server sends. */
interface Frame {
  readonly type: string;
  readonly id?: string;
  readonly payload?: Payload;
  readonly event?: { readonly kind: string } & Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A test client: buffers frames and answers requests by id. */
class Client {
  readonly frames: Frame[] = [];
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      this.frames.push(JSON.parse(String(m.data)));
      for (const w of this.waiters.splice(0)) w();
    };
  }

  static async open(port: number, token = TOKEN): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/start/ws`, [
      "bearer." + token,
    ]);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`socket error: ${e}`));
    });
    return new Client(ws);
  }

  private next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Waits for the frame matching `pred`. */
  async frame(pred: (f: Frame) => boolean): Promise<Frame> {
    while (true) {
      const found = this.frames.find(pred);
      if (found) return found;
      await this.next();
    }
  }

  send(type: string, payload?: unknown): string {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type, id, ...(payload ? { payload } : {}) }));
    return id;
  }

  /** Sends a request and returns its payload frame, failing on an error. */
  async request(type: string, payload?: unknown): Promise<Payload> {
    const id = this.send(type, payload);
    const frame = await this.frame((f) =>
      f.id === id && (f.type === "error" || "payload" in f)
    );
    if (frame.type === "error") {
      throw new Error(`${type} failed: ${JSON.stringify(frame.error)}`);
    }
    assert(frame.payload, `${type} answered without a payload`);
    return frame.payload;
  }

  /** Sends a request that must fail and returns its error. */
  async requestError(
    type: string,
    payload?: unknown,
  ): Promise<{ readonly code: string; readonly message: string }> {
    const id = this.send(type, payload);
    const frame = await this.frame((f) =>
      f.id === id && (f.type === "error" || "payload" in f)
    );
    assertEquals(frame.type, "error", `${type} unexpectedly succeeded`);
    assert(frame.error);
    return frame.error;
  }

  /**
   * Resolves once the server has dispatched every request this client sent
   * before it. The server answers an unrecognised request as soon as it reads
   * it and reads a socket's messages in order. A queued request such as
   * `start.status` can't serve here: it waits behind a held launch.
   */
  async dispatched(): Promise<void> {
    assertEquals(
      (await this.requestError("start.dispatched")).code,
      "invalid_request",
    );
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.ws.onclose = () => resolve();
    });
    this.ws.close();
    await closed;
  }
}

async function walkToTrust(client: Client): Promise<void> {
  await client.request("start.workspace.choose", { name: "first-workspace" });
  await client.request("start.task.save", { text: "list my pods" });
  await client.request("start.harness.choose", { id: "claude" });
}

Deno.test("startStartServer: answers a foreign Host with 421", async () => {
  await withStartServer(async ({ handle }) => {
    assertEquals(
      await rawStatus(handle.port, [
        "GET /dashboard/start HTTP/1.1",
        "Host: evil.example:80",
      ]),
      421,
    );
    assertEquals(
      await rawStatus(handle.port, [
        "GET /dashboard/start HTTP/1.1",
        `Host: 127.0.0.1:${handle.port + 1}`,
      ]),
      421,
    );
    assertEquals(
      await rawStatus(handle.port, [
        "GET /dashboard/start HTTP/1.1",
        `Host: localhost:${handle.port}`,
      ]),
      200,
    );
    assertEquals(
      await rawStatus(
        handle.port,
        upgradeHeaders(handle.port, {
          host: "evil.example",
          protocol: "bearer." + TOKEN,
        }),
      ),
      421,
    );
  });
});

Deno.test("startStartServer: refuses an upgrade from a foreign Origin with 403", async () => {
  await withStartServer(async ({ handle }) => {
    assertEquals(
      await rawStatus(
        handle.port,
        upgradeHeaders(handle.port, {
          origin: "https://evil.example",
          protocol: "bearer." + TOKEN,
        }),
      ),
      403,
    );
  });
});

Deno.test("startStartServer: refuses an upgrade with a missing or wrong token", async () => {
  await withStartServer(async ({ handle }) => {
    const origin = `http://127.0.0.1:${handle.port}`;
    assertEquals(
      await rawStatus(handle.port, upgradeHeaders(handle.port, { origin })),
      401,
    );
    assertEquals(
      await rawStatus(
        handle.port,
        upgradeHeaders(handle.port, { origin, protocol: "bearer.wrong" }),
      ),
      401,
    );
    assertEquals(
      await rawStatus(
        handle.port,
        upgradeHeaders(handle.port, { origin, protocol: TOKEN }),
      ),
      401,
    );
    assertEquals(
      await rawStatus(
        handle.port,
        upgradeHeaders(handle.port, { origin, protocol: "bearer." + TOKEN }),
      ),
      101,
    );
  });
});

Deno.test("startStartServer: echoes the bearer subprotocol for the right token", async () => {
  await withStartServer(async ({ handle }) => {
    const client = await Client.open(handle.port);
    try {
      assertEquals(client.ws.protocol, "bearer." + TOKEN);
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: runs workspace choice, task, harness list, choose and launch to the launched screen", async () => {
  await withStartServer(async ({ handle, fakes, dataDir, opened }) => {
    const client = await Client.open(handle.port);
    try {
      const unbound = await client.request("start.status");
      assertEquals(unbound.screen, "workspace");
      assertEquals(unbound.workspacePath, null);
      assertEquals(unbound.workspaceName, null);
      assertEquals(handle.workspacePath(), null);
      const chosenWs = await client.request("start.workspace.choose", {
        name: "first-workspace",
      });
      assertEquals(chosenWs.screen, "task");
      assertEquals(chosenWs.workspaceName, "first-workspace");
      const ws = workspaceDir(dataDir, "first-workspace");
      assertPathEquals(chosenWs.workspacePath ?? "", ws);
      assertPathEquals(handle.workspacePath() ?? "", ws);
      assertEquals(opened.length, 1);
      assertPathEquals(opened[0].path, ws);
      assertEquals(opened[0].created, true);
      assertEquals((await client.request("start.status")).screen, "task");
      const saved = await client.request("start.task.save", {
        text: "list my pods",
      });
      assertEquals(saved.screen, "agent");
      assertEquals(saved.task?.title, "list my pods");
      const list = await client.request("start.harness.list");
      assertEquals(list.harnesses?.length, 9);
      assertEquals(
        list.harnesses?.filter((h) => h.found).map((h) => h.id),
        ["claude"],
      );
      const chosen = await client.request("start.harness.choose", {
        id: "claude",
      });
      assertEquals(chosen.screen, "trust");
      const launched = await client.request("start.launch", {
        trustConfirmed: true,
      });
      assertEquals(launched.screen, "launched");
      assertEquals(launched.launch?.method, "macos_terminal");
      assertEquals(fakes.opened.length, 1);
      const progress = client.frames.filter((f) =>
        f.type === "start.launch" && f.event
      ).map((f) => f.event?.kind);
      assertEquals(progress, [
        "checking",
        "enrolling",
        "brief_written",
        "window_opening",
        "launched",
      ]);
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: answers an invalid request and a refused transition with error frames", async () => {
  await withStartServer(async ({ handle }) => {
    const client = await Client.open(handle.port);
    try {
      client.ws.send(JSON.stringify({ type: "start.nope", id: "x1" }));
      const invalid = await client.frame((f) => f.id === "x1");
      assertEquals(invalid.type, "error");
      assertEquals(invalid.error?.code, "invalid_request");
      await client.request("start.workspace.choose", {
        name: "first-workspace",
      });
      // No task written yet: nothing to launch.
      const none = client.send("start.launch", { trustConfirmed: true });
      const noTask = await client.frame((f) =>
        f.id === none && f.type === "error"
      );
      assertEquals(noTask.error?.code, "no_task");
      // A task not yet past the agent step can't launch.
      await client.request("start.task.save", { text: "list my pods" });
      const id = client.send("start.launch", { trustConfirmed: true });
      const refused = await client.frame((f) =>
        f.id === id && f.type === "error"
      );
      assertStringIncludes(refused.error?.message ?? "", `"agent"`);
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: two launches at once open only one window", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const a = await Client.open(handle.port);
    const b = await Client.open(handle.port);
    try {
      await walkToTrust(a);
      fakes.openGate = new Promise((resolve) => {
        fakes.releaseOpen = resolve;
      });
      const first = a.request("start.launch", { trustConfirmed: true });
      await waitFor(
        () => fakes.opened.length === 1,
        "the first launch to reach the terminal launcher",
      );
      const second = b.request("start.launch", { trustConfirmed: true });
      await b.dispatched();
      fakes.releaseOpen();
      const [ra, rb] = await Promise.all([first, second]);
      assertEquals(ra.screen, "launched");
      assertEquals(rb.screen, "launched");
      assertEquals(fakes.opened.length, 1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

Deno.test("startStartServer: a launch or resume refuses to run on a task another tab opened meanwhile", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const a = await Client.open(handle.port);
    const b = await Client.open(handle.port);
    try {
      await walkToTrust(a);
      const first = (await a.request("start.status")).taskId!;
      await a.request("start.new_task");
      const second =
        (await a.request("start.task.save", { text: "watch my VPCs" }))
          .taskId!;
      await a.request("start.task.open", { id: first });

      // Hold the queue with a launch of the first task.
      fakes.openGate = new Promise((resolve) => {
        fakes.releaseOpen = resolve;
      });
      const launch = a.request("start.launch", { trustConfirmed: true });
      await waitFor(
        () => fakes.opened.length === 1,
        "the launch to reach the terminal launcher",
      );
      // Another tab opens the second task, then this tab asks to resume
      // the first one: the resume must not run on the second task.
      const opening = b.request("start.task.open", { id: second });
      await b.dispatched();
      const resume = a.requestError("start.resume");
      await a.dispatched();
      fakes.releaseOpen();
      await launch;
      await opening;
      assertEquals((await resume).code, "task_changed");
      assertEquals(fakes.opened.length, 1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

Deno.test("startStartServer: sign-in frames never carry the API key or email", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    fakes.signInEvents = [
      {
        kind: "device_verification",
        userCode: "ABCD-EFGH",
        verificationUri: "https://club/device",
      },
      { kind: "polling" },
      {
        kind: "completed",
        data: {
          username: "ada",
          email: "ada@example.com",
          serverUrl: "https://club",
          apiKey: "swamp_live_secret",
        },
      },
    ];
    const client = await Client.open(handle.port);
    try {
      const id = client.send("start.signin");
      await client.frame((f) => f.type === "done" && f.id === id);
      const frames = client.frames.filter((f) => f.id === id);
      const serialized = JSON.stringify(frames);
      assert(!serialized.includes("swamp_live_secret"));
      assert(!serialized.includes("ada@example.com"));
      assertEquals(
        frames.filter((f) => f.event).map((f) => f.event),
        [
          {
            kind: "device_verification",
            userCode: "ABCD-EFGH",
            verificationUri: "https://club/device",
          },
          { kind: "polling" },
          { kind: "completed", username: "ada" },
        ],
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: serves the dashboard bundle and redirects / to the start page", async () => {
  await withStartServer(async ({ handle }) => {
    const base = `http://127.0.0.1:${handle.port}`;
    const root = await fetch(base + "/", { redirect: "manual" });
    assertEquals(root.status, 302);
    assertEquals(
      new URL(root.headers.get("location")!).pathname,
      "/dashboard/start",
    );
    await root.body?.cancel();
    const page = await fetch(base + "/dashboard/start");
    assertEquals(await page.text(), "<html>start</html>");
    const asset = await fetch(base + "/dashboard/assets/app.js");
    assertEquals(asset.headers.get("content-type"), "application/javascript");
    assertEquals(await asset.text(), "export {};");
    const missing = await fetch(base + "/nowhere");
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    const plain = await fetch(base + "/start/ws");
    assertEquals(plain.status, 426);
    await plain.body?.cancel();
  });
});

Deno.test("startStartServer: with no start page, the start socket answers 404 even for the right token and nothing is imported", async () => {
  await withStartServer(
    async ({ handle, fakes, claims, dataDir }) => {
      const origin = `http://127.0.0.1:${handle.port}`;
      assertEquals(
        await rawStatus(
          handle.port,
          upgradeHeaders(handle.port, { origin, protocol: "bearer." + TOKEN }),
        ),
        404,
      );
      // The page's own path: a browser socket with the token never opens, so
      // no start.workspace.import can reach the server.
      const folder = join(dataDir, "other-repo");
      await Deno.mkdir(folder);
      await Deno.writeTextFile(join(folder, ".swamp.yaml"), "x: 1\n");
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/start/ws`, [
        "bearer." + TOKEN,
      ]);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({
          type: "start.workspace.import",
          id: "1",
          payload: { path: folder, name: "imported-marsh" },
        }));
      };
      ws.onerror = () => {};
      await new Promise((resolve) => ws.onclose = resolve);
      assertEquals(opened, false);
      assertEquals(await fakes.deps.registry.load(), null);
      assertEquals(claims.claimed, []);
      assertEquals(handle.workspacePath(), null);
    },
    LONG,
    undefined,
    false,
  );
});

Deno.test("startStartServer: with no start page, / and the start page answer 404 while the hub and bundle still serve", async () => {
  const hub: WorkspaceHub = {
    handle: (req) =>
      Promise.resolve(
        new URL(req.url).pathname === "/api/local/workspaces"
          ? Response.json({ workspaces: [], switchable: false })
          : null,
      ),
    shutdown: () => Promise.resolve(),
  };
  await withStartServer(
    async ({ handle }) => {
      const base = `http://127.0.0.1:${handle.port}`;
      for (const path of ["/", "/dashboard/start", "/dashboard/start/"]) {
        const response = await fetch(base + path, { redirect: "manual" });
        assertEquals(response.status, 404, path);
        await response.body?.cancel();
      }
      const page = await fetch(base + "/dashboard/w/repo1/");
      assertEquals(await page.text(), "<html>start</html>");
      const asset = await fetch(base + "/dashboard/assets/app.js");
      assertEquals(await asset.text(), "export {};");
      const list = await fetch(base + "/api/local/workspaces");
      assertEquals(await list.json(), { workspaces: [], switchable: false });
      const ping = await fetch(base + "/start/ping", {
        headers: { [START_PING_TOKEN_HEADER]: TOKEN },
      });
      assertEquals(ping.status, 204);
      await ping.body?.cancel();
    },
    LONG,
    hub,
    false,
  );
});

Deno.test("startStartServer: ends paused when no page connects before launch", async () => {
  await withStartServer(async ({ handle }) => {
    assertEquals(await handle.ended, { kind: "paused" });
  }, { ...LONG, beforeLaunchIdleMs: 20 });
});

Deno.test("startStartServer: ends launched once the page closes after a launch", async () => {
  await withStartServer(async ({ handle }) => {
    const client = await Client.open(handle.port);
    await walkToTrust(client);
    await client.request("start.launch", { trustConfirmed: true });
    await client.close();
    assertEquals(await handle.ended, {
      kind: "launched",
      displayName: "Claude Code",
    });
  }, { ...LONG, afterLaunchIdleMs: 20 });
});

/**
 * A hub whose one route, `/w/x/`, upgrades and holds the socket open: it
 * stands in for a workspace dashboard tab.
 */
function dashboardTabHub(): WorkspaceHub & { shutdowns: number } {
  const hub = {
    shutdowns: 0,
    handle: (req: Request, track: (socket: WebSocket) => void) => {
      if (new URL(req.url).pathname !== "/w/x/") return Promise.resolve(null);
      const { socket, response } = Deno.upgradeWebSocket(req);
      track(socket);
      return Promise.resolve(response);
    },
    shutdown: () => {
      hub.shutdowns++;
      return Promise.resolve();
    },
  };
  return hub;
}

Deno.test("startStartServer: a dashboard tab keeps the server up after a launch, until it closes", async () => {
  const hub = dashboardTabHub();
  await withStartServer(
    async ({ handle }) => {
      const tab = new WebSocket(`ws://127.0.0.1:${handle.port}/w/x/`);
      await new Promise((resolve) => tab.onopen = resolve);
      const client = await Client.open(handle.port);
      await walkToTrust(client);
      await client.request("start.launch", { trustConfirmed: true });
      await client.close();
      // The start page is gone; the dashboard tab still holds the server.
      assertEquals(await settlesWithin(handle.ended, 100), false);
      tab.close();
      assertEquals(await handle.ended, {
        kind: "launched",
        displayName: "Claude Code",
      });
    },
    { ...LONG, afterLaunchIdleMs: 20 },
    hub,
  );
  assertEquals(hub.shutdowns, 1);
});

Deno.test("startStartServer: ends paused once the page closes after a copy-command launch", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const client = await Client.open(handle.port);
    await walkToTrust(client);
    fakes.launchOpened = false;
    await client.request("start.launch", { trustConfirmed: true });
    await client.close();
    assertEquals(await handle.ended, { kind: "paused" });
  }, { ...LONG, afterLaunchIdleMs: 20 });
});

Deno.test("startStartServer: session messages before a workspace is chosen fail with no_workspace", async () => {
  await withStartServer(async ({ handle, fakes, claims }) => {
    const client = await Client.open(handle.port);
    try {
      const attempts: Array<[string, unknown]> = [
        ["start.task.save", { text: "list my pods" }],
        ["start.back", undefined],
        ["start.harness.choose", { id: "claude" }],
        ["start.new_task", undefined],
        ["start.launch", { trustConfirmed: true }],
      ];
      for (const [type, payload] of attempts) {
        const error = await client.requestError(type, payload);
        assertEquals(error.code, "no_workspace", type);
      }
      assertEquals(fakes.opened, []);
      assertEquals(claims.claimed, []);
      // The harness list needs no workspace.
      assertEquals(
        (await client.request("start.harness.list")).harnesses?.length,
        9,
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: an invalid workspace name fails with invalid_name without a claim", async () => {
  await withStartServer(async ({ handle, claims }) => {
    const client = await Client.open(handle.port);
    try {
      const error = await client.requestError("start.workspace.choose", {
        name: "../escape",
      });
      assertEquals(error.code, "invalid_name");
      assertEquals(claims.claimed, []);
      assertEquals(handle.workspacePath(), null);
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: a folder that is not a workspace fails with not_a_workspace", async () => {
  await withStartServer(async ({ handle, dataDir }) => {
    const ws = workspaceDir(dataDir, "taken");
    await Deno.mkdir(ws, { recursive: true });
    await Deno.writeTextFile(join(ws, "notes.txt"), "mine");
    const client = await Client.open(handle.port);
    try {
      const error = await client.requestError("start.workspace.choose", {
        name: "taken",
      });
      assertEquals(error.code, "not_a_workspace");
      assertEquals(handle.workspacePath(), null);
      assertEquals(await Deno.readTextFile(join(ws, "notes.txt")), "mine");
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: claims once per open and releases on leave, on switching and on shutdown", async () => {
  await withStartServer(async ({ handle, claims, dataDir, shutdown }) => {
    const alpha = workspaceDir(dataDir, "alpha");
    const beta = workspaceDir(dataDir, "beta");
    const client = await Client.open(handle.port);
    try {
      await client.request("start.workspace.choose", { name: "alpha" });
      // Choosing the workspace already served does not claim it again.
      await client.request("start.workspace.choose", { name: "alpha" });
      assertEquals(claims.claimed.length, 1);
      assertPathEquals(claims.claimed[0], alpha);
      assertEquals(claims.released, []);

      const left = await client.request("start.workspace.leave");
      assertEquals(left.screen, "workspace");
      assertEquals(left.workspacePath, null);
      assertEquals(handle.workspacePath(), null);
      assertEquals(claims.released.length, 1);
      assertPathEquals(claims.released[0], alpha);

      await client.request("start.workspace.choose", { name: "alpha" });
      const switched = await client.request("start.workspace.choose", {
        name: "beta",
      });
      assertEquals(switched.workspaceName, "beta");
      assertPathEquals(handle.workspacePath() ?? "", beta);
      assertEquals(claims.claimed.length, 3);
      assertPathEquals(claims.claimed[2], beta);
      assertEquals(claims.released.length, 2);
      assertPathEquals(claims.released[1], alpha);
    } finally {
      await client.close();
    }
    await shutdown();
    assertEquals(handle.workspacePath(), null);
    assertEquals(claims.released.length, 3);
    assertPathEquals(claims.released[2], beta);
  });
});

Deno.test("startStartServer: a failed release of the old workspace doesn't fail the switch", async () => {
  await withStartServer(async ({ handle, claims, dataDir, opened }) => {
    const client = await Client.open(handle.port);
    try {
      await client.request("start.workspace.choose", { name: "alpha" });
      claims.failRelease = true;
      const switched = await client.request("start.workspace.choose", {
        name: "beta",
      });
      assertEquals(switched.workspaceName, "beta");
      assertPathEquals(
        handle.workspacePath() ?? "",
        workspaceDir(dataDir, "beta"),
      );
      assertEquals(opened.length, 2);
      const left = await client.request("start.workspace.leave");
      assertEquals(left.workspacePath, null);
    } finally {
      claims.failRelease = false;
      await client.close();
    }
  });
});

Deno.test("startStartServer: leaving a workspace after a launch ends paused, not launched", async () => {
  await withStartServer(async ({ handle }) => {
    const client = await Client.open(handle.port);
    await walkToTrust(client);
    await client.request("start.launch", { trustConfirmed: true });
    await client.request("start.workspace.leave");
    await client.close();
    assertEquals(await handle.ended, { kind: "paused" });
  }, { ...LONG, afterLaunchIdleMs: 20, beforeLaunchIdleMs: 20 });
});

Deno.test("startStartServer: shutdown with no workspace chosen releases nothing", async () => {
  await withStartServer(async ({ claims, shutdown }) => {
    await shutdown();
    assertEquals(claims.claimed, []);
    assertEquals(claims.released, []);
  });
});

Deno.test("startStartServer: openWorkspace on the handle opens the workspace the page then sees", async () => {
  await withStartServer(async ({ handle, claims, dataDir, opened }) => {
    const ws = workspaceDir(dataDir, "first-workspace");
    const status = await handle.openWorkspace("first-workspace");
    assertEquals(status.screen, "task");
    assertEquals(status.workspaceName, "first-workspace");
    assertPathEquals(status.workspacePath ?? "", ws);
    assertPathEquals(handle.workspacePath() ?? "", ws);
    assertEquals(claims.claimed.length, 1);
    assertEquals(opened.length, 1);
    assertEquals(opened[0].created, true);
    const client = await Client.open(handle.port);
    try {
      const seen = await client.request("start.status");
      assertEquals(seen.screen, "task");
      assertEquals(seen.workspaceName, "first-workspace");
      const saved = await client.request("start.task.save", {
        text: "list my pods",
      });
      assertEquals(saved.screen, "agent");
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: start.workspaces.list answers the workspaces and a suggested name", async () => {
  await withStartServer(async ({ handle, dataDir }) => {
    const client = await Client.open(handle.port);
    try {
      const empty = await client.request("start.workspaces.list");
      assertEquals(empty, {
        workspaces: [],
        suggestedName: "amber-alligator",
        defaultLocation: join(dataDir, "workspaces"),
      });

      await client.request("start.workspace.choose", {
        name: "amber-alligator",
      });
      await client.request("start.task.save", { text: "list my pods" });
      const list = await client.request("start.workspaces.list");
      assertEquals(list.suggestedName, "amber-alligator-2");
      assertEquals(list.workspaces?.length, 1);
      const [summary] = list.workspaces ?? [];
      assertEquals(summary.name, "amber-alligator");
      assertPathEquals(summary.path, workspaceDir(dataDir, "amber-alligator"));
      assertEquals(summary.step, "agent");
      assertEquals(summary.taskTitle, "list my pods");
      assertEquals(summary.harness, null);
      assertEquals(summary.harnessDisplayName, null);
      assertEquals(summary.running, false);
      assert(summary.updatedAt);
      assert(!Number.isNaN(Date.parse(summary.updatedAt)));
    } finally {
      await client.close();
    }
  });
});

Deno.test("startStartServer: a task launched by an earlier run shows on the home and reopens without the brief", async () => {
  await withStartServer(async ({ handle, fakes, dist }) => {
    const a = await Client.open(handle.port);
    try {
      await walkToTrust(a);
      const launched = await a.request("start.launch", {
        trustConfirmed: true,
      });
      assertEquals(launched.screen, "launched");
    } finally {
      await a.close();
    }

    // A later `swamp start` over the same workspaces.
    const later = startStartServer({
      ctx: createLibSwampContext(),
      deps: fakes.deps,
      token: TOKEN,
      distDir: dist,
      timeouts: LONG,
    });
    const b = await Client.open(later.port);
    try {
      const reopened = await b.request("start.workspace.choose", {
        name: "first-workspace",
      });
      assertEquals(reopened.screen, "home");
      const resumed = await b.request("start.resume");
      assertEquals(resumed.screen, "home");
      assertEquals(fakes.opened.length, 2);
      assertEquals(fakes.opened[1].args, ["--continue"]);
    } finally {
      await b.close();
      await later.shutdown();
    }
  });
});

Deno.test("startStartServer: a new task is nothing on disk until saved, and Cancel goes back to the open one", async () => {
  await withStartServer(async ({ handle, dataDir }) => {
    const c = await Client.open(handle.port);
    try {
      await walkToTrust(c);
      const launched = await c.request("start.launch", {
        trustConfirmed: true,
      });
      const first = launched.taskId!;
      const ws = workspaceDir(dataDir, "first-workspace");
      const records = async () => {
        const names = [];
        for await (
          const e of Deno.readDir(join(ws, ".swamp", "start", "tasks"))
        ) {
          names.push(e.name);
        }
        return names;
      };

      const draft = await c.request("start.new_task");
      assertEquals(draft.screen, "task");
      assertEquals(draft.taskId, undefined);
      assertEquals(draft.task, undefined);
      assertEquals((await records()).length, 1);

      const back = await c.request("start.new_task.cancel");
      assertEquals(back.screen, "home");
      assertEquals(back.taskId, first);
      assertEquals(back.task?.text, "list my pods");

      await c.request("start.new_task");
      const empty = await c.requestError("start.task.save", { text: "   " });
      assertEquals(empty.code, "user_error");
      assertEquals((await records()).length, 1);

      const saved = await c.request("start.task.save", {
        text: "watch my VPCs",
      });
      assertEquals(saved.screen, "agent");
      assert(saved.taskId && saved.taskId !== first);
      assertEquals(saved.task?.text, "watch my VPCs");
      assertEquals(saved.task?.briefFile, "tasks/2026-10-03-watch-my-vpcs.md");
      assertEquals((await records()).length, 2);
      // The first task is untouched.
      assertEquals(saved.tasks?.find((t) => t.id === first)?.step, "launched");
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: a workspace with tasks opens on its home, every task listed newest first", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    let now = new Date("2026-10-01T09:00:00.000Z");
    // The server holds this deps object; change its clock in place.
    (fakes.deps as { now: () => Date }).now = () => now;
    const c = await Client.open(handle.port);
    try {
      await walkToTrust(c);
      await c.request("start.launch", { trustConfirmed: true });
      now = new Date("2026-10-02T09:00:00.000Z");
      await c.request("start.new_task");
      const second = await c.request("start.task.save", {
        text: "watch my VPCs",
      });

      await c.request("start.workspace.leave");
      const reopened = await c.request("start.workspace.choose", {
        name: "first-workspace",
      });
      assertEquals(reopened.screen, "home");
      // The newest task is open; every task is listed, newest first.
      assertEquals(reopened.taskId, second.taskId);
      assertEquals(reopened.tasks?.map((t) => t.title), [
        "watch my VPCs",
        "list my pods",
      ]);
      assertEquals(
        reopened.tasks?.map((t) => t.createdAt),
        ["2026-10-02T09:00:00.000Z", "2026-10-01T09:00:00.000Z"],
      );

      const { tasks } = await c.request("start.tasks.list") as unknown as {
        tasks: Array<{ id: string; title: string; createdAt: string }>;
      };
      assertEquals(tasks.map((t) => t.title), [
        "watch my VPCs",
        "list my pods",
      ]);
      const pods = tasks[1];

      // A launched task opens on the home; one not launched at its step.
      const opened = await c.request("start.task.open", { id: pods.id });
      assertEquals(opened.screen, "home");
      assertEquals(opened.taskId, pods.id);
      assertEquals(opened.task?.text, "list my pods");
      assertEquals(opened.task?.createdAt, "2026-10-01T09:00:00.000Z");
      const vpcs = await c.request("start.task.open", { id: second.taskId! });
      assertEquals(vpcs.screen, "agent");

      const home = await c.request("start.tasks.show");
      assertEquals(home.screen, "home");
      assertEquals(home.taskId, second.taskId);

      const missing = await c.requestError("start.task.open", { id: "nope" });
      assertEquals(missing.code, "task_missing");
    } finally {
      await c.close();
    }
  });
});

/** Resolves true if `promise` settles within `ms`, else false. */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("startStartServer: /start/ping answers 204 for the token and 401 otherwise", async () => {
  await withStartServer(async ({ handle }) => {
    const url = `http://127.0.0.1:${handle.port}/start/ping`;
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 401],
      [{ [START_PING_TOKEN_HEADER]: "wrong" }, 401],
      [{ [START_PING_TOKEN_HEADER]: TOKEN }, 204],
    ];
    for (const [headers, status] of cases) {
      const response = await fetch(url, { headers });
      assertEquals(response.status, status);
      await response.body?.cancel();
    }
  });
});

Deno.test("startStartServer: pings from other instances never count as a page or keep it alive", async () => {
  await withStartServer(async ({ handle }) => {
    let end: StartServerEnd | undefined;
    const ended = handle.ended.then((e) => {
      end = e;
    });
    const record = {
      pid: Deno.pid,
      port: handle.port,
      token: TOKEN,
      startedAt: new Date().toISOString(),
    };
    let pings = 0;
    // Bounded, so a regression fails instead of hanging.
    while (end === undefined && pings < 20_000) {
      assertEquals(await probeStartServer(record), "live");
      pings++;
    }
    await ended;
    assert(pings > 0);
    assertEquals(end, { kind: "paused" });
  }, { ...LONG, beforeLaunchIdleMs: 100 });
});

Deno.test("startStartServer: answers a malformed upgrade with 400 and HEAD / with the redirect", async () => {
  await withStartServer(async ({ handle }) => {
    const headers = upgradeHeaders(handle.port, {
      protocol: "bearer." + TOKEN,
    }).filter((h) => !h.startsWith("Sec-WebSocket-Key"));
    assertEquals(await rawStatus(handle.port, headers), 400);
    assertEquals(
      await rawStatus(handle.port, [
        "HEAD / HTTP/1.1",
        `Host: 127.0.0.1:${handle.port}`,
      ]),
      302,
    );
  });
});

Deno.test("startStartServer: a second sign-in joins the first and both get the device code", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    fakes.signInEvents = [
      {
        kind: "device_verification",
        userCode: "ABCD-EFGH",
        verificationUri: "https://club/device",
      },
      { kind: "polling" },
      {
        kind: "completed",
        data: {
          username: "ada",
          email: "ada@example.com",
          serverUrl: "https://club",
          apiKey: "swamp_live_secret",
        },
      },
    ];
    let release!: () => void;
    fakes.signInGate = new Promise((resolve) => {
      release = resolve;
    });
    const a = await Client.open(handle.port);
    const b = await Client.open(handle.port);
    try {
      const idA = a.send("start.signin");
      await a.frame((f) =>
        f.id === idA && f.event?.kind === "device_verification"
      );
      const idB = b.send("start.signin");
      const replayed = await b.frame((f) =>
        f.id === idB && f.event?.kind === "device_verification"
      );
      assertEquals(replayed.event?.userCode, "ABCD-EFGH");
      release();
      await a.frame((f) => f.type === "done" && f.id === idA);
      await b.frame((f) => f.type === "done" && f.id === idB);
      for (const [client, id] of [[a, idA], [b, idB]] as const) {
        const frames = client.frames.filter((f) => f.id === id);
        assert(!frames.some((f) => f.type === "error"));
        assert(frames.some((f) => f.payload?.screen !== undefined));
        assertEquals(
          frames.filter((f) => f.event).map((f) => f.event?.kind),
          ["device_verification", "polling", "completed"],
        );
        assert(!JSON.stringify(frames).includes("swamp_live_secret"));
      }
    } finally {
      release();
      await a.close();
      await b.close();
    }
  });
});

Deno.test("startStartServer: refuses workspace requests with not_signed_in until signed in", async () => {
  await withStartServer(async ({ handle, fakes, claims }) => {
    fakes.signedIn = { kind: "not_signed_in" };
    const c = await Client.open(handle.port);
    try {
      for (
        const [type, payload] of [
          ["start.workspace.choose", { name: "first-workspace" }],
          ["start.workspaces.list", undefined],
          ["start.task.save", { text: "list my pods" }],
        ] as const
      ) {
        assertEquals(
          (await c.requestError(type, payload)).code,
          "not_signed_in",
        );
      }
      assertEquals(claims.claimed, []);
      await c.request("start.status");
      await c.request("start.harness.list");
      fakes.signedIn = { kind: "signed_in", username: "ada", source: "file" };
      await c.request("start.workspace.choose", { name: "first-workspace" });
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: starting a new task clears the copy-command fallback timer", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const c = await Client.open(handle.port);
    try {
      await walkToTrust(c);
      fakes.launchOpened = false;
      const launched = await c.request("start.launch", {
        trustConfirmed: true,
      });
      assertEquals(launched.launch?.opened, false);
      await c.request("start.new_task");
      await c.request("start.task.save", { text: "watch my VPCs" });
      assertEquals(await settlesWithin(handle.ended, 600), false);
    } finally {
      await c.close();
    }
  }, { ...LONG, copyFallbackMs: 200 });
});

Deno.test("startStartServer: the copy-command fallback ends the run while the page stays open", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const c = await Client.open(handle.port);
    try {
      await walkToTrust(c);
      fakes.launchOpened = false;
      await c.request("start.launch", { trustConfirmed: true });
      assertEquals(await handle.ended, { kind: "paused" });
    } finally {
      await c.close();
    }
  }, { ...LONG, copyFallbackMs: 30 });
});

Deno.test("startStartServer: two agent opens at once open only one window", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const a = await Client.open(handle.port);
    const b = await Client.open(handle.port);
    try {
      await walkToTrust(a);
      await a.request("start.launch", { trustConfirmed: true });
      assertEquals(fakes.opened.length, 1);
      fakes.openGate = new Promise((resolve) => {
        fakes.releaseOpen = resolve;
      });
      const first = a.request("start.agent.open", { id: "claude" });
      await waitFor(
        () => fakes.opened.length === 2,
        "the first open to reach the terminal launcher",
      );
      const second = b.request("start.agent.open", { id: "claude" });
      await b.dispatched();
      fakes.releaseOpen();
      await Promise.all([first, second]);
      assertEquals(fakes.opened.length, 2);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

Deno.test("startStartServer: shutdown with queued work claims and releases nothing afterwards", async () => {
  await withStartServer(
    async ({ handle, fakes, claims, dataDir, shutdown }) => {
      const c = await Client.open(handle.port);
      await walkToTrust(c);
      fakes.openGate = new Promise((resolve) => {
        fakes.releaseOpen = resolve;
      });
      c.send("start.launch", { trustConfirmed: true });
      await waitFor(
        () => fakes.opened.length === 1,
        "the launch to hold the queue",
      );
      const queued = handle.openWorkspace("beta");
      const stopped = shutdown();
      fakes.releaseOpen();
      await stopped;
      const error = await assertRejects(() => queued);
      assertStringIncludes(String(error), "stopping");
      await assertRejects(() => handle.openWorkspace("gamma"));
      assertEquals(claims.claimed.length, 1);
      assertEquals(claims.released.length, 1);
      assertPathEquals(
        claims.released[0],
        workspaceDir(dataDir, "first-workspace"),
      );
      assertEquals(handle.workspacePath(), null);
      await c.close();
    },
  );
});

Deno.test("startStartServer: an imported workspace shows the name it was registered under", async () => {
  await withStartServer(async ({ handle, dataDir }) => {
    const folder = join(dataDir, "My Repo");
    await Deno.mkdir(folder);
    await Deno.writeTextFile(join(folder, ".swamp.yaml"), "x: 1\n");
    const c = await Client.open(handle.port);
    try {
      const imported = await c.request("start.workspace.import", {
        path: folder,
        name: "my-repo",
      });
      assertEquals(imported.workspaceName, "my-repo");
      assertEquals((await c.request("start.status")).workspaceName, "my-repo");
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: an imported folder's own launched task never skips the trust confirmation", async () => {
  await withStartServer(async ({ handle, dataDir, fakes }) => {
    const folder = join(dataDir, "cloned");
    await Deno.mkdir(join(folder, ".swamp", "start"), { recursive: true });
    await Deno.writeTextFile(join(folder, ".swamp.yaml"), "x: 1\n");
    await Deno.writeTextFile(
      join(folder, ".swamp", "start", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        session: {
          id: "planted",
          workspacePath: await Deno.realPath(folder),
          createdAt: "2026-10-01T00:00:00.000Z",
          step: "launched",
          task: "hi",
          harness: "claude",
          tools: ["claude"],
          launch: {
            method: "macos_terminal",
            at: "2026-10-01T00:00:00.000Z",
            command: "",
            opened: true,
          },
        },
      }),
    );
    const c = await Client.open(handle.port);
    try {
      const imported = await c.request("start.workspace.import", {
        path: folder,
      });
      assertEquals(imported.screen, "home");
      assertEquals(imported.taskId, "planted");
      assertEquals(imported.trusted, false);

      const refused = await c.requestError("start.resume");
      assertEquals(refused.code, "trust_required");
      const refusedOpen = await c.requestError("start.agent.open", {
        id: "claude",
      });
      assertEquals(refusedOpen.code, "trust_required");
      assertEquals(fakes.opened.length, 0);

      const resumed = await c.request("start.resume", {
        trustConfirmed: true,
      });
      assertEquals(fakes.opened.length, 1);
      assertEquals(resumed.trusted, true);
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.folder.check ticks a folder holding .swamp.yaml and explains anything else", async () => {
  await withStartServer(async ({ handle, dataDir }) => {
    const repo = join(dataDir, "code", "infra");
    await Deno.mkdir(repo, { recursive: true });
    const c = await Client.open(handle.port);
    try {
      const notRepo = await c.request("start.folder.check", { path: repo });
      assertEquals(notRepo.ok, false);
      assertEquals(notRepo.code, "not_a_repo");

      await Deno.writeTextFile(join(repo, ".swamp.yaml"), "x: 1\n");
      const ok = await c.request("start.folder.check", { path: repo });
      assertEquals(ok.ok, true);

      const missing = await c.request("start.folder.check", {
        path: join(dataDir, "nope"),
      });
      assertEquals(missing.code, "not_found");
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.folder.pick answers the chosen folder and never holds up other requests", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const c = await Client.open(handle.port);
    try {
      const status = await c.request("start.status");
      assertEquals(status.canPickFolder, true);

      fakes.picked = "/Users/ada/code/infra";
      assertEquals(
        (await c.request("start.folder.pick")).path,
        "/Users/ada/code/infra",
      );

      // An open dialog doesn't block the queue, and a second pick while it
      // is open shares it.
      let release!: () => void;
      fakes.pickGate = new Promise((resolve) => release = resolve);
      fakes.picked = null;
      const first = c.request("start.folder.pick");
      const second = c.request("start.folder.pick");
      const list = await c.request("start.workspaces.list");
      assert(Array.isArray(list.workspaces));
      release();
      assertEquals((await first).path, null);
      assertEquals((await second).path, null);
      assertEquals(fakes.picks, 2);

      fakes.signedIn = { kind: "not_signed_in" };
      const refused = await c.requestError("start.folder.pick");
      assertEquals(refused.code, "not_signed_in");
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.workspace.choose with a parent creates the workspace there and claims that folder", async () => {
  await withStartServer(async ({ handle, dataDir, claims, opened }) => {
    const parent = join(dataDir, "dev");
    await Deno.mkdir(parent);
    const real = await Deno.realPath(parent);
    const c = await Client.open(handle.port);
    try {
      const status = await c.request("start.workspace.choose", {
        name: "infra",
        parent,
      });
      const path = join(real, "infra");
      assertPathEquals(status.workspacePath!, path);
      assertEquals(claims.claimed, [path]);
      assertEquals(opened, [{ path, created: true }]);
      const list = await c.request("start.workspaces.list");
      const [summary] = list.workspaces ?? [];
      assertEquals(summary.name, "infra");
      assertEquals(summary.imported, false);
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.workspace.choose refuses a relative or over-long parent, creating nothing", async () => {
  await withStartServer(async ({ handle, dataDir, claims }) => {
    const c = await Client.open(handle.port);
    try {
      assertEquals(
        (await c.requestError("start.workspace.choose", {
          name: "infra",
          parent: "dev",
        })).code,
        "parent_not_absolute",
      );
      assertEquals(
        (await c.requestError("start.workspace.choose", {
          name: "infra",
          parent: "/" + "a".repeat(5000),
        })).code,
        "invalid_request",
      );
      assertEquals(
        (await c.requestError("start.workspace.choose", {
          name: "infra",
          parent: join(dataDir, "nope"),
        })).code,
        "parent_not_found",
      );
      assertEquals(claims.claimed, []);
      await assertRejects(() => Deno.stat(join(dataDir, "nope")));
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.workspace.location.check previews the folder and reports problems by field", async () => {
  await withStartServer(async ({ handle, dataDir, claims }) => {
    const parent = join(dataDir, "dev");
    await Deno.mkdir(join(parent, "busy"), { recursive: true });
    await Deno.writeTextFile(join(parent, "busy", "notes.txt"), "x");
    const real = await Deno.realPath(parent);
    const c = await Client.open(handle.port);
    try {
      const fallback = await c.request("start.workspace.location.check", {
        name: "infra",
      });
      assertEquals(fallback.ok, true);
      assertPathEquals(fallback.path!, workspaceDir(dataDir, "infra"));

      const chosen = await c.request("start.workspace.location.check", {
        name: "infra",
        parent,
      });
      assertEquals(chosen.ok, true);
      assertPathEquals(chosen.path!, join(real, "infra"));

      const busy = await c.request("start.workspace.location.check", {
        name: "busy",
        parent,
      });
      assertEquals([busy.ok, busy.field, busy.code], [
        false,
        "location",
        "not_a_workspace",
      ]);

      await c.request("start.workspace.choose", { name: "infra" });
      const taken = await c.request("start.workspace.location.check", {
        name: "infra",
        parent,
      });
      assertEquals([taken.ok, taken.field, taken.code], [
        false,
        "name",
        "name_taken",
      ]);
      // Only the choose claimed (and created) a workspace.
      assertEquals(claims.claimed.length, 1);
    } finally {
      await c.close();
    }
  });
});

Deno.test("startStartServer: start.folder.pick asks where to create when picking a location", async () => {
  await withStartServer(async ({ handle, fakes }) => {
    const c = await Client.open(handle.port);
    try {
      fakes.picked = "/Users/ada/dev";
      assertEquals(
        (await c.request("start.folder.pick", { purpose: "location" })).path,
        "/Users/ada/dev",
      );
      await c.request("start.folder.pick");
      assertEquals(fakes.prompts, [
        "Choose where to create the workspace",
        "Choose the swamp repo to import",
      ]);

      // While one dialog is open, a pick for the other purpose is refused
      // rather than handed that dialog's answer.
      let release!: () => void;
      fakes.pickGate = new Promise((resolve) => release = resolve);
      const open = c.request("start.folder.pick", { purpose: "location" });
      await waitFor(
        () => fakes.prompts.length === 3,
        "the location chooser to open",
      );
      assertEquals(
        (await c.requestError("start.folder.pick", { purpose: "import" }))
          .code,
        "picker_busy",
      );
      release();
      assertEquals((await open).path, "/Users/ada/dev");
      assertEquals(fakes.picks, 3);
    } finally {
      await c.close();
    }
  });
});
