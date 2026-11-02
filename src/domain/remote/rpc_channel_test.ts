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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import {
  FRAME_TOO_LARGE,
  MAX_RPC_FRAME_BYTES,
  RpcChannel,
  RpcError,
} from "./rpc_channel.ts";
import type { RpcStreamEvent } from "./protocol.ts";

function channelPair(): { a: RpcChannel; b: RpcChannel } {
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
  await new Promise((r) => setTimeout(r, 5));
  const errors = received
    .map((raw) => JSON.parse(raw))
    .filter((f) => f.type === "rpc.error");
  assertEquals(errors.length, 1);
  assertEquals(errors[0].error.code, "duplicate_id");
  gate.resolve();
  await new Promise((r) => setTimeout(r, 5));
});

Deno.test("RpcChannel: waitForPeerOnCancel stays pending until the handler unwinds", async () => {
  const { a, b } = channelPair();
  const events: string[] = [];
  b.register("slow", (_params, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => {
        setTimeout(() => {
          events.push("handler-unwound");
          reject(new DOMException("aborted", "AbortError"));
        }, 30);
      });
    }));

  const controller = new AbortController();
  const call = a.call("slow", {}, {
    signal: controller.signal,
    timeoutMs: null,
    waitForPeerOnCancel: true,
  });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  const error = await assertRejects(() => call, RpcError);
  events.push("caller-settled");
  assertEquals(events, ["handler-unwound", "caller-settled"]);
  assertEquals(error.code, "cancelled");
});

Deno.test("RpcChannel: cancelled handlers always emit a terminal frame", async () => {
  const sent: string[] = [];
  const b: RpcChannel = new RpcChannel({
    send: (data) => void sent.push(data),
  });
  b.register("slow", (_params, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
    }));
  b.handleParsed({ type: "rpc.request", id: "x", method: "slow", params: {} });
  b.handleParsed({ type: "rpc.cancel", id: "x" });
  await new Promise((r) => setTimeout(r, 10));
  const frames = sent.map((raw) => JSON.parse(raw));
  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, "rpc.error");
  assertEquals(frames[0].error.code, "cancelled");
});

Deno.test("RpcChannel: handler context exposes the caller's request id", async () => {
  const { a, b } = channelPair();
  let capturedRequestId: string | undefined;
  b.register("probe", (_params, ctx) => {
    capturedRequestId = ctx.requestId;
    return Promise.resolve({ ok: true });
  });
  await a.call("probe", {});
  assertEquals(typeof capturedRequestId, "string");
  assertEquals(capturedRequestId!.length > 0, true);
});

const SMALL_LIMIT = 512;

function limitedPair(
  maxFrameBytes = SMALL_LIMIT,
): { a: RpcChannel; b: RpcChannel; sentByA: string[]; sentByB: string[] } {
  const sentByA: string[] = [];
  const sentByB: string[] = [];
  const a: RpcChannel = new RpcChannel({
    send: (data) => {
      sentByA.push(data);
      void Promise.resolve().then(() => b.handleRaw(data));
    },
  }, { maxFrameBytes });
  const b: RpcChannel = new RpcChannel({
    send: (data) => {
      sentByB.push(data);
      void Promise.resolve().then(() => a.handleRaw(data));
    },
  }, { maxFrameBytes });
  return { a, b, sentByA, sentByB };
}

function frameTypes(sent: string[]): string[] {
  return sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

async function withCapturedRpcLogs<T>(
  fn: (records: LogRecord[]) => Promise<T>,
): Promise<T> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["remote", "rpc"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
    reset: true,
  });
  try {
    return await fn(records);
  } finally {
    await reset();
  }
}

Deno.test("RpcChannel: the default frame limit is one byte under Deno's 64 MiB WebSocket receive limit", () => {
  assertEquals(MAX_RPC_FRAME_BYTES, 64 * 1024 * 1024 - 1);
});

Deno.test("RpcChannel: an oversize reply reaches the caller as frame_too_large and is never sent", async () => {
  const { a, b, sentByB } = limitedPair();
  b.register("big", () => Promise.resolve("x".repeat(SMALL_LIMIT * 2)));
  const error = await assertRejects(() => a.call("big", {}), RpcError);
  assertEquals(error.code, FRAME_TOO_LARGE);
  assertStringIncludes(error.message, "'big'");
  assertStringIncludes(error.message, `${SMALL_LIMIT} byte`);
  assertStringIncludes(error.message, "the call ran");
  assertEquals(frameTypes(sentByB), ["rpc.error"]);
});

