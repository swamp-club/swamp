import { assertEquals, assertThrows } from "@std/assert";
import { ModelData } from "./model_data.ts";

Deno.test("ModelData.create generates UUID if not provided", () => {
  const data = ModelData.create({});
  assertEquals(typeof data.id, "string");
  assertEquals(data.id.length, 36);
});

Deno.test("ModelData.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const data = ModelData.create({ id });
  assertEquals(data.id, id);
});

Deno.test("ModelData.create sets default version to 1", () => {
  const data = ModelData.create({});
  assertEquals(data.version, 1);
});

Deno.test("ModelData.create uses provided version", () => {
  const data = ModelData.create({ version: 3 });
  assertEquals(data.version, 3);
});

Deno.test("ModelData.create sets createdAt to now if not provided", () => {
  const before = new Date();
  const data = ModelData.create({});
  const after = new Date();

  assertEquals(data.createdAt >= before, true);
  assertEquals(data.createdAt <= after, true);
});

Deno.test("ModelData.create uses provided createdAt", () => {
  const createdAt = new Date("2023-01-01T00:00:00Z");
  const data = ModelData.create({ createdAt });
  assertEquals(data.createdAt, createdAt);
});

Deno.test("ModelData.create sets empty attributes by default", () => {
  const data = ModelData.create({});
  assertEquals(data.attributes, {});
});

Deno.test("ModelData.create uses provided attributes", () => {
  const attributes = { test: "value", count: 42 };
  const data = ModelData.create({ attributes });
  assertEquals(data.attributes, attributes);
});

Deno.test("ModelData.create throws on invalid version", () => {
  assertThrows(
    () => ModelData.create({ version: 0 }),
    Error,
    "Too small: expected number to be >0",
  );
});

Deno.test("ModelData toData/fromData roundtrip", () => {
  const data = ModelData.create({
    attributes: { key: "value", nested: { foo: "bar" } },
  });
  const serialized = data.toData();
  const restored = ModelData.fromData(serialized);

  assertEquals(restored.id, data.id);
  assertEquals(restored.version, data.version);
  assertEquals(restored.createdAt.getTime(), data.createdAt.getTime());
  assertEquals(restored.attributes, data.attributes);
});

Deno.test("ModelData fromData with explicit data", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const createdAt = "2023-01-01T00:00:00.000Z";
  const attributes = { key: "value", items: [1, 2, 3] };

  const serialized = {
    id,
    version: 2,
    createdAt,
    attributes,
  };

  const data = ModelData.fromData(serialized);
  assertEquals(data.id, id);
  assertEquals(data.version, 2);
  assertEquals(data.createdAt, new Date(createdAt));
  assertEquals(data.attributes, attributes);
});

Deno.test("ModelData setAttribute", () => {
  const data = ModelData.create({});
  data.setAttribute("test", "value");
  assertEquals(data.attributes.test, "value");
});

Deno.test("ModelData attributes are immutable via getter", () => {
  const data = ModelData.create({ attributes: { original: "value" } });
  const attrs = data.attributes;
  attrs.modified = "should not affect original";

  assertEquals(data.attributes.modified, undefined);
  assertEquals(data.attributes.original, "value");
});
