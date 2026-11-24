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

import { assert, assertEquals } from "@std/assert";
import { appBridgeConformanceSuite } from "../../../testing/app_bridge_conformance.ts";
import type {
  BridgeFrame,
  BridgePort,
  HostMessage,
} from "../../../app-sdk/bridge.ts";
import {
  APP_RUN_TAG,
  AppBroker,
  type BrokerHost,
  isAppPath,
  MIN_NAVIGATION_GAP_MS,
} from "./broker.ts";

interface Sent {
  frame: BridgeFrame;
  onFrame(frame: BridgeFrame): void;
}

/** Delivery is on microtasks, so this runs everything already sent. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakePair(): { app: BridgePort; host: BridgePort } {
  const make = (): BridgePort & { peer?: BridgePort } => ({
    onmessage: null,
    postMessage(message) {
      queueMicrotask(() => this.peer?.onmessage?.({ data: message }));
    },
    close() {},
  });
  const app = make();
  const host = make();
  app.peer = host;
  host.peer = app;
  return { app, host };
}

function setup(
  grant: {
    capabilities: string[];
    run: string[];
    methods?: { behavior: string; type: string; methods: string[] }[];
  },
  overrides: Partial<BrokerHost> = {},
) {
  const { app, host } = fakePair();
  const sent: Sent[] = [];
  const received: HostMessage[] = [];
  app.onmessage = (event) => received.push(event.data as HostMessage);
  const broker = new AppBroker(host, {
    app: {
      name: "@acme/cost",
      title: "Cost",
      local: false,
      methods: [],
      ...grant,
    },
    theme: { mode: "light", tokens: {} },
    connected: true,
    path: "/",
    host: {
      sendFrame: (frame, onFrame) => sent.push({ frame, onFrame }),
      isHttpRead: () => false,
      request: () => Promise.resolve({}),
      subscribeHealth: () => () => {},
      navigate: () => {},
      close: () => {},
      ...overrides,
    },
  });
  const post = (frame: BridgeFrame) => {
    app.postMessage({ kind: "frame", frame });
    return drain();
  };
  const framesFor = (id: string) =>
    received.flatMap((message) =>
      message.kind === "frame" && message.frame.id === id ? [message.frame] : []
    );
  return { app, broker, sent, received, post, framesFor };
}

appBridgeConformanceSuite({
  name: "broker",
  start: (grant, replies) => {
    const { app, host } = fakePair();
    new AppBroker(host, {
      app: {
        name: "@acme/cost",
        title: "Cost",
        local: false,
        capabilities: grant.capabilities,
        run: grant.run,
        methods: grant.methods ?? [],
      },
      theme: { mode: "light", tokens: {} },
      connected: true,
      path: "/",
      host: {
        sendFrame: (frame, onFrame) =>
          onFrame({
            type: frame.type,
            id: frame.id,
            payload: replies[frame.type],
          }),
        isHttpRead: () => false,
        request: () => Promise.resolve({}),
        subscribeHealth: () => () => {},
        navigate: () => {},
        close: () => {},
      },
    });
    return app;
  },
});

Deno.test("AppBroker: a reply returns under the app's own id", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  });
  await post({ type: "workflow.run.search", id: "a" });
  assert(sent[0].frame.id !== "a");
  sent[0].onFrame({
    type: "workflow.run.search",
    id: sent[0].frame.id,
    payload: 1,
  });
  await drain();
  assertEquals(framesFor("a")[0].payload, 1);
});

Deno.test("AppBroker: an id the app picks never travels, so it cannot name a run", async () => {
  const runId = crypto.randomUUID();
  const { sent, post } = setup({ capabilities: ["runs:read"], run: [] });
  await post({ type: "workflow.run.search", id: runId });
  await post({ type: "cancel", id: runId });
  assertEquals(sent.length, 2);
  for (const { frame } of sent) {
    assert(frame.id !== runId);
    assert(frame.id.startsWith("app:"), frame.id);
  }
});

Deno.test("AppBroker: a reused id still in flight is refused", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  });
  await post({ type: "workflow.run.search", id: "a" });
  await post({ type: "workflow.run.search", id: "a" });
  assertEquals(sent.length, 1);
  assertEquals(framesFor("a")[0].error?.code, "duplicate_id");
});

Deno.test("AppBroker: a cancel naming anything but its own request is dropped", async () => {
  const { sent, post } = setup({ capabilities: ["runs:read"], run: [] });
  await post({ type: "cancel", id: "someone-elses-run-id" });
  assertEquals(sent.length, 0);
});

Deno.test("AppBroker: a cancel of its own request goes out under the real id", async () => {
  const { sent, post } = setup({ capabilities: ["runs:read"], run: [] });
  await post({ type: "workflow.run.search", id: "a" });
  await post({ type: "cancel", id: "a" });
  assertEquals(sent[1].frame, { type: "cancel", id: sent[0].frame.id });
});

Deno.test("AppBroker: serve's own request limit reaches the app unchanged", async () => {
  // serve's per-socket MAX_ACTIVE_REQUESTS bounds the app alone
  const limit = 100;
  let active = 0;
  const forwarded: BridgeFrame[] = [];
  const { post, framesFor } = setup({ capabilities: ["runs:read"], run: [] }, {
    sendFrame: (frame, onFrame) => {
      forwarded.push(frame);
      if (active >= limit) {
        onFrame({
          type: "error",
          id: frame.id,
          error: { code: "too_many_requests", message: "limit: 100" },
        });
        return;
      }
      active++;
    },
  });
  for (let i = 0; i <= limit; i++) {
    await post({ type: "workflow.run.search", id: `r${i}` });
  }
  assertEquals(forwarded.length, limit + 1);
  assertEquals(framesFor(`r${limit - 1}`).length, 0);
  assertEquals(framesFor(`r${limit}`), [{
    type: "error",
    id: `r${limit}`,
    error: { code: "too_many_requests", message: "limit: 100" },
  }]);
});

Deno.test("AppBroker: a cancel ends the app's request and frees its id", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  });
  for (let i = 0; i < 3; i++) {
    await post({ type: "workflow.run.search", id: "a" });
    await post({ type: "cancel", id: "a" });
  }
  assertEquals(framesFor("a").at(-1)?.error?.code, "cancelled");
  assertEquals(
    sent.filter((entry) => entry.frame.type !== "cancel").length,
    3,
  );
});

Deno.test("AppBroker: a cancel of an HTTP read sends nothing", async () => {
  const { sent, post, framesFor } = setup(
    { capabilities: ["data:read"], run: [] },
    {
      isHttpRead: () => true,
      request: () => new Promise(() => {}),
    },
  );
  await post({ type: "data.get", id: "r" });
  await post({ type: "cancel", id: "r" });
  assertEquals(sent.length, 0);
  assertEquals(framesFor("r").length, 0);
});

Deno.test("AppBroker: an app's data.query never asks for its reply in parts", async () => {
  const requested: unknown[] = [];
  const { post, framesFor } = setup(
    { capabilities: ["data:read"], run: [] },
    {
      isHttpRead: () => true,
      request: (_type, payload) => {
        requested.push(payload);
        return Promise.resolve({ data: {} });
      },
    },
  );
  await post({
    type: "data.query",
    id: "q",
    payload: { predicate: "true", limit: 5, inParts: true },
  });
  assertEquals(requested, [{ predicate: "true", limit: 5 }]);
  assertEquals(framesFor("q").map((frame) => frame.payload), [{ data: {} }]);
});

Deno.test("AppBroker: a late reply never settles a reused id", async () => {
  const replies: ((value: unknown) => void)[] = [];
  const { broker, post, framesFor } = setup(
    { capabilities: ["data:read"], run: [] },
    {
      isHttpRead: () => true,
      request: () => new Promise((resolve) => replies.push(resolve)),
    },
  );
  await post({ type: "data.get", id: "a" });
  broker.setConnected(false);
  await post({ type: "data.get", id: "a" });
  replies[0]("old");
  await drain();
  assertEquals(
    framesFor("a").filter((frame) => frame.payload === "old").length,
    0,
  );
});

Deno.test("AppBroker: closing closes the app's socket once", async () => {
  let closed = 0;
  const { broker, sent, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  }, {
    close: () => {
      closed++;
    },
  });
  await post({ type: "workflow.run.search", id: "a" });
  broker.close();
  broker.close();
  assertEquals(closed, 1);
  // serve ends what was in flight when the socket closes
  assertEquals(sent.length, 1);
  sent[0].onFrame({
    type: "workflow.run.search",
    id: sent[0].frame.id,
    payload: 1,
  });
  await drain();
  assertEquals(framesFor("a").length, 0);
});

Deno.test("AppBroker: a run carries only what an app may choose", async () => {
  const { sent, post } = setup({ capabilities: [], run: ["@acme/nightly"] });
  await post({
    type: "workflow.run",
    id: "a",
    payload: {
      workflowIdOrName: "@acme/nightly",
      inputs: { day: "mon" },
      skipAllChecks: true,
      skipCheckNames: ["x"],
      skipAllReports: true,
      noSupersede: true,
      lockHolderTokens: "stolen",
    },
  });
  assertEquals(sent[0].frame.payload, {
    workflowIdOrName: "@acme/nightly",
    inputs: { day: "mon" },
    runtimeTags: { [APP_RUN_TAG]: "@acme/cost" },
  });
});

Deno.test("isAppPath: only a path inside the app", () => {
  assertEquals(isAppPath("/reports/monthly"), true);
  for (
    const path of [
      "x",
      "/../vaults",
      "//evil.example",
      "/a\\b",
      "/%2e%2e/vaults",
      "/%2E%2E/%2e%2e/vaults",
      "/%5cevil",
      "/%zz",
    ]
  ) {
    assertEquals(isAppPath(path), false, path);
  }
});

Deno.test("AppBroker: navigation is checked and rate limited", async () => {
  const went: string[] = [];
  let now = 10_000;
  const { app } = setup({ capabilities: [], run: [] }, {
    navigate: (path) => went.push(path),
    now: () => now,
  });
  app.postMessage({ kind: "navigate", path: "/../vaults" });
  app.postMessage({ kind: "navigate", path: "/one" });
  app.postMessage({ kind: "navigate", path: "/two" });
  await drain();
  now += MIN_NAVIGATION_GAP_MS;
  app.postMessage({ kind: "navigate", path: "/three" });
  await drain();
  assertEquals(went, ["/one", "/three"]);
});

Deno.test("AppBroker: a run is tagged and claims no locks", async () => {
  const { sent, post } = setup({ capabilities: [], run: ["@acme/nightly"] });
  await post({
    type: "workflow.run",
    id: "a",
    payload: {
      workflowIdOrName: "@acme/nightly",
      lockHolderTokens: "stolen",
      runtimeTags: { team: "cost" },
    },
  });
  const payload = sent[0].frame.payload as Record<string, unknown>;
  assertEquals(payload.lockHolderTokens, undefined);
  assertEquals(payload.runtimeTags, {
    team: "cost",
    [APP_RUN_TAG]: "@acme/cost",
  });
});

Deno.test("AppBroker: an app cannot overwrite its run tag", async () => {
  const { sent, post } = setup({ capabilities: [], run: ["@acme/nightly"] });
  await post({
    type: "workflow.run",
    id: "a",
    payload: {
      workflowIdOrName: "@acme/nightly",
      runtimeTags: { [APP_RUN_TAG]: "@acme/other" },
    },
  });
  const payload = sent[0].frame.payload as Record<string, unknown>;
  assertEquals(
    (payload.runtimeTags as Record<string, string>)[APP_RUN_TAG],
    "@acme/cost",
  );
});

Deno.test("AppBroker: events stream until a terminal frame", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: [],
    run: ["@acme/nightly"],
  });
  await post({
    type: "workflow.run",
    id: "a",
    payload: { workflowIdOrName: "@acme/nightly" },
  });
  const id = sent[0].frame.id;
  sent[0].onFrame({ type: "event", id, event: { kind: "started" } });
  sent[0].onFrame({ type: "event", id, event: { kind: "completed" } });
  sent[0].onFrame({ type: "done", id });
  await drain();
  assertEquals(framesFor("a").map((frame) => frame.type), [
    "event",
    "event",
    "done",
  ]);
});

Deno.test("AppBroker: an attach keeps streaming past run.attached", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  });
  await post({ type: "run.attach", id: "a", payload: { runId: "r1" } });
  const id = sent[0].frame.id;
  sent[0].onFrame({
    type: "run.attached",
    id,
    payload: { runId: "r1", kind: "workflow-run", startedAt: "t" },
  });
  sent[0].onFrame({ type: "event", id, event: { kind: "job_started" } });
  sent[0].onFrame({ type: "done", id });
  await drain();
  assertEquals(framesFor("a").map((frame) => frame.type), [
    "run.attached",
    "event",
    "done",
  ]);
});

Deno.test("AppBroker: a data subscription stays open across pages until cancelled", async () => {
  const { sent, post, framesFor } = setup({
    capabilities: ["data:read"],
    run: [],
  });
  await post({
    type: "data.subscribe",
    id: "s",
    payload: { behaviors: ["board"] },
  });
  const id = sent[0].frame.id;
  const page = (cursor: number) => ({
    type: "data.subscribe",
    id,
    payload: { changes: [], cursor, head: cursor, done: false },
  });
  sent[0].onFrame(page(1));
  sent[0].onFrame(page(2));
  await drain();
  assertEquals(framesFor("s").length, 2);
  await post({ type: "cancel", id: "s" });
  assertEquals(sent.at(-1)?.frame, { type: "cancel", id });
  sent[0].onFrame(page(3));
  await drain();
  assertEquals(framesFor("s").map((frame) => frame.type), [
    "data.subscribe",
    "data.subscribe",
    "error",
  ]);
});

Deno.test("AppBroker: a data subscription needs data:read", async () => {
  const { sent, post, framesFor } = setup({ capabilities: [], run: [] });
  await post({ type: "data.subscribe", id: "s", payload: {} });
  assertEquals(sent.length, 0);
  assertEquals(framesFor("s")[0].type, "error");
});

Deno.test("AppBroker: attaching to a run needs runs:read", async () => {
  const { sent, post, framesFor } = setup({ capabilities: [], run: [] });
  await post({ type: "run.attach", id: "a", payload: { runId: "r1" } });
  assertEquals(sent.length, 0);
  assertEquals(framesFor("a")[0].type, "error");
});

Deno.test("AppBroker: large reads go through the HTTP route", async () => {
  const calls: string[] = [];
  const { sent, post, framesFor } = setup(
    { capabilities: ["data:read"], run: [] },
    {
      isHttpRead: () => true,
      request: (type) => {
        calls.push(type);
        return Promise.resolve({ data: 1 });
      },
    },
  );
  await post({ type: "data.get", id: "a" });
  await drain();
  assertEquals(calls, ["data.get"]);
  assertEquals(sent.length, 0);
  assertEquals(framesFor("a")[0].payload, { data: 1 });
});

Deno.test("AppBroker: a lost socket fails what is in flight", async () => {
  const { broker, post, framesFor } = setup({
    capabilities: ["runs:read"],
    run: [],
  });
  await post({ type: "workflow.run.search", id: "a" });
  broker.setConnected(false);
  await drain();
  assertEquals(framesFor("a")[0].error?.code, "disconnected");
});

Deno.test("AppBroker: health needs its capability", async () => {
  let subscribed = 0;
  const { app } = setup({ capabilities: [], run: [] }, {
    subscribeHealth: () => {
      subscribed++;
      return () => {};
    },
  });
  app.postMessage({ kind: "health-subscribe" });
  await drain();
  assertEquals(subscribed, 0);
});

Deno.test("AppBroker: subscribes to health once and stops on close", async () => {
  let open = 0;
  const { app, broker } = setup({ capabilities: ["health:read"], run: [] }, {
    subscribeHealth: () => {
      open++;
      return () => {
        open--;
      };
    },
  });
  app.postMessage({ kind: "health-subscribe" });
  app.postMessage({ kind: "health-subscribe" });
  await drain();
  assertEquals(open, 1);
  broker.close();
  assertEquals(open, 0);
});

Deno.test("AppBroker: a method's inputs always stay data", async () => {
  const { sent, post } = setup({
    capabilities: [],
    run: [],
    methods: [{ behavior: "plan", type: "@acme/plan", methods: ["setMeta"] }],
  });
  await post({
    type: "model.method.run",
    id: "a",
    payload: {
      modelIdOrName: "plan",
      methodName: "setMeta",
      inputs: { title: "${{ vault.get('x', 'y') }}" },
      literalInputs: false,
      lastEvaluated: true,
      lockHolderTokens: "stolen",
      skipAllChecks: true,
      expectedType: "command/shell",
    },
  });
  assertEquals(sent[0].frame.payload, {
    modelIdOrName: "plan",
    methodName: "setMeta",
    literalInputs: true,
    expectedType: "@acme/plan",
    inputs: { title: "${{ vault.get('x', 'y') }}" },
    runtimeTags: { [APP_RUN_TAG]: "@acme/cost" },
  });
});
