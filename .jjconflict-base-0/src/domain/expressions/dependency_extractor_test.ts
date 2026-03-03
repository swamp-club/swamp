// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  extractArtifactDependencies,
  extractDataFunctionDependencies,
  extractDependencies,
  extractFileContentsDependencies,
  extractModelRefs,
  extractResourceDependencies,
  hasDataFunctionDependency,
  hasExecutionDependency,
  hasFileContentsDependency,
  hasResourceDependency,
  hasSelfReference,
  hasStepOutputDependency,
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

// Tests for data function dependency extraction

Deno.test("extractModelRefs includes model refs from data.version calls", () => {
  const expr = "data.version('my-model', 'result', 1).attributes.value";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractModelRefs includes model refs from data.latest calls", () => {
  const expr = "data.latest('my-model', 'output').attributes.id";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractModelRefs includes model refs from data.listVersions calls", () => {
  const expr = "data.listVersions('my-model', 'log')";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractModelRefs includes both model.X and data function refs", () => {
  const expr =
    "model.source.input.x + data.version('target', 'result', 1).value";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs.includes("source"), true);
  assertEquals(refs.includes("target"), true);
});

Deno.test("extractArtifactDependencies includes data function calls", () => {
  const expr = "data.latest('my-model', 'output').attributes.id";
  const deps = extractArtifactDependencies(expr);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "my-model");
  assertEquals(deps[0].type, "data");
});

Deno.test("extractArtifactDependencies combines model.X.resource and data functions", () => {
  const expr =
    "model.a.resource.result.attributes.value + data.version('b', 'output', 1).value";
  const deps = extractArtifactDependencies(expr);
  assertEquals(deps.length, 2);
  assertEquals(
    deps.some((d) => d.modelRef === "a" && d.type === "resource"),
    true,
  );
  assertEquals(deps.some((d) => d.modelRef === "b" && d.type === "data"), true);
});

Deno.test("extractDataFunctionDependencies returns model refs from data functions", () => {
  const expr =
    "data.version('model-a', 'data', 1) + data.latest('model-b', 'output')";
  const refs = extractDataFunctionDependencies(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs.includes("model-a"), true);
  assertEquals(refs.includes("model-b"), true);
});

Deno.test("extractDataFunctionDependencies returns empty for no data functions", () => {
  const expr = "model.foo.input.x + self.name";
  const refs = extractDataFunctionDependencies(expr);
  assertEquals(refs.length, 0);
});

Deno.test("hasDataFunctionDependency returns true for data.version", () => {
  assertEquals(
    hasDataFunctionDependency("data.version('model', 'data', 1)"),
    true,
  );
});

Deno.test("hasDataFunctionDependency returns true for data.latest", () => {
  assertEquals(hasDataFunctionDependency("data.latest('model', 'data')"), true);
});

Deno.test("hasDataFunctionDependency returns true for data.listVersions", () => {
  assertEquals(
    hasDataFunctionDependency("data.listVersions('model', 'data')"),
    true,
  );
});

Deno.test("hasDataFunctionDependency returns false for other expressions", () => {
  assertEquals(hasDataFunctionDependency("model.foo.data.bar"), false);
  assertEquals(hasDataFunctionDependency("self.name"), false);
});

// Tests for file.contents() dependency extraction

Deno.test("extractModelRefs extracts model name from file.contents()", () => {
  const expr = "file.contents('my-model', 'report')";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractArtifactDependencies returns file dep for file.contents()", () => {
  const expr = "file.contents('my-model', 'report')";
  const deps = extractArtifactDependencies(expr);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "my-model");
  assertEquals(deps[0].type, "file");
});

Deno.test("extractFileContentsDependencies returns model name", () => {
  const expr = "file.contents('my-model', 'report')";
  const refs = extractFileContentsDependencies(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractFileContentsDependencies returns empty for no file.contents()", () => {
  const expr = "model.foo.input.x + self.name";
  const refs = extractFileContentsDependencies(expr);
  assertEquals(refs.length, 0);
});

Deno.test("hasFileContentsDependency returns true for file.contents()", () => {
  assertEquals(
    hasFileContentsDependency("file.contents('model', 'spec')"),
    true,
  );
});

Deno.test("hasFileContentsDependency returns false for other expressions", () => {
  assertEquals(hasFileContentsDependency("model.foo.file.bar"), false);
  assertEquals(hasFileContentsDependency("self.name"), false);
});

Deno.test("extractModelRefs includes both model.X and file.contents() refs", () => {
  const expr =
    "model.source.resource.result.attributes.x + file.contents('target', 'report')";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs.includes("source"), true);
  assertEquals(refs.includes("target"), true);
});

// Tests for hasExecutionDependency

Deno.test("hasExecutionDependency returns true for execution refs", () => {
  assertEquals(
    hasExecutionDependency("model.foo.execution.status"),
    true,
  );
});

Deno.test("hasExecutionDependency returns true for hyphenated model name", () => {
  assertEquals(
    hasExecutionDependency("model.my-model.execution.exitCode"),
    true,
  );
});

Deno.test("hasExecutionDependency returns false for resource refs", () => {
  assertEquals(
    hasExecutionDependency("model.foo.resource.attributes.id"),
    false,
  );
});

Deno.test("hasExecutionDependency returns false for input refs", () => {
  assertEquals(
    hasExecutionDependency("model.foo.input.attributes.name"),
    false,
  );
});

// Tests for hasStepOutputDependency

Deno.test("hasStepOutputDependency returns true for resource refs", () => {
  assertEquals(
    hasStepOutputDependency("model.foo.resource.result.attributes.id"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns true for file refs", () => {
  assertEquals(
    hasStepOutputDependency("model.foo.file.report.path"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns true for execution refs", () => {
  assertEquals(
    hasStepOutputDependency("model.foo.execution.status"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns true for data function calls", () => {
  assertEquals(
    hasStepOutputDependency("data.latest('my-model', 'output').attributes.id"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns true for file.contents calls", () => {
  assertEquals(
    hasStepOutputDependency("file.contents('my-model', 'report')"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns false for input refs only", () => {
  assertEquals(
    hasStepOutputDependency("model.foo.input.attributes.name"),
    false,
  );
});

Deno.test("hasStepOutputDependency returns false for simple inputs ref", () => {
  assertEquals(
    hasStepOutputDependency("inputs.vpc_id"),
    false,
  );
});

// Tests for data.findBySpec() dependency extraction

Deno.test("extractModelRefs includes model refs from data.findBySpec calls", () => {
  const expr = "data.findBySpec('my-model', 'subnet')";
  const refs = extractModelRefs(expr);
  assertEquals(refs.length, 1);
  assertEquals(refs.includes("my-model"), true);
});

Deno.test("extractArtifactDependencies includes data.findBySpec calls", () => {
  const expr = "data.findBySpec('my-model', 'subnet')";
  const deps = extractArtifactDependencies(expr);
  assertEquals(deps.length, 1);
  assertEquals(deps[0].modelRef, "my-model");
  assertEquals(deps[0].type, "data");
});

Deno.test("hasDataFunctionDependency returns true for data.findBySpec", () => {
  assertEquals(
    hasDataFunctionDependency("data.findBySpec('model', 'spec')"),
    true,
  );
});

Deno.test("hasStepOutputDependency returns true for data.findBySpec calls", () => {
  assertEquals(
    hasStepOutputDependency("data.findBySpec('my-model', 'subnet')"),
    true,
  );
});
