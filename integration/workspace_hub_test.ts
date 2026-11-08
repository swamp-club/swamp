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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ActionRunner,
  createWorkspaceHub,
  type HubChild,
  type WorkspaceHub,
} from "../src/serve/local/workspace_hub.ts";
import { TrustedHosts } from "../src/serve/local/trusted_hosts.ts";

type FakeChild = HubChild & {
  stopped: () => boolean;
  busy: boolean;
  busyAsks: number;
};

function startFakeChild(): FakeChild {
  const token = crypto.randomUUID();
  let stopped = false;
  const state = { busy: false, busyAsks: 0 };
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => resolveExited = resolve);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req): Response | Promise<Response> => {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (req.headers.get("sec-websocket-protocol") !== `bearer.${token}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req, {
          protocol: `bearer.${token}`,
        });
        socket.onmessage = (e) => {
          const frame = JSON.parse(String(e.data));
          if (frame.id === "close-please") socket.close(4001, "asked to");
          else {
            socket.send(JSON.stringify({
              type: "echo",
              id: frame.id,
              of: frame.type,
              path: url.pathname,
            }));
          }
        };
        return response;
      }
      if (req.headers.get("x-swamp-hub-token") !== token) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/stream") {
        // Like the health SSE: never ends on its own.
        let timer: ReturnType<typeof setInterval> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(
              () => controller.enqueue(new TextEncoder().encode("tick\n")),
              20,
            );
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/local/busy") {
        state.busyAsks++;
        return Response.json({ busy: state.busy });
      }
      if (url.pathname === "/api/v1/request") {
        return req.text().then((body) =>
          Response.json({ path: url.pathname, body })
        );
      }
      if (url.pathname === "/gzip") {
        const body = new Blob(["plain text\n"]).stream()
          .pipeThrough(new CompressionStream("gzip"));
        return new Response(body, {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      return Response.json({ path: url.pathname, search: url.search });
    },
  );
  return {
    port: server.addr.port,
    token,
    exited,
    stopped: () => stopped,
    get busy() {
      return state.busy;
    },
    set busy(value: boolean) {
      state.busy = value;
    },
    get busyAsks() {
      return state.busyAsks;
    },
    async stop() {
      stopped = true;
      await server.shutdown();
      resolveExited();
    },
  };
}

const TOKEN = "local-token-for-tests";

function hubFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-swamp-local-token", TOKEN);
  return fetch(url, { ...init, headers });
}

function read(id: string, type = "workflow.search"): string {
  return JSON.stringify({ type, id, payload: {} });
}

interface Env {
  base: string;
  hub: WorkspaceHub;
  spawned: string[];
  children: FakeChild[];
  tracked: WebSocket[];
}

async function withHub(
  fn: (env: Env) => Promise<void>,
  options: {
    failFirstSpawn?: boolean;
    switchable?: boolean;
    idleMs?: number;
    actions?: ActionRunner;
    trustedHosts?: TrustedHosts;
  } = {},
): Promise<void> {
  const spawned: string[] = [];
  const children: FakeChild[] = [];
  const tracked: WebSocket[] = [];
  let failNext = options.failFirstSpawn ?? false;
  const hub = createWorkspaceHub({
    token: TOKEN,
    resolveWorkspace: (name) =>
      Promise.resolve(
        name === "alpha" || name === "beta" ? `/repos/${name}` : null,
      ),
    listWorkspaces: () =>
      Promise.resolve([
        { name: "alpha", path: "/repos/alpha" },
        { name: "beta", path: "/repos/beta" },
      ]),
    spawnChild: (repoDir) => {
      spawned.push(repoDir);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("no start"));
      }
      const child = startFakeChild();
      children.push(child);
      return Promise.resolve(child);
    },
    ...(options.switchable === undefined
      ? {}
      : { switchable: options.switchable }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.trustedHosts === undefined
      ? {}
      : { trustedHosts: options.trustedHosts }),
  });
  const front = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) =>
      await hub.handle(req, (s) => tracked.push(s)) ??
        new Response("not a hub route", { status: 404 }),
  );
  try {
    await fn({
      base: `127.0.0.1:${front.addr.port}`,
      hub,
      spawned,
      children,
      tracked,
    });
  } finally {
    await hub.shutdown();
    await front.shutdown();
    for (const child of children) {
      if (!child.stopped()) await child.stop();
    }
  }
}

function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, [`bearer.${TOKEN}`]);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`could not open ${url}`));
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(String(e.data));
  });
}

function closed(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    ws.onclose = (e) => resolve(e);
  });
}

Deno.test("workspaceHub: lists the workspaces for the switcher", async () => {
  await withHub(async ({ base }) => {
    const res = await hubFetch(`http://${base}/api/local/workspaces`);
    assertEquals(await res.json(), {
      workspaces: [
        { name: "alpha", path: "/repos/alpha" },
        { name: "beta", path: "/repos/beta" },
      ],
      switchable: true,
    });
  });
});

