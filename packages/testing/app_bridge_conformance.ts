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
/** The bridge's shapes, restated so this package keeps no sibling imports. */
export interface AppBridgeGrant {
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods?: readonly {
    readonly behavior: string;
    readonly type: string;
    readonly methods: readonly string[];
  }[];
}

interface BridgeFrame {
  readonly type: string;
  readonly id: string;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface HostMessage {
  readonly kind: string;
  readonly frame?: BridgeFrame;
}

export interface AppBridgePort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Starts a host with this grant; the reply is its app-side port. */
export interface AppBridgeConformanceHarness {
  readonly name: string;
  start(
    grant: AppBridgeGrant,
    replies: Readonly<Record<string, unknown>>,
  ): AppBridgePort;
}

interface Session {
  readonly port: AppBridgePort;
  readonly received: HostMessage[];
  send(frame: BridgeFrame): void;
  reply(id: string): Promise<BridgeFrame>;
}

function open(port: AppBridgePort): Session {
  const received: HostMessage[] = [];
  const waiting = new Map<string, (frame: BridgeFrame) => void>();
  port.onmessage = (event) => {
    const message = event.data as HostMessage;
    received.push(message);
    if (message.kind === "frame" && message.frame) {
      waiting.get(message.frame.id)?.(message.frame);
    }
  };
  return {
    port,
    received,
    send: (frame) => port.postMessage({ kind: "frame", frame }),
    reply: (id) => new Promise((resolve) => waiting.set(id, resolve)),
  };
}

/** Rules every host holds to, so a mock host cannot drift from the broker. */
export function appBridgeConformanceSuite(
  harness: AppBridgeConformanceHarness,
): void {
  const test = (name: string, body: () => Promise<void>) =>
    Deno.test(`app bridge conformance (${harness.name}): ${name}`, body);

  test("starts with an init message", async () => {
    const session = open(harness.start({ capabilities: [], run: [] }, {}));
    await Promise.resolve();
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    assertEquals(session.received[0]?.kind, "init");
  });

  test("answers a request its capability allows", async () => {
    const session = open(
      harness.start(
        { capabilities: ["runs:read"], run: [] },
        { "workflow.run.search": { data: { total: 3 } } },
      ),
    );
    const reply = session.reply("a");
    session.send({ type: "workflow.run.search", id: "a" });
    assertEquals((await reply).payload, { data: { total: 3 } });
  });

  test("refuses a request no capability allows", async () => {
    const session = open(
      harness.start({ capabilities: ["runs:read"], run: [] }, {
        "data.query": { data: {} },
      }),
    );
    const reply = session.reply("b");
    session.send({
      type: "data.query",
      id: "b",
      payload: { predicate: "true" },
    });
    const frame = await reply;
    assertEquals(frame.type, "error");
    assertEquals(frame.error?.code, "app_capability_denied");
  });

  for (const type of ["vault.get", "access.grant.list", "app.approve"]) {
    test(`never lets ${type} through`, async () => {
      const session = open(
        harness.start(
          {
            capabilities: [
              "runs:read",
              "data:read",
              "catalog:read",
              "health:read",
              "workers:read",
            ],
            run: [],
          },
          { [type]: { data: {} } },
        ),
      );
      const reply = session.reply("c");
      session.send({ type, id: "c" });
      assertEquals((await reply).error?.code, "app_capability_denied");
    });
  }

  test("starts only the workflows it names", async () => {
    const session = open(
      harness.start({ capabilities: [], run: ["@acme/nightly"] }, {}),
    );
    const reply = session.reply("d");
    session.send({
      type: "workflow.run",
      id: "d",
      payload: { workflowIdOrName: "@acme/other" },
    });
    assertEquals((await reply).error?.code, "app_capability_denied");
  });

  test("ignores a malformed message", async () => {
    const session = open(harness.start({ capabilities: [], run: [] }, {}));
    session.port.postMessage({ kind: "frame", frame: { type: 3 } });
    session.port.postMessage("nonsense");
    const reply = session.reply("e");
    session.send({ type: "data.query", id: "e" });
    assert((await reply).error !== undefined);
  });

  test("runs a method only on a listed behavior", async () => {
    const session = open(harness.start({ capabilities: [], run: [] }, {}));
    const reply = session.reply("f");
    session.send({
      type: "model.method.run",
      id: "f",
      payload: { modelIdOrName: "anything", methodName: "x" },
    });
    assertEquals((await reply).error?.code, "app_capability_denied");
  });

  test("runs only the methods a listed behavior names", async () => {
    const session = open(
      harness.start({
        capabilities: [],
        run: [],
        methods: [{
          behavior: "board",
          type: "@acme/board",
          methods: ["tick"],
        }],
      }, {}),
    );
    const reply = session.reply("g");
    session.send({
      type: "model.method.run",
      id: "g",
      payload: { modelIdOrName: "board", methodName: "delete" },
    });
    assertEquals((await reply).error?.code, "app_capability_denied");
  });
}
