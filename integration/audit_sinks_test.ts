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

import dgram from "node:dgram";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import {
  type AuditEvent,
  createAuditEvent,
} from "../src/domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../src/domain/serve_audit/audit_sink.ts";
import {
  generateHmacKeyBytes,
  type HmacContext,
  importHmacKey,
} from "../src/domain/serve_audit/audit_hmac.ts";
import { WebhookSink } from "../src/serve/audit_sinks/webhook_sink.ts";
import { SyslogSink } from "../src/serve/audit_sinks/syslog_sink.ts";

function makeEvent(
  overrides?: Partial<Parameters<typeof createAuditEvent>[0]>,
): AuditEvent {
  return createAuditEvent({
    instanceId: "test",
    category: "secrets",
    stage: "response",
    outcome: "success",
    action: "vault.read-secret",
    resourceKind: "vault",
    resourceName: "api-keys",
    principalKind: "user",
    principalId: "paul",
    initiatedBy: "paul",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
    ...overrides,
  });
}

async function makeHmacContext(): Promise<HmacContext> {
  const raw = await generateHmacKeyBytes();
  const key = await importHmacKey(raw);
  return { key, keyVersion: 1 };
}

class CollectorSink implements AuditSink {
  readonly name = "collector";
  readonly durable = false;
  readonly events: AuditEvent[] = [];

  async write(events: readonly AuditEvent[]): Promise<void> {
    this.events.push(...events);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

Deno.test("Integration: HMAC applied through emitter to collector sink", async () => {
  const hmacContext = await makeHmacContext();
  const collector = new CollectorSink();
  const emitter = new AuditEmitter({
    sinks: [collector],
    hmacContext,
  });

  emitter.emit(makeEvent({ resourceName: "my-secret-key" }));
  await emitter.flush();

  assertEquals(collector.events.length, 1);
  const event = collector.events[0];
  assertNotEquals(event.resourceName, "my-secret-key");
  assertEquals(event.resourceName.length, 64);
  assertEquals(event.hmacKeyVersion, 1);
});

Deno.test("Integration: HMAC emitter to webhook sink end-to-end", async () => {
  const received: string[] = [];

  const server = Deno.serve({
    port: 0,
    onListen: () => {},
  }, async (req) => {
    received.push(await req.text());
    return new Response("ok");
  });

  const addr = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${addr.port}/ingest`;

  const hmacContext = await makeHmacContext();
  const webhookSink = new WebhookSink({
    url,
    format: "json",
    batchIntervalMs: 60_000,
  });
  const emitter = new AuditEmitter({
    sinks: [webhookSink],
    hmacContext,
  });

  emitter.emit(makeEvent({ resourceName: "sensitive-resource" }));
  await emitter.flush();
  await emitter.close();

  server.shutdown();
  await server.finished;

  assert(received.length > 0, "Webhook should have received events");
  const events = JSON.parse(received[0]) as AuditEvent[];
  assertEquals(events.length, 1);
  assertNotEquals(events[0].resourceName, "sensitive-resource");
  assertEquals(events[0].resourceName.length, 64);
  assertEquals(events[0].hmacKeyVersion, 1);
});

Deno.test("Integration: filtered events not delivered to webhook sink", async () => {
  const received: string[] = [];

  const server = Deno.serve({
    port: 0,
    onListen: () => {},
  }, async (req) => {
    received.push(await req.text());
    return new Response("ok");
  });

  const addr = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${addr.port}/ingest`;

  const webhookSink = new WebhookSink({
    url,
    filter: { categories: ["auth"] },
    batchIntervalMs: 60_000,
  });
  const collector = new CollectorSink();
  const emitter = new AuditEmitter({
    sinks: [collector, webhookSink],
  });

  emitter.emit(makeEvent({ category: "secrets" }));
  emitter.emit(makeEvent({ category: "auth", action: "auth.login" }));
  await emitter.flush();
  await emitter.close();

  server.shutdown();
  await server.finished;

  assertEquals(collector.events.length, 2);
  assert(received.length > 0, "Webhook should have received the auth event");
  const events = JSON.parse(received[0]) as AuditEvent[];
  assertEquals(events.length, 1);
  assertEquals(events[0].category, "auth");
});

// ── Webhook sink transport tests ─────────────────────────────────────

interface CapturedRequest {
  body: string;
  headers: Record<string, string>;
}

async function startMockServer(): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  let resolveUrl: (url: string) => void;
  const urlPromise = new Promise<string>((r) => resolveUrl = r);
  const server = Deno.serve({
    port: 0,
    onListen: (addr) => {
      resolveUrl!(`http://127.0.0.1:${addr.port}/ingest`);
    },
  }, async (req) => {
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => headers[k] = v);
    requests.push({ body, headers });
    return new Response("ok", { status: 200 });
  });
  const url = await urlPromise;
  return {
    url,
    requests,
    close: async () => {
      server.shutdown();
      await server.finished;
    },
  };
}