Deno.test("workspaceHub: a hub for one fixed repo says it is not switchable", async () => {
  await withHub(async ({ base }) => {
    const res = await hubFetch(`http://${base}/api/local/workspaces`);
    assertEquals((await res.json()).switchable, false);
  }, { switchable: false });
});

Deno.test("workspaceHub: an unknown workspace is 404 and starts nothing", async () => {
  await withHub(async ({ base, spawned }) => {
    const res = await hubFetch(`http://${base}/w/gamma/auth/info`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: other paths are not hub routes", async () => {
  await withHub(async ({ base }) => {
    const res = await hubFetch(`http://${base}/dashboard/w/alpha`);
    assertEquals(await res.text(), "not a hub route");
  });
});

Deno.test("workspaceHub: forwards a request to its workspace's child with the token, without the prefix", async () => {
  await withHub(async ({ base }) => {
    const res = await hubFetch(
      `http://${base}/w/alpha/api/v1/health/stream?interval=5000`,
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      path: "/api/v1/health/stream",
      search: "?interval=5000",
    });
  });
});

Deno.test("workspaceHub: starts one child per workspace, however many requests race for it", async () => {
  await withHub(async ({ base, spawned }) => {
    const answers = await Promise.all(
      [..."abcdef"].map((_, i) =>
        hubFetch(`http://${base}/w/${i % 2 ? "alpha" : "beta"}/auth/info`)
      ),
    );
    for (const a of answers) await a.body?.cancel();
    assertEquals(spawned.sort(), ["/repos/alpha", "/repos/beta"]);
  });
});

Deno.test("workspaceHub: a child that fails to start is 502, and the next request starts it again", async () => {
  await withHub(async ({ base, spawned }) => {
    const first = await hubFetch(`http://${base}/w/alpha/auth/info`);
    assertEquals(first.status, 502);
    await first.body?.cancel();
    const second = await hubFetch(`http://${base}/w/alpha/auth/info`);
    assertEquals(second.status, 200);
    await second.body?.cancel();
    assertEquals(spawned, ["/repos/alpha", "/repos/alpha"]);
  }, { failFirstSpawn: true });
});

Deno.test("workspaceHub: a child that exits is started again on next use", async () => {
  await withHub(async ({ base, spawned, children }) => {
    const first = await hubFetch(`http://${base}/w/alpha/auth/info`);
    await first.body?.cancel();
    await children[0].stop();
    await waitFor(async () => {
      const res = await hubFetch(`http://${base}/w/alpha/auth/info`);
      await res.body?.cancel();
      return res.status === 200 && spawned.length === 2;
    }, "the child to be started again");
  });
});

Deno.test("workspaceHub: forwards a WebSocket both ways and tracks the browser's socket", async () => {
  await withHub(async ({ base, tracked }) => {
    const ws = await openSocket(`ws://${base}/w/beta/?compress=gzip`);
    const reply = nextMessage(ws);
    ws.send(read("hello"));
    assertEquals(JSON.parse(await reply), {
      type: "echo",
      id: "hello",
      of: "workflow.search",
      path: "/",
    });
    assertEquals(ws.protocol, `bearer.${TOKEN}`);
    assertEquals(tracked.length, 1);
    const done = closed(ws);
    ws.close();
    await done;
  });
});

Deno.test("workspaceHub: a socket the child closes closes the browser's, with its code", async () => {
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const done = closed(ws);
    ws.send(read("close-please"));
    const event = await done;
    assertEquals(event.code, 4001);
  });
});

