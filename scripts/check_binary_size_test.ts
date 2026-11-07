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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";
import {
  checkBinarySize,
  LIMITS_FILE,
  parseBinaryArgs,
  parseLimits,
} from "./check_binary_size.ts";

const repo = dirname(dirname(fromFileUrl(import.meta.url)));
const limits = { "x86_64-unknown-linux-gnu": 300 };

Deno.test("checkBinarySize: passes under and exactly at the limit", () => {
  const target = "x86_64-unknown-linux-gnu";
  assertEquals(checkBinarySize(target, 299_000_000, limits), undefined);
  assertEquals(checkBinarySize(target, 300_000_000, limits), undefined);
});

Deno.test("checkBinarySize: over the limit names the overage and the way through", () => {
  const failure = checkBinarySize(
    "x86_64-unknown-linux-gnu",
    323_600_000,
    limits,
  );
  assertStringIncludes(failure ?? "", "323.6 MB");
  assertStringIncludes(failure ?? "", "over its 300 MB limit by 23.6 MB");
  assertStringIncludes(failure ?? "", LIMITS_FILE);
  assertStringIncludes(failure ?? "", "If the increase is intended");
});

Deno.test("checkBinarySize: a target without a limit fails", () => {
  const failure = checkBinarySize("riscv64-unknown-linux-gnu", 1, limits);
  assertStringIncludes(failure ?? "", "no size limit");
});

Deno.test("parseBinaryArgs: a bare path uses the host target", () => {
  assertEquals(parseBinaryArgs(["swamp"], "host-target"), [
    { target: "host-target", path: "swamp" },
  ]);
});

Deno.test("parseBinaryArgs: target=path names the target", () => {
  assertEquals(parseBinaryArgs(["a-target=dist/a"], "host-target"), [
    { target: "a-target", path: "dist/a" },
  ]);
});

Deno.test("parseLimits: refuses a malformed limits file", () => {
  assertThrows(() => parseLimits("not json"));
  assertThrows(() => parseLimits("null"), Error, "maxMegabytes");
  assertThrows(() => parseLimits("{}"), Error, "maxMegabytes");
  assertThrows(
    () => parseLimits(`{"maxMegabytes":{"a":"300"}}`),
    Error,
    "invalid limit for a",
  );
  assertThrows(
    () => parseLimits(`{"maxMegabytes":{"a":0}}`),
    Error,
    "invalid limit for a",
  );
});

Deno.test("binary_size_limits.json: has a limit for every release target", async () => {
  const release = await Deno.readTextFile(
    join(repo, ".github/workflows/release.yml"),
  );
  const releaseTargets = [...release.matchAll(/--target (\S+)/g)]
    .map((match) => match[1]).sort();
  assertEquals(releaseTargets.length, 5);
  const limitsFile = parseLimits(
    await Deno.readTextFile(join(repo, LIMITS_FILE)),
  );
  assertEquals(Object.keys(limitsFile).sort(), releaseTargets);
});

Deno.test("verify-build: checks the size of the binary it compiled", async () => {
  const workflow = parse(
    await Deno.readTextFile(
      join(repo, "verification/workflow-verify-build.yaml"),
    ),
  ) as {
    jobs: {
      name: string;
      steps: {
        name: string;
        task: { inputs: { run: string } };
        dependsOn?: { step: string }[];
      }[];
    }[];
  };
  const compile = workflow.jobs.find((job) => job.name === "compile");
  const step = compile?.steps.find((s) => s.name === "binary-size");
  assertEquals(step?.task.inputs.run, "deno task check-binary-size swamp");
  assertEquals(step?.dependsOn?.[0].step, "binary-check");
});
