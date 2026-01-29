import { assertEquals } from "@std/assert";
import {
  extractDependencies,
  extractModelRefs,
  extractResourceDependencies,
  hasResourceDependency,
  hasSelfReference,
} from "./dependency_extractor.ts";

Deno.test("extractDependencies finds input dependencies", () => {
  const deps = extractDependencies("model.source.input.attributes.x");
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "source");
  assertEquals(deps[0].type, "input");
});

Deno.test("extractDependencies finds resource dependencies", () => {
  const deps = extractDependencies("model.source.resource.attributes.id");
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "source");
  assertEquals(deps[0].type, "resource");
});

Deno.test("extractDependencies finds multiple dependencies", () => {
  const expr = "model.a.input.x + model.b.resource.y";
  const deps = extractDependencies(expr);
  assertEquals(deps.length, 2);
  assertEquals(deps[0].modelRef, "a");
  assertEquals(deps[0].type, "input");
  assertEquals(deps[1].modelRef, "b");
  assertEquals(deps[1].type, "resource");
});

Deno.test("extractDependencies deduplicates same reference", () => {
  const expr = "model.foo.input.x + model.foo.input.y";
  const deps = extractDependencies(expr);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "foo");
});

Deno.test("extractDependencies handles model names with hyphens", () => {
  const deps = extractDependencies("model.my-model.input.attributes.x");
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "my-model");
});

Deno.test("extractDependencies handles model names with underscores", () => {
  const deps = extractDependencies("model.my_model.input.attributes.x");
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "my_model");
});

Deno.test("extractModelRefs returns unique model references", () => {
  const expr = "model.a.input.x + model.b.resource.y + model.a.resource.z";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs.includes("a"), true);
  assertEquals(refs.includes("b"), true);
});

Deno.test("extractModelRefs returns empty array for no refs", () => {
  const refs = extractModelRefs("self.name + self.version");
  assertEquals(refs.length, 0);
});

Deno.test("hasResourceDependency returns true for resource refs", () => {
  assertEquals(
    hasResourceDependency("model.foo.resource.attributes.id"),
    true,
  );
});

Deno.test("hasResourceDependency returns false for input refs only", () => {
  assertEquals(
    hasResourceDependency("model.foo.input.attributes.name"),
    false,
  );
});

Deno.test("hasResourceDependency returns false for self refs", () => {
  assertEquals(hasResourceDependency("self.name"), false);
});

Deno.test("extractResourceDependencies returns only resource refs", () => {
  const expr = "model.a.input.x + model.b.resource.y + model.c.resource.z";
  const refs = extractResourceDependencies(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs.includes("b"), true);
  assertEquals(refs.includes("c"), true);
  assertEquals(refs.includes("a"), false);
});

Deno.test("hasSelfReference returns true for self expressions", () => {
  assertEquals(hasSelfReference("self.name"), true);
  assertEquals(
    hasSelfReference('self.name + " v" + string(self.version)'),
    true,
  );
});

Deno.test("hasSelfReference returns false without self", () => {
  assertEquals(hasSelfReference("model.foo.input.x"), false);
  assertEquals(hasSelfReference("myself.name"), false); // 'self' must be word boundary
});