Deno.test("workspaceHub: a browser socket closing reaches the child and the hub keeps serving", async () => {
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const done = closed(ws);
    ws.close(1000);
    await done;
    const again = await openSocket(`ws://${base}/w/alpha/`);
    const reply = nextMessage(again);
    again.send(read("still-here"));
    assertEquals(JSON.parse(await reply).id, "still-here");
    const closedAgain = closed(again);
    again.close();
    await closedAgain;
  });
});

Deno.test("workspaceHub: refuses a socket from any origin but its own", async () => {
  await withHub(async ({ base, spawned }) => {
    for (
      const origin of ["http://127.0.0.1:1", "http://localhost:3000", "null"]
    ) {
      const res = await hubFetch(`http://${base}/w/alpha/`, {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          origin,
        },
      });
      assertEquals(res.status, 403, origin);
      await res.body?.cancel();
    }
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: shutdown stops every child and answers 503 after", async () => {
  await withHub(async ({ base, hub, children }) => {
    for (const name of ["alpha", "beta"]) {
      const res = await hubFetch(`http://${base}/w/${name}/auth/info`);
      await res.body?.cancel();
    }
    await hub.shutdown();
    assertEquals(children.map((c) => c.stopped()), [true, true]);
    const res = await hubFetch(`http://${base}/w/alpha/auth/info`);
    assertEquals(res.status, 503);
    await res.body?.cancel();
  });
});

/** True if the child is still up `ms` after now: a bounded look, not a wait for work. */
async function stillUpAfter(child: FakeChild, ms: number): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !child.stopped();
}

Deno.test("workspaceHub: a child with no dashboard tab open stops once idle", async () => {
  await withHub(async ({ base, children }) => {
    const res = await hubFetch(`http://${base}/w/alpha/auth/info`);
    await res.body?.cancel();
    await waitFor(() => children[0].stopped(), "the idle child to stop");
    assertEquals(children[0].busyAsks, 1);
  }, { idleMs: 20 });
});

Deno.test("workspaceHub: an open tab keeps its child up, and closing it starts the idle stop", async () => {
  await withHub(async ({ base, children }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    assertEquals(await stillUpAfter(children[0], 100), true);
    assertEquals(children[0].busyAsks, 0);
    const done = closed(ws);
    ws.close();
    await done;
    await waitFor(() => children[0].stopped(), "the child to stop");
  }, { idleMs: 20 });
});

Deno.test("workspaceHub: a busy child is not stopped until its runs end", async () => {
  await withHub(async ({ base, children }) => {
    const res = await hubFetch(`http://${base}/w/alpha/auth/info`);
    await res.body?.cancel();
    children[0].busy = true;
    await waitFor(
      () => children[0].busyAsks >= 2,
      "the hub to ask the busy child again",
    );
    assertEquals(children[0].stopped(), false);
    children[0].busy = false;
    await waitFor(() => children[0].stopped(), "the child to stop");
  }, { idleMs: 20 });
});

Deno.test("workspaceHub: a child stopped for idling starts again on next use", async () => {
  await withHub(async ({ base, children, spawned }) => {
    const first = await hubFetch(`http://${base}/w/alpha/auth/info`);
    await first.body?.cancel();
    await waitFor(() => children[0].stopped(), "the idle child to stop");
    const again = await hubFetch(`http://${base}/w/alpha/auth/info`);
    assertEquals(again.status, 200);
    await again.body?.cancel();
    assertEquals(spawned, ["/repos/alpha", "/repos/alpha"]);
  }, { idleMs: 20 });
});

const RUN = "321991e2-f182-4bb2-9937-f94c18ed1bfd";

function fakeActions(answers: {
  run?: { code: number; stdout: string; stderr: string };
  startExit?: Promise<number>;
  startedAfterPolls?: number;
} = {}) {
  const calls: Array<{ repoDir: string; args: readonly string[] }> = [];
  let polls = 0;
  const runner: ActionRunner = {
    run: (repoDir, args) => {
      calls.push({ repoDir, args });
      return Promise.resolve(
        answers.run ?? { code: 0, stdout: '{"approved":true}', stderr: "" },
      );
    },
    start: (repoDir, args) => {
      calls.push({ repoDir, args });
      return { pid: 4242, exited: answers.startExit ?? new Promise(() => {}) };
    },
    watchRuns: () => ({
      isRunning: (runId, pid) => {
        polls++;
        return runId === RUN && pid === 4242 &&
          polls > (answers.startedAfterPolls ?? 0);
      },
      close: () => {},
    }),
  };
  return { runner, calls };
}

