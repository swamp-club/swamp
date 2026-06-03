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

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { createModelTestContext } from "./test_context.ts";

Deno.test("createModelTestContext: returns context with default values", () => {
  const { context } = createModelTestContext();

  assertEquals(context.globalArgs, {});
  assertEquals(context.methodName, "run");
  assertEquals(context.repoDir, "/tmp/swamp-test");
  assertEquals(context.definition.name, "test-instance");
  assertEquals(context.definition.version, 1);
  assertEquals(context.definition.tags, {});
  assertExists(context.definition.id);
  assertExists(context.signal);
  assertExists(context.logger);
  assertExists(context.writeResource);
  assertExists(context.readResource);
  assertExists(context.createFileWriter);
  assertExists(context.createCelEnvironment);
});

Deno.test("createModelTestContext: createCelEnvironment returns a working Environment", () => {
  const { context } = createModelTestContext();
  const env = context.createCelEnvironment();

  // Baseline arithmetic overloads work (double + int).
  assertEquals(env.evaluate("a + 2", { a: 1.5 }), 3.5);

  // Custom function registration works.
  env.registerFunction("triple(int): int", (x: bigint) => x * 3n);
  assertEquals(env.evaluate("triple(7)"), 21n);

  // Compile-once-evaluate-many pattern.
  const predicate = env.parse('name == "web"');
  assertEquals(predicate({ name: "web" }), true);
  assertEquals(predicate({ name: "db" }), false);
});

Deno.test("createModelTestContext: each createCelEnvironment call yields a fresh Environment", () => {
  const { context } = createModelTestContext();
  const first = context.createCelEnvironment();
  first.registerFunction("only_on_first(): bool", () => true);

  const second = context.createCelEnvironment();
  assertThrows(() => second.evaluate("only_on_first()"), Error);
});

Deno.test("createModelTestContext: accepts custom options", () => {
  const { context } = createModelTestContext({
    globalArgs: { region: "us-east-1" },
    definition: { name: "prod-instance", version: 3 },
    methodName: "create",
    repoDir: "/custom/path",
  });

  assertEquals(context.globalArgs, { region: "us-east-1" });
  assertEquals(context.methodName, "create");
  assertEquals(context.repoDir, "/custom/path");
  assertEquals(context.definition.name, "prod-instance");
  assertEquals(context.definition.version, 3);
});

Deno.test("createModelTestContext: writeResource captures data and returns handle", async () => {
  const { context, getWrittenResources } = createModelTestContext();

  const handle = await context.writeResource("state", "main", {
    status: "running",
  });

  assertEquals(handle.specName, "state");
  assertEquals(handle.name, "main");
  assertEquals(handle.kind, "resource");
  assertEquals(handle.version, 1);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "state");
  assertEquals(resources[0].name, "main");
  assertEquals(resources[0].data, { status: "running" });
  assertEquals(resources[0].handle, handle);
});

Deno.test("createModelTestContext: multiple writeResource calls accumulate", async () => {
  const { context, getWrittenResources } = createModelTestContext();

  await context.writeResource("state", "a", { id: "1" });
  await context.writeResource("state", "b", { id: "2" });

  assertEquals(getWrittenResources().length, 2);
});

Deno.test("createModelTestContext: readResource returns null by default", async () => {
  const { context } = createModelTestContext();

  const result = await context.readResource("nonexistent");
  assertEquals(result, null);
});

Deno.test("createModelTestContext: readResource returns seeded data", async () => {
  const { context } = createModelTestContext({
    storedResources: {
      "main": { instanceId: "i-abc123", status: "running" },
    },
  });

  const result = await context.readResource("main");
  assertEquals(result, { instanceId: "i-abc123", status: "running" });
});

Deno.test("createModelTestContext: readResource returns clone of seeded data", async () => {
  const original = { status: "running" };
  const { context } = createModelTestContext({
    storedResources: { "main": original },
  });

  const result = await context.readResource("main");
  assertEquals(result, original);
  // Mutating the result should not affect subsequent reads
  result!.status = "stopped";
  const result2 = await context.readResource("main");
  assertEquals(result2!.status, "running");
});

