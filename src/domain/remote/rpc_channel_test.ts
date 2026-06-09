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

import { assertEquals, assertRejects } from "@std/assert";
import { RpcChannel, RpcError } from "./rpc_channel.ts";
import type { RpcStreamEvent } from "./protocol.ts";

/**
 * Wire two channels together in memory: everything A sends is fed to B and
 * vice versa, mimicking the two ends of a control socket.
 */
function channelPair(): { a: RpcChannel; b: RpcChannel } {
  // Messages are delivered through a microtask to mimic async transport
  // without ordering surprises.
  const a: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => b.handleRaw(data)),
  });
  const b: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => a.handleRaw(data)),
  });
  return { a, b };
}

Deno.test("RpcChannel: unary call resolves with the handler result", async () => {
  const { a, b } = channelPair();
  b.register("echo", (params) => Promise.resolve({ echoed: params }));
  const result = await a.call<{ echoed: unknown }>("echo", { x: 1 });
  assertEquals(result, { echoed: { x: 1 } });
});

Deno.test("RpcChannel: handler errors surface as RpcError with code", async () => {
  const { a, b } = channelPair();
  b.register("boom", () => Promise.reject(new Error("it broke")));
  const error = await assertRejects(
    () => a.call("boom", {}),
    RpcError,
    "it broke",
  );
  assertEquals(error.code, "handler_failed");
});

Deno.test("RpcChannel: unknown method is an unknown_method error", async () => {
  const { a } = channelPair();
  const error = await assertRejects(
    () => a.call("nope", {}),
    RpcError,
  );
  assertEquals(error.code, "unknown_method");
});

Deno.test("RpcChannel: stream events arrive before the final response", async () => {
  const { a, b } = channelPair();
  b.register("run", async (_params, ctx) => {
    ctx.stream({ kind: "log", line: "one" });
    ctx.stream({ kind: "log", line: "two" });
    return await Promise.resolve({ done: true });
  });
  const events: RpcStreamEvent[] = [];
  const result = await a.call("run", {}, {
    onStream: (event) => events.push(event),
  });
  assertEquals(result, { done: true });
  assertEquals(events.map((e) => e.line), ["one", "two"]);
});

Deno.test("RpcChannel: caller abort cancels the in-flight handler", async () => {
  const { a, b } = channelPair();
  let handlerAborted = false;
  const handlerStarted = Promise.withResolvers<void>();
  b.register("slow", (_params, ctx) => {
    handlerStarted.resolve();
    return new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => {
        handlerAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  const controller = new AbortController();
  const call = a.call("slow", {}, { signal: controller.signal });
  await handlerStarted.promise;
  controller.abort();
  await assertRejects(() => call, DOMException);
  // Give the cancel frame a microtask to reach the handler.
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(handlerAborted, true);
});

Deno.test("RpcChannel: call times out and rejects", async () => {
  const { a, b } = channelPair();
  b.register("never", (_params, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
    }));
  await assertRejects(
    () => a.call("never", {}, { timeoutMs: 20 }),
    DOMException,
    "timed out",
  );
});

Deno.test("RpcChannel: close rejects pending calls and aborts inbound handlers", async () => {
  const { a, b } = channelPair();
  let aborted = false;
  const started = Promise.withResolvers<void>();
  b.register("hang", (_params, ctx) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  const call = a.call("hang", {}, { timeoutMs: null });
  await started.promise;
  a.close("socket dropped");
  await assertRejects(() => call, Error, "socket dropped");
  b.close();
  assertEquals(aborted, true);
  assertEquals(a.closed, true);
});

Deno.test("RpcChannel: handleRaw ignores non-RPC traffic", () => {
  const { a } = channelPair();
  assertEquals(a.handleRaw('{"type":"workflow.run","id":"1"}'), false);
  assertEquals(a.handleRaw("not json"), false);
  assertEquals(
    a.handleRaw('{"type":"rpc.cancel","id":"missing"}'),
    true,
  );
});

Deno.test("RpcChannel: call on a closed channel rejects immediately", async () => {
  const { a } = channelPair();
  a.close();
  await assertRejects(() => a.call("anything", {}), Error, "closed");
});

Deno.test("RpcChannel: duplicate inbound request id is rejected", async () => {
  const received: string[] = [];
  const b: RpcChannel = new RpcChannel({
    send: (data) => void received.push(data),
  });
  const gate = Promise.withResolvers<void>();
  b.register("slow", async () => {
    await gate.promise;
    return "ok";
  });
  const frame = {
    type: "rpc.request",
    id: "dup",
    method: "slow",
    params: {},
  };
  b.handleParsed(frame);
  b.handleParsed(frame);
  // First request is in flight; the second must be rejected as duplicate.
  await new Promise((r) => setTimeout(r, 5));
  const errors = received
    .map((raw) => JSON.parse(raw))
    .filter((f) => f.type === "rpc.error");
  assertEquals(errors.length, 1);
  assertEquals(errors[0].error.code, "duplicate_id");
  gate.resolve();
  await new Promise((r) => setTimeout(r, 5));
});