function frames(ws: WebSocket): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  ws.onmessage = (e) => {
    const text = String(e.data);
    try {
      seen.push(JSON.parse(text));
    } catch {
      seen.push({ raw: text });
    }
  };
  return seen;
}

async function closeSocket(ws: WebSocket) {
  const done = closed(ws);
  ws.close();
  await done;
}

Deno.test("workspaceHub: approve runs the CLI in the workspace and replies with its JSON, never reaching the child", async () => {
  const { runner, calls } = fakeActions();
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.approve",
      id: "a1",
      payload: { workflowIdOrName: "gated", stepName: "example", runId: RUN },
    }));
    ws.send(read("ping"));
    await waitFor(() => seen.length === 2, "the reply and the echo");
    assertEquals(seen[0], {
      type: "workflow.approve",
      id: "a1",
      payload: { data: { approved: true } },
    });
    assertEquals(seen[1], {
      type: "echo",
      id: "ping",
      of: "workflow.search",
      path: "/",
    });
    assertEquals(calls, [{
      repoDir: "/repos/alpha",
      args: [
        "workflow",
        "approve",
        "gated",
        "example",
        `--run=${RUN}`,
        "--json",
      ],
    }]);
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: a failed action is an error frame with the CLI's message", async () => {
  const { runner } = fakeActions({
    run: { code: 1, stdout: '{"error":"Approval window expired"}', stderr: "" },
  });
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.reject",
      id: "r1",
      payload: { workflowIdOrName: "gated", stepName: "example", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the error");
    assertEquals(seen[0], {
      type: "error",
      id: "r1",
      error: {
        code: "workflow_reject_failed",
        message: "Approval window expired",
      },
    });
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: an invalid action runs nothing", async () => {
  const { runner, calls } = fakeActions();
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.cancel",
      id: "c1",
      payload: { workflowIdOrName: "--all", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the error");
    assertEquals(seen[0].type, "error");
    assertEquals(calls, []);
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: resume says started once the run runs, then done, and the page's detach stays in the hub", async () => {
  let finish!: (code: number) => void;
  const { runner, calls } = fakeActions({
    startExit: new Promise((resolve) => finish = resolve),
    startedAfterPolls: 2,
  });
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.resume",
      id: "s1",
      payload: { workflowIdOrName: "gated", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the started event");
    assertEquals(seen[0], { type: "event", id: "s1", payload: { runId: RUN } });
    // The page detaches with a cancel for its request id: not for the child.
    ws.send(JSON.stringify({ type: "cancel", id: "s1" }));
    ws.send(read("ping"));
    await waitFor(() => seen.length === 2, "the echo");
    assertEquals(seen[1], {
      type: "echo",
      id: "ping",
      of: "workflow.search",
      path: "/",
    });
    finish(0);
    await waitFor(() => seen.length === 3, "done");
    assertEquals(seen[2], { type: "done", id: "s1" });
    assertEquals(calls[0].args, [
      "workflow",
      "resume",
      "gated",
      `--run=${RUN}`,
      "--json",
    ]);
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: a resume that stops before its run starts is an error naming the command", async () => {
  const { runner } = fakeActions({
    startExit: Promise.resolve(1),
    startedAfterPolls: 1_000_000,
  });
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.resume",
      id: "s2",
      payload: { workflowIdOrName: "gated", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the error");
    assertEquals(seen[0].type, "error");
    const message = (seen[0].error as { message: string }).message;
    assertEquals(
      message.includes(`swamp workflow resume gated --run=${RUN}`),
      true,
      message,
    );
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: every hub route needs the page's token, and nothing starts without it", async () => {
  await withHub(async ({ base, spawned }) => {
    for (const token of [null, "wrong"]) {
      const headers: Record<string, string> = token === null
        ? {}
        : { "x-swamp-local-token": token };
      for (const path of ["/api/local/workspaces", "/w/alpha/auth/info"]) {
        const res = await fetch(`http://${base}${path}`, { headers });
        assertEquals(res.status, 401, `${path} with ${token}`);
        await res.body?.cancel();
      }
      const upgrade = await fetch(`http://${base}/w/alpha/`, {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...(token === null
            ? {}
            : { "sec-websocket-protocol": `bearer.${token}` }),
        },
      });
      assertEquals(upgrade.status, 401);
      await upgrade.body?.cancel();
    }
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: forwards the agent sessions page's data.query to the child", async () => {
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "data.query",
      id: "sessions",
      payload: { predicate: 'tags.type == "agent-session"', limit: 1 },
    }));
    await waitFor(() => seen.length === 1, "the query's echo");
    assertEquals(seen[0], {
      type: "echo",
      id: "sessions",
      of: "data.query",
      path: "/",
    });
    await closeSocket(ws);
  });
});

