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
import { appBridgeConformanceSuite } from "../testing/app_bridge_conformance.ts";
import { APP_READY_MESSAGE } from "./bridge.ts";
import { connectApp, createAppConnector } from "./connect.ts";
import { createMockHost } from "./mock_host.ts";

appBridgeConformanceSuite({
  name: "mock host",
  start: (grant, responses) =>
    createMockHost({
      app: {
        capabilities: grant.capabilities,
        run: grant.run,
        methods: grant.methods ?? [],
      },
      responses,
    }).port,
});

Deno.test("connectApp: a SwampClient runs over the mock host", async () => {
  const host = createMockHost({
    app: { capabilities: ["runs:read"] },
    responses: { "workflow.run.search": { data: { total: 7 } } },
  });
  const { client, session } = await connectApp({}, host.port);
  assertEquals(session.app.capabilities, ["runs:read"]);
  assertEquals(await client.request("workflow.run.search"), {
    data: { total: 7 },
  });
});

Deno.test("connectApp: a refused request rejects with the host's reason", async () => {
  const host = createMockHost();
  const { client } = await connectApp({}, host.port);
  let message = "";
  await client.request("data.query").catch((error: Error) => {
    message = error.message;
  });
  assertEquals(message, "This app has no capability that allows data.query.");
});

Deno.test("connectApp: theme and health reach their listeners", async () => {
  const host = createMockHost();
  const themes: string[] = [];
  const snapshots: unknown[] = [];
  await connectApp({
    onTheme: (theme) => themes.push(theme.mode),
    onHealth: (snapshot) => snapshots.push(snapshot),
  }, host.port);
  host.sendTheme({ mode: "dark", tokens: {} });
  host.sendHealth({ activeRuns: [] });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assertEquals(themes, ["dark"]);
  assertEquals(snapshots, [{ activeRuns: [] }]);
});

Deno.test("connectApp: two mounts in one window share one port", async () => {
  // StrictMode mounts twice; a second request would lose the first port.
  const posted: unknown[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  Object.defineProperty(globalThis, "parent", {
    value: parent,
    configurable: true,
  });
  try {
    const connect = createAppConnector();
    const first = connect();
    const second = connect();
    assertEquals(first, second);
    await Promise.resolve();
    assertEquals(posted, [APP_READY_MESSAGE]);
    const host = createMockHost();
    const event = new MessageEvent("message", { data: "x" });
    Object.defineProperty(event, "source", { value: parent });
    Object.defineProperty(event, "ports", { value: [host.port] });
    globalThis.dispatchEvent(event);
    assertEquals((await first).session.app.name, "@mock/app");
  } finally {
    delete (globalThis as { parent?: unknown }).parent;
  }
});

Deno.test("createMockHost: plays a scripted run to its end", async () => {
  const host = createMockHost({
    app: { run: ["nightly"] },
    streams: {
      "workflow.run": [
        { kind: "started", runId: "r1", workflowName: "nightly" },
        { kind: "job_started", jobId: "build" },
        {
          kind: "completed",
          run: {
            id: "r1",
            workflowId: "w",
            workflowName: "nightly",
            status: "succeeded",
            jobs: [],
          },
        },
      ],
    },
  });
  const { client } = await connectApp({}, host.port);
  const kinds: string[] = [];
  for await (
    const event of client.workflowRunStream({ workflowIdOrName: "nightly" })
  ) {
    kinds.push(event.kind);
  }
  assertEquals(kinds, ["started", "job_started", "completed"]);
});

Deno.test("createMockHost: a stream still keeps the app's capabilities", async () => {
  const host = createMockHost({
    streams: { "workflow.run": [{ kind: "started" }] },
  });
  const { client } = await connectApp({}, host.port);
  const stream = client.workflowRunStream({ workflowIdOrName: "nightly" });
  let refused = "";
  try {
    await stream.next();
  } catch (error) {
    refused = (error as { code?: string }).code ?? "";
  }
  assertEquals(refused, "app_capability_denied");
});