Deno.test("createModelTestContext: writeResource makes data available to readResource", async () => {
  const { context } = createModelTestContext();

  await context.writeResource("state", "main", { status: "created" });
  const result = await context.readResource("main");
  assertEquals(result, { status: "created" });
});

Deno.test("createModelTestContext: createFileWriter writeText captures content", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("log", "output");
  await writer.writeText("hello world");

  const files = getWrittenFiles();
  assertEquals(files.length, 1);
  assertEquals(files[0].specName, "log");
  assertEquals(files[0].name, "output");
  assertEquals(new TextDecoder().decode(files[0].content), "hello world");
  assertEquals(files[0].handle.kind, "file");
});

Deno.test("createModelTestContext: createFileWriter writeAll captures binary", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("binary", "data");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await writer.writeAll(bytes);

  const files = getWrittenFiles();
  assertEquals(files.length, 1);
  assertEquals(files[0].content, bytes);
});

Deno.test("createModelTestContext: createFileWriter writeLine + finalize", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("log", "lines");
  await writer.writeLine("line 1");
  await writer.writeLine("line 2");
  await writer.finalize();

  const files = getWrittenFiles();
  assertEquals(files.length, 1);
  assertEquals(new TextDecoder().decode(files[0].content), "line 1\nline 2");
});

Deno.test("createModelTestContext: createFileWriter getFilePath returns temp path", async () => {
  const { context } = createModelTestContext();

  const writer = context.createFileWriter("log", "output");
  const path = await writer.getFilePath();
  assertEquals(typeof path, "string");
  assertEquals(path.startsWith("/tmp/swamp-test/"), true);
});

Deno.test("createModelTestContext: logger captures log entries", () => {
  const { context, getLogs, getLogsByLevel } = createModelTestContext();

  context.logger.debug("debug msg");
  context.logger.info("info msg");
  context.logger.warn("warn msg");
  context.logger.error("error msg");

  assertEquals(getLogs().length, 4);
  assertEquals(getLogs()[0], {
    level: "debug",
    message: "debug msg",
    args: [],
  });
  assertEquals(getLogs()[1], { level: "info", message: "info msg", args: [] });
  assertEquals(getLogs()[2], {
    level: "warning",
    message: "warn msg",
    args: [],
  });
  assertEquals(getLogs()[3], {
    level: "error",
    message: "error msg",
    args: [],
  });

  assertEquals(getLogsByLevel("info").length, 1);
  assertEquals(getLogsByLevel("warning").length, 1);
});

Deno.test("createModelTestContext: logger captures extra args", () => {
  const { context, getLogs } = createModelTestContext();

  context.logger.info("details", { key: "value" }, 42);

  assertEquals(getLogs()[0].args, [{ key: "value" }, 42]);
});

Deno.test("createModelTestContext: inspection helpers return copies", async () => {
  const { context, getWrittenResources, getLogs } = createModelTestContext();

  await context.writeResource("state", "main", { x: 1 });
  context.logger.info("test");

  const resources1 = getWrittenResources();
  const resources2 = getWrittenResources();
  assertEquals(resources1, resources2);
  // They should be different array instances
  resources1.push(resources1[0]);
  assertEquals(getWrittenResources().length, 1);

  const logs1 = getLogs();
  logs1.push(logs1[0]);
  assertEquals(getLogs().length, 1);
});

Deno.test("createModelTestContext: custom abort signal", () => {
  const controller = new AbortController();
  const { context } = createModelTestContext({ signal: controller.signal });

  assertEquals(context.signal.aborted, false);
  controller.abort();
  assertEquals(context.signal.aborted, true);
});

Deno.test("createModelTestContext: each handle gets unique dataId", async () => {
  const { context, getWrittenResources, getWrittenFiles } =
    createModelTestContext();

  await context.writeResource("state", "a", { x: 1 });
  await context.writeResource("state", "b", { x: 2 });
  const writer = context.createFileWriter("log", "c");
  await writer.writeText("test");

  const ids = [
    ...getWrittenResources().map((r) => r.handle.dataId),
    ...getWrittenFiles().map((f) => f.handle.dataId),
  ];
  const unique = new Set(ids);
  assertEquals(unique.size, ids.length);
});