Deno.test("workspaceHub: writes and reads the dashboard never makes are refused and never reach the child", async () => {
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    for (
      const type of [
        "workflow.run",
        "model.method.run",
        "vault.put",
        "vault.get",
        "data.delete",
        "workflow.trigger.set",
        "access.reload",
      ]
    ) {
      ws.send(JSON.stringify({ type, id: type, payload: {} }));
    }
    ws.send(read("after"));
    await waitFor(() => seen.length === 8, "seven refusals and one echo");
    for (const frame of seen.slice(0, 7)) {
      assertEquals(frame.type, "error");
      assertEquals(
        (frame.error as { code: string }).code,
        "not_available_locally",
      );
    }
    assertEquals(seen[7], {
      type: "echo",
      id: "after",
      of: "workflow.search",
      path: "/",
    });
    await closeSocket(ws);
  });
});

Deno.test("workspaceHub: a cancel reaches the child only for a read it forwarded", async () => {
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(read("r1"));
    await waitFor(() => seen.length === 1, "the read's echo");
    // A cancel naming a run id would cancel that run: never forwarded.
    ws.send(JSON.stringify({ type: "cancel", id: RUN }));
    ws.send(JSON.stringify({ type: "cancel", id: "r1" }));
    ws.send(read("r2"));
    await waitFor(() => seen.length === 3, "two more echoes");
    assertEquals(seen.map((f) => [f.id, f.of]), [
      ["r1", "workflow.search"],
      ["r1", "cancel"],
      ["r2", "workflow.search"],
    ]);
    await closeSocket(ws);
  });
});

Deno.test("workspaceHub: shutdown ends a forwarded stream a tab still holds open", async () => {
  await withHub(async ({ base, hub }) => {
    const res = await hubFetch(`http://${base}/w/alpha/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    await hub.shutdown();
    let ended = false;
    try {
      while (!(await reader.read()).done) { /* drain what was in flight */ }
      ended = true;
    } catch {
      ended = true;
    }
    assertEquals(ended, true);
  });
});

Deno.test("workspaceHub: an HTTP stream in flight keeps its child up; when it ends the idle stop runs", async () => {
  await withHub(async ({ base, children }) => {
    const res = await hubFetch(`http://${base}/w/alpha/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    assertEquals(await stillUpAfter(children[0], 100), true);
    assertEquals(children[0].busyAsks, 0);
    await reader.cancel();
    await waitFor(() => children[0].stopped(), "the child to stop");
  }, { idleMs: 20 });
});

Deno.test("workspaceHub: a malformed upgrade is 400 and leaves the child free to idle out", async () => {
  await withHub(async ({ base, children }) => {
    const res = await hubFetch(`http://${base}/w/alpha/`, {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
    await waitFor(() => children[0]?.stopped() === true, "the child to stop");
  }, { idleMs: 20 });
});

Deno.test("workspaceHub: shutdown stops an action still running instead of waiting for it", async () => {
  let aborted = false;
  let called = false;
  const runner: ActionRunner = {
    run: (_repoDir, _args, signal) =>
      new Promise((resolve) => {
        called = true;
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ code: 1, stdout: "", stderr: "stopped" });
        }, { once: true });
      }),
    start: () => ({ pid: 1, exited: new Promise(() => {}) }),
    watchRuns: () => ({ isRunning: () => false, close: () => {} }),
  };
  await withHub(async ({ base, hub }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    ws.send(JSON.stringify({
      type: "workflow.approve",
      id: "stuck",
      payload: { workflowIdOrName: "gated", stepName: "example", runId: RUN },
    }));
    await waitFor(() => called, "the action to be running");
    await hub.shutdown();
    assertEquals(aborted, true);
    ws.close();
  }, { actions: runner });
});