Deno.test("WebhookSink: sends JSON batch on flush", async () => {
  const mock = await startMockServer();
  try {
    const sink = new WebhookSink({
      url: mock.url,
      format: "json",
      batchIntervalMs: 60_000,
    });
    await sink.write([makeEvent(), makeEvent()]);
    await sink.flush();
    await sink.close();
    assertEquals(mock.requests.length, 1);
    const parsed = JSON.parse(mock.requests[0].body);
    assertEquals(parsed.length, 2);
    assertEquals(mock.requests[0].headers["content-type"], "application/json");
  } finally {
    await mock.close();
  }
});

Deno.test("WebhookSink: sends CEF format on flush", async () => {
  const mock = await startMockServer();
  try {
    const sink = new WebhookSink({
      url: mock.url,
      format: "cef",
      batchIntervalMs: 60_000,
    });
    await sink.write([makeEvent()]);
    await sink.flush();
    await sink.close();
    assertEquals(mock.requests.length, 1);
    assertStringIncludes(mock.requests[0].body, "CEF:0|SwampClub|");
    assertStringIncludes(
      mock.requests[0].headers["content-type"],
      "text/plain",
    );
  } finally {
    await mock.close();
  }
});

Deno.test("WebhookSink: includes bearer auth header", async () => {
  const mock = await startMockServer();
  try {
    const sink = new WebhookSink({
      url: mock.url,
      auth: { type: "bearer", value: "test-token" },
      batchIntervalMs: 60_000,
    });
    await sink.write([makeEvent()]);
    await sink.flush();
    await sink.close();
    assertEquals(
      mock.requests[0].headers["authorization"],
      "Bearer test-token",
    );
  } finally {
    await mock.close();
  }
});

Deno.test("WebhookSink: batches at configured size", async () => {
  const mock = await startMockServer();
  try {
    const sink = new WebhookSink({
      url: mock.url,
      batchSize: 2,
      batchIntervalMs: 60_000,
    });
    await sink.write([makeEvent(), makeEvent(), makeEvent()]);
    await sink.flush();
    await sink.close();
    assertEquals(mock.requests.length, 2);
    assertEquals(JSON.parse(mock.requests[0].body).length, 2);
    assertEquals(JSON.parse(mock.requests[1].body).length, 1);
  } finally {
    await mock.close();
  }
});

Deno.test("WebhookSink: close flushes remaining events", async () => {
  const mock = await startMockServer();
  try {
    const sink = new WebhookSink({
      url: mock.url,
      batchIntervalMs: 60_000,
    });
    await sink.write([makeEvent()]);
    await sink.close();
    assertEquals(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

// ── Syslog sink transport tests ──────────────────────────────────────

Deno.test("SyslogSink: sends messages to TCP server", async () => {
  const received: string[] = [];
  const listener = Deno.listen({ port: 0 });
  const addr = listener.addr as Deno.NetAddr;
  const serverDone = (async () => {
    const conn = await listener.accept();
    const buf = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        received.push(new TextDecoder().decode(buf.subarray(0, n)));
      }
    } catch {
      // connection closed
    }
    conn.close();
  })();
  const sink = new SyslogSink({
    host: "127.0.0.1",
    port: addr.port,
    transport: "tcp",
  });
  try {
    await sink.write([makeEvent()]);
    await sink.close();
    await serverDone;
    assert(received.length > 0, "Expected at least one message");
    assertStringIncludes(received[0], "vault.read-secret");
  } finally {
    try {
      listener.close();
    } catch { /* already closed */ }
  }
});

Deno.test("SyslogSink: sends messages via UDP", async () => {
  const received: Buffer[] = [];
  const server = dgram.createSocket("udp4");
  const port = await new Promise<number>((resolve) => {
    server.bind(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
  const recvDone = new Promise<void>((resolve) => {
    server.once("message", (msg) => {
      received.push(msg);
      resolve();
    });
  });
  const sink = new SyslogSink({
    host: "127.0.0.1",
    port,
    transport: "udp",
  });
  try {
    await sink.write([makeEvent()]);
    await sink.close();
    await Promise.race([
      recvDone,
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    assert(received.length > 0, "Expected at least one UDP message");
    assertStringIncludes(received[0].toString("utf-8"), "vault.read-secret");
  } finally {
    server.close();
  }
});

Deno.test("SyslogSink: filters events over TCP", async () => {
  const received: string[] = [];
  const listener = Deno.listen({ port: 0 });
  const addr = listener.addr as Deno.NetAddr;
  const serverDone = (async () => {
    const conn = await listener.accept();
    const buf = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        received.push(new TextDecoder().decode(buf.subarray(0, n)));
      }
    } catch {
      // connection closed
    }
    conn.close();
  })();
  const sink = new SyslogSink({
    host: "127.0.0.1",
    port: addr.port,
    transport: "tcp",
    filter: { categories: ["auth"] },
  });
  try {
    await sink.write([
      makeEvent({ category: "secrets" }),
      makeEvent({ category: "auth", action: "auth.login" }),
    ]);
    await sink.close();
    await serverDone;
    assert(received.length > 0, "Expected at least one message");
    const allData = received.join("");
    assertStringIncludes(allData, "auth.login");
    assert(!allData.includes("vault.read-secret"), "Filtered event leaked");
  } finally {
    try {
      listener.close();
    } catch { /* already closed */ }
  }
});