Deno.test("RpcChannel: an oversize request rejects locally and nothing is sent", async () => {
  const { a, b, sentByA } = limitedPair();
  let handled = false;
  b.register("take", () => {
    handled = true;
    return Promise.resolve(null);
  });
  const error = await assertRejects(
    () => a.call("take", { blob: "y".repeat(SMALL_LIMIT * 2) }),
    RpcError,
  );
  assertEquals(error.code, FRAME_TOO_LARGE);
  assertStringIncludes(error.message, "'take'");
  assertStringIncludes(error.message, "was not sent");
  assertEquals(sentByA, []);
  assertEquals(handled, false);
});

Deno.test("RpcChannel: an oversize stream event is dropped and the call still completes", async () => {
  const { a, b } = limitedPair();
  b.register("events", (_params, ctx) => {
    ctx.stream({ kind: "big", data: "z".repeat(SMALL_LIMIT * 2) });
    ctx.stream({ kind: "small" });
    return Promise.resolve("done");
  });
  const kinds: string[] = [];
  const result = await a.call<string>("events", {}, {
    onStream: (event) => kinds.push(event.kind),
  });
  assertEquals(result, "done");
  assertEquals(kinds, ["small"]);
});

Deno.test("RpcChannel: an oversize error reply is replaced by a bare frame_too_large error", async () => {
  const { a, b } = limitedPair();
  b.register("fail", () =>
    Promise.reject(
      new RpcError({
        code: "custom",
        message: "m".repeat(SMALL_LIMIT * 2),
        details: { huge: "d".repeat(SMALL_LIMIT) },
      }),
    ));
  const error = await assertRejects(() => a.call("fail", {}), RpcError);
  assertEquals(error.code, FRAME_TOO_LARGE);
  assertStringIncludes(error.message, "error reply");
  assertEquals(error.details, undefined);
});

Deno.test("RpcChannel: the channel stays usable after a refused frame", async () => {
  const { a, b } = limitedPair();
  b.register("big", () => Promise.resolve("x".repeat(SMALL_LIMIT * 2)));
  b.register("echo", (params) => Promise.resolve(params));
  await assertRejects(() => a.call("big", {}), RpcError);
  assertEquals(a.closed, false);
  assertEquals(b.closed, false);
  assertEquals(await a.call("echo", { ok: true }), { ok: true });
});

Deno.test("RpcChannel: a frame exactly at the limit is sent", async () => {
  const probe = JSON.stringify({ type: "rpc.response", id: "", result: "" });
  const sent: string[] = [];
  const channel = new RpcChannel({ send: (data) => sent.push(data) }, {
    maxFrameBytes: SMALL_LIMIT,
  });
  const id = crypto.randomUUID();
  channel.register(
    "fit",
    () => Promise.resolve("f".repeat(SMALL_LIMIT - probe.length - id.length)),
  );
  channel.handleRaw(JSON.stringify({
    type: "rpc.request",
    id,
    method: "fit",
    params: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(sent.length, 1);
  assertEquals(new TextEncoder().encode(sent[0]).byteLength, SMALL_LIMIT);
  assertEquals(frameTypes(sent), ["rpc.response"]);
});

Deno.test("RpcChannel: a refused frame logs its type, method and size but not its payload", async () => {
  await withCapturedRpcLogs(async (records) => {
    const { a, b } = limitedPair();
    const marker = "SECRET-PAYLOAD-MARKER";
    b.register(
      "big",
      () => Promise.resolve(marker + "x".repeat(SMALL_LIMIT * 2)),
    );
    await assertRejects(() => a.call("big", {}), RpcError);
    const refusal = records.find((r) =>
      r.rawMessage.toString().startsWith("Refused to send RPC")
    );
    assert(refusal, "expected a refusal log line");
    assertEquals(refusal.properties.frameType, "rpc.response");
    assertEquals(refusal.properties.method, "big");
    assertEquals(refusal.properties.limit, SMALL_LIMIT);
    assert((refusal.properties.bytes as number) > SMALL_LIMIT);
    assert(!JSON.stringify(refusal.properties).includes(marker));
  });
});