Deno.test("workspaceHub: a resume whose run tracker can't be opened fails with nothing started", async () => {
  let starts = 0;
  const runner: ActionRunner = {
    run: () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" }),
    start: () => {
      starts++;
      return { pid: 1, exited: new Promise(() => {}) };
    },
    watchRuns: () => {
      throw new Error("database is locked");
    },
  };
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.resume",
      id: "r-open",
      payload: { workflowIdOrName: "gated", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the error");
    assertEquals(seen[0].type, "error");
    assertEquals(starts, 0);
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: a tracker read that fails after the resume started reports it started, never failed", async () => {
  let starts = 0;
  const runner: ActionRunner = {
    run: () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" }),
    start: () => {
      starts++;
      return { pid: 1, exited: new Promise(() => {}) };
    },
    watchRuns: () => ({
      isRunning: () => {
        throw new Error("disk I/O error");
      },
      close: () => {
        throw new Error("already closed");
      },
    }),
  };
  await withHub(async ({ base }) => {
    const ws = await openSocket(`ws://${base}/w/alpha/`);
    const seen = frames(ws);
    ws.send(JSON.stringify({
      type: "workflow.resume",
      id: "r-read",
      payload: { workflowIdOrName: "gated", runId: RUN },
    }));
    await waitFor(() => seen.length === 1, "the started event");
    assertEquals(seen[0], {
      type: "event",
      id: "r-read",
      payload: { runId: RUN },
    });
    assertEquals(starts, 1);
    await closeSocket(ws);
  }, { actions: runner });
});

Deno.test("workspaceHub: a request whose lookup is still in flight when shutdown begins starts nothing", async () => {
  let release!: (path: string | null) => void;
  const lookup = new Promise<string | null>((resolve) => release = resolve);
  const spawned: string[] = [];
  const hub = createWorkspaceHub({
    token: TOKEN,
    resolveWorkspace: () => lookup,
    listWorkspaces: () => Promise.resolve([]),
    spawnChild: (repoDir) => {
      spawned.push(repoDir);
      return Promise.reject(new Error("must not start"));
    },
  });
  const answer = hub.handle(
    new Request("http://127.0.0.1:1/w/alpha/auth/info", {
      headers: { "x-swamp-local-token": TOKEN },
    }),
    () => {},
  );
  await hub.shutdown();
  release("/repos/alpha");
  const res = await answer;
  assertEquals(res?.status, 503);
  await res?.body?.cancel();
  assertEquals(spawned, []);
});

Deno.test("workspaceHub: a request route body still arriving when shutdown begins starts nothing", async () => {
  let sendBody!: ReadableStreamDefaultController<Uint8Array>;
  let reading!: () => void;
  const bodyRead = new Promise<void>((resolve) => reading = resolve);
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => sendBody = controller,
    pull: () => reading(),
  }, { highWaterMark: 0 });
  const spawned: string[] = [];
  const hub = createWorkspaceHub({
    token: TOKEN,
    resolveWorkspace: () => Promise.resolve("/repos/alpha"),
    listWorkspaces: () => Promise.resolve([]),
    spawnChild: (repoDir) => {
      spawned.push(repoDir);
      return Promise.reject(new Error("must not start"));
    },
  });
  const answer = hub.handle(
    new Request("http://127.0.0.1:1/w/alpha/api/v1/request", {
      method: "POST",
      headers: { "x-swamp-local-token": TOKEN },
      body,
    }),
    () => {},
  );
  await bodyRead;
  await hub.shutdown();
  sendBody.enqueue(new TextEncoder().encode(read("r1", "data.get")));
  sendBody.close();
  const res = await answer;
  assertEquals(res?.status, 503);
  await res?.body?.cancel();
  assertEquals(spawned, []);
});

