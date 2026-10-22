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
import { RpcChannel, RpcError } from "../src/domain/remote/rpc_channel.ts";
import { RemoteMethod } from "../src/domain/remote/protocol.ts";
import { observeExecutionWork } from "../src/domain/remote/observability.ts";
import { bridgeCapabilityVerbs } from "../src/worker/runner_bridge.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";

function pair(): [RpcChannel, RpcChannel] {
  const a: RpcChannel = new RpcChannel({
    send: (raw) => queueMicrotask(() => b.handleRaw(raw)),
  });
  const b: RpcChannel = new RpcChannel({
    send: (raw) => queueMicrotask(() => a.handleRaw(raw)),
  });
  return [a, b];
}

Deno.test("remote waterfall: terminal failures retain server parentage and peer cancellation outcome", async () => {
  for (const failure of ["error", "rpc", "cancel"]) {
    await withCapturedSpans(async (spans) => {
      installExecutionObserver();
      const [caller, server] = pair();
      const controller = new AbortController();
      const ready = Promise.withResolvers<void>();
      server.register(
        "query",
        (_params, ctx) =>
          observeExecutionWork("query.execute", {}, async (observation) => {
            ctx.responseTrace = observation.carrier;
            ready.resolve();
            if (failure === "cancel") {
              await new Promise<void>((_resolve, reject) => {
                ctx.signal.addEventListener(
                  "abort",
                  () => reject(new Error("cancelled")),
                  { once: true },
                );
              });
            }
            if (failure === "rpc") {
              throw new RpcError({ code: "refused", message: "refused" });
            }
            throw new Error("failed");
          }, ctx.trace),
      );
      try {
        const call = caller.call("query", {}, {
          signal: controller.signal,
          waitForPeerOnCancel: true,
        });
        const rejected = assertRejects(() => call, RpcError);
        await ready.promise;
        if (failure === "cancel") controller.abort();
        await rejected;
        const query = findSpan(spans, "swamp.query.execute");
        const reply = spans.find((s) =>
          s.name === "swamp.rpc.submit" &&
          s.attributes["swamp.rpc.frame"] === "rpc.error"
        );
        assert(reply);
        assert(isChildOf(reply, query));
        assertEquals(
          findSpan(spans, "swamp.rpc.client").attributes["swamp.outcome"],
          failure === "cancel" ? "cancelled" : "error",
        );
      } finally {
        caller.close();
        server.close();
        uninstallExecutionObserver();
      }
    });
  }
});

Deno.test("remote waterfall: caller cancellation and late peer completion remain separate", async () => {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    let id = "";
    const channel = new RpcChannel({
      send: (raw) => {
        const frame = JSON.parse(raw) as { type: string; id: string };
        if (frame.type === "rpc.request") id = frame.id;
      },
    });
    const controller = new AbortController();
    try {
      const call = channel.call("query", {}, {
        signal: controller.signal,
        timeoutMs: null,
      });
      const rejected = assertRejects(() => call, DOMException);
      controller.abort();
      await rejected;
      channel.handleParsed({ type: "rpc.response", id, result: [1] });
      const caller = findSpan(spans, "swamp.rpc.client");
      const late = findSpan(spans, "swamp.rpc.late");
      assertEquals(caller.attributes["swamp.outcome"], "cancelled");
      assertEquals(late.attributes["swamp.outcome"], "ok");
      assertEquals(late.attributes["swamp.rpc.correlation"], "retained");
      assert(isChildOf(late, caller));
    } finally {
      channel.close();
      uninstallExecutionObserver();
    }
  });
});

Deno.test("remote waterfall: native RPC parents survive runner bridge request-ID remapping", async () => {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    const [runner, child] = pair();
    const [worker, server] = pair();
    bridgeCapabilityVerbs({
      childChannel: child,
      orchestratorChannel: worker,
      dispatchId: "trusted-dispatch",
      signal: new AbortController().signal,
    });
    server.register(RemoteMethod.queryData, (params, ctx) => {
      assertEquals(
        (params as { dispatchId: string }).dispatchId,
        "trusted-dispatch",
      );
      return observeExecutionWork(
        "query.execute",
        {},
        () => Promise.resolve([42]),
        ctx.trace,
      );
    });
    try {
      await observeExecutionWork("worker.execute", {}, async () => {
        assertEquals(
          await runner.call(RemoteMethod.queryData, {
            dispatchId: "forged",
            predicate: "secret",
          }),
          [42],
        );
      });
      const execution = findSpan(spans, "swamp.worker.execute");
      const bridge = findSpan(spans, "swamp.rpc.server");
      const query = findSpan(spans, "swamp.query.execute");
      const clients = spans.filter((s) => s.name === "swamp.rpc.client");
      assertEquals(clients.length, 2);
      const outer = clients.find((s) => isChildOf(s, execution))!;
      const inner = clients.find((s) => isChildOf(s, bridge))!;
      assert(outer && inner);
      assert(isChildOf(bridge, outer));
      assert(isChildOf(query, inner));
      assertEquals(
        bridge.attributes["swamp.rpc.request_id"],
        outer.attributes["swamp.rpc.request_id"],
      );
      assert(
        outer.attributes["swamp.rpc.request_id"] !==
          inner.attributes["swamp.rpc.request_id"],
      );
      assert(
        !JSON.stringify(spans.map((s) => s.attributes)).includes("secret"),
      );
    } finally {
      for (const channel of [runner, child, worker, server]) channel.close();
      uninstallExecutionObserver();
    }
  });
});
