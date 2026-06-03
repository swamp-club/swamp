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

import { assertEquals } from "@std/assert";
import { rewriteDirectTypeArgs } from "./arg_rewriter.ts";

Deno.test("rewriteDirectTypeArgs: rewrites model @type method run to model method run @type", () => {
  const input = [
    "model",
    "@swamp/cve/dirtyfrag",
    "method",
    "run",
    "scanFleet",
    "scanner",
  ];
  const expected = [
    "model",
    "method",
    "run",
    "@swamp/cve/dirtyfrag",
    "scanFleet",
    "scanner",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});

Deno.test("rewriteDirectTypeArgs: no-op when no @type present", () => {
  const input = ["model", "method", "run", "my-server", "getSystemInfo"];
  assertEquals(rewriteDirectTypeArgs(input), input);
});

Deno.test("rewriteDirectTypeArgs: no-op for non-model commands", () => {
  const input = ["workflow", "run", "my-workflow"];
  assertEquals(rewriteDirectTypeArgs(input), input);
});

Deno.test("rewriteDirectTypeArgs: handles global options before model", () => {
  const input = [
    "--json",
    "model",
    "@swamp/cve/dirtyfrag",
    "method",
    "run",
    "scanFleet",
    "scanner",
  ];
  const expected = [
    "--json",
    "model",
    "method",
    "run",
    "@swamp/cve/dirtyfrag",
    "scanFleet",
    "scanner",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});

Deno.test("rewriteDirectTypeArgs: handles options between model and @type", () => {
  const input = [
    "model",
    "--repo-dir",
    "/tmp/repo",
    "@swamp/cve/dirtyfrag",
    "method",
    "run",
    "scanFleet",
    "scanner",
  ];
  const expected = [
    "model",
    "--repo-dir",
    "/tmp/repo",
    "method",
    "run",
    "@swamp/cve/dirtyfrag",
    "scanFleet",
    "scanner",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});

Deno.test("rewriteDirectTypeArgs: preserves trailing options", () => {
  const input = [
    "model",
    "@swamp/cve/dirtyfrag",
    "method",
    "run",
    "scanFleet",
    "scanner",
    "--input",
    "hosts=10.0.0.1",
    "--input",
    "user=ubuntu",
  ];
  const expected = [
    "model",
    "method",
    "run",
    "@swamp/cve/dirtyfrag",
    "scanFleet",
    "scanner",
    "--input",
    "hosts=10.0.0.1",
    "--input",
    "user=ubuntu",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});

Deno.test("rewriteDirectTypeArgs: no-op when model subcommand is not method run", () => {
  const input = ["model", "@swamp/cve/dirtyfrag", "get"];
  assertEquals(rewriteDirectTypeArgs(input), input);
});

Deno.test("rewriteDirectTypeArgs: no-op when model subcommand is create", () => {
  const input = ["model", "create", "@swamp/cve/dirtyfrag", "my-model"];
  assertEquals(rewriteDirectTypeArgs(input), input);
});

Deno.test("rewriteDirectTypeArgs: handles --flag=value style options", () => {
  const input = [
    "model",
    "--repo-dir=/tmp/repo",
    "@swamp/cve/dirtyfrag",
    "method",
    "run",
    "scanFleet",
    "scanner",
  ];
  const expected = [
    "model",
    "--repo-dir=/tmp/repo",
    "method",
    "run",
    "@swamp/cve/dirtyfrag",
    "scanFleet",
    "scanner",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});

Deno.test("rewriteDirectTypeArgs: scoped type with multiple segments", () => {
  const input = [
    "model",
    "@swamp/aws/ec2/vpc",
    "method",
    "run",
    "create",
    "my-vpc",
  ];
  const expected = [
    "model",
    "method",
    "run",
    "@swamp/aws/ec2/vpc",
    "create",
    "my-vpc",
  ];
  assertEquals(rewriteDirectTypeArgs(input), expected);
});