Deno.test("workspaceHub: a lowercase method on the request route is filtered like POST", async () => {
  await withHub(async ({ base, spawned }) => {
    const [hostname, port] = base.split(":");
    const conn = await Deno.connect({ hostname, port: Number(port) });
    const body = read("r1", "data.list");
    await conn.write(new TextEncoder().encode(
      `post /w/alpha/api/v1/request HTTP/1.1\r\nHost: ${base}\r\n` +
        `x-swamp-local-token: ${TOKEN}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    ));
    const reply = new TextDecoder().decode(
      await new Response(conn.readable).arrayBuffer(),
    );
    assertStringIncludes(reply.split("\r\n")[0], " 404 ");
    assertStringIncludes(reply, '"use_websocket"');
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: forwards a dashboard read on the HTTP request route to the child", async () => {
  await withHub(async ({ base }) => {
    const body = read("r1", "data.get");
    const res = await hubFetch(`http://${base}/w/alpha/api/v1/request`, {
      method: "POST",
      body,
    });
    assertEquals(await res.json(), { path: "/api/v1/request", body });
  });
});

Deno.test("workspaceHub: a request the child is not given goes back to the socket without starting the child", async () => {
  await withHub(async ({ base, spawned }) => {
    for (const type of ["data.list", "model.method.run", "vault.put"]) {
      const res = await hubFetch(`http://${base}/w/alpha/api/v1/request`, {
        method: "POST",
        body: read("r1", type),
      });
      assertEquals(res.status, 404, type);
      assertEquals((await res.json()).code, "use_websocket", type);
    }
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: an HTTP request body over the cap is refused with 413", async () => {
  await withHub(async ({ base, spawned }) => {
    const res = await hubFetch(`http://${base}/w/alpha/api/v1/request`, {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    });
    assertEquals(res.status, 413);
    await res.body?.cancel();
    assertEquals(spawned, []);
  });
});

Deno.test("workspaceHub: a body fetch already decoded is forwarded without its content-encoding", async () => {
  await withHub(async ({ base }) => {
    const res = await hubFetch(`http://${base}/w/alpha/gzip`, {
      headers: { "accept-encoding": "gzip" },
    });
    assertEquals(res.headers.get("content-encoding"), null);
    assertEquals(await res.text(), "plain text\n");
  });
});

/** the status of a socket upgrade sent with exactly this Host and Origin */
async function upgradeStatus(
  base: string,
  host: string,
  origin: string,
): Promise<number> {
  const [hostname, port] = base.split(":");
  const conn = await Deno.connect({ hostname, port: Number(port) });
  try {
    const request = [
      "GET /w/alpha/ HTTP/1.1",
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Sec-WebSocket-Protocol: bearer.${TOKEN}`,
      `Origin: ${origin}`,
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    const text = new TextDecoder().decode(buf.subarray(0, n ?? 0));
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
  } finally {
    conn.close();
  }
}

Deno.test("workspaceHub: a trusted Host's https origin may open a socket; an https origin on any other Host may not", async () => {
  await withHub(async ({ base, spawned }) => {
    assertEquals(
      await upgradeStatus(base, "proxy.example", "https://proxy.example"),
      101,
    );
    assertEquals(
      await upgradeStatus(
        base,
        "Proxy.Example:8443",
        "https://proxy.example:8443",
      ),
      101,
    );
    assertEquals(
      await upgradeStatus(base, "proxy.example", "https://evil.example"),
      403,
    );
    assertEquals(
      await upgradeStatus(base, "proxy.example", "https://proxy.example:9999"),
      403,
    );
    assertEquals(await upgradeStatus(base, base, `https://${base}`), 403);
    assertEquals(spawned, ["/repos/alpha"]);
  }, { trustedHosts: TrustedHosts.parse("proxy.example") });
});

Deno.test("workspaceHub: with no trusted hosts, an https origin is refused even when it matches the Host", async () => {
  await withHub(async ({ base, spawned }) => {
    assertEquals(
      await upgradeStatus(base, "proxy.example", "https://proxy.example"),
      403,
    );
    assertEquals(spawned, []);
  });
});