Deno.test("createModelTestContext: resource handle includes metadata", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    definition: { name: "my-instance" },
    methodName: "create",
  });

  await context.writeResource("state", "main", { status: "ok" });

  const handle = getWrittenResources()[0].handle;
  assertEquals(handle.metadata.contentType, "application/json");
  assertEquals(handle.metadata.lifetime, "infinite");
  assertEquals(handle.metadata.garbageCollection, 10);
  assertEquals(handle.metadata.streaming, false);
  assertEquals(handle.metadata.ownerDefinition.ownerType, "model-method");
  assertEquals(handle.metadata.ownerDefinition.ownerRef, "my-instance/create");
});

Deno.test("createModelTestContext: file handle includes metadata", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("log", "output");
  await writer.writeText("test");

  const handle = getWrittenFiles()[0].handle;
  assertEquals(handle.metadata.contentType, "application/octet-stream");
  assertEquals(handle.metadata.tags.type, "file");
});

Deno.test("createModelTestContext: onEvent captures emitted events", () => {
  const { context, getEvents } = createModelTestContext();

  context.onEvent!({ type: "output", line: "hello", stream: "stdout" });
  context.onEvent!({ type: "vault-storage", field: "apiKey" });

  const events = getEvents();
  assertEquals(events.length, 2);
  assertEquals(events[0].type, "output");
  assertEquals(events[0].line, "hello");
  assertEquals(events[1].type, "vault-storage");
});

Deno.test("createModelTestContext: onEvent calls user callback too", () => {
  const userEvents: unknown[] = [];
  const { context } = createModelTestContext({
    onEvent: (e) => userEvents.push(e),
  });

  context.onEvent!({ type: "test" });

  assertEquals(userEvents.length, 1);
});

Deno.test("createModelTestContext: createFileWriter dataId matches handle dataId", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("log", "output");
  const handle = await writer.writeText("test");

  assertEquals(handle.dataId, writer.dataId);
  assertEquals(getWrittenFiles()[0].handle.dataId, writer.dataId);
});

Deno.test("createModelTestContext: createFileWriter finalize uses same dataId", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const writer = context.createFileWriter("log", "lines");
  await writer.writeLine("line 1");
  const handle = await writer.finalize();

  assertEquals(handle.dataId, writer.dataId);
  assertEquals(getWrittenFiles()[0].handle.dataId, writer.dataId);
});

Deno.test("createModelTestContext: writeStream consumes stream content", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("important data"));
      controller.close();
    },
  });

  const writer = context.createFileWriter("log", "output");
  await writer.writeStream(stream);

  const files = getWrittenFiles();
  assertEquals(
    new TextDecoder().decode(files[0].content),
    "important data",
  );
});

Deno.test("createModelTestContext: writeStream handles multi-chunk streams", async () => {
  const { context, getWrittenFiles } = createModelTestContext();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk1"));
      controller.enqueue(new TextEncoder().encode("chunk2"));
      controller.close();
    },
  });

  const writer = context.createFileWriter("log", "output");
  const handle = await writer.writeStream(stream);

  assertEquals(handle.dataId, writer.dataId);
  assertEquals(
    new TextDecoder().decode(getWrittenFiles()[0].content),
    "chunk1chunk2",
  );
});

Deno.test("createModelTestContext: readResource throws when version is a string", () => {
  const { context } = createModelTestContext({
    storedResources: { "foo": { val: 42 } },
  });

  assertThrows(
    () =>
      context.readResource(
        "item",
        "foo" as unknown as number,
      ),
    Error,
    'readResource(instanceName, version?) received a string as version: "foo"',
  );
});

Deno.test("createModelTestContext: readResource uses instanceName not specName", async () => {
  const { context } = createModelTestContext();

  await context.writeResource("state", "main", { status: "created" });
  await context.writeResource("config", "settings", { debug: true });

  assertEquals(await context.readResource("main"), { status: "created" });
  assertEquals(await context.readResource("settings"), { debug: true });
  assertEquals(await context.readResource("state"), null);
  assertEquals(await context.readResource("config"), null);
});
