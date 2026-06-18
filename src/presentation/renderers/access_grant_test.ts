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

import { assertStringIncludes } from "@std/assert";
import { createAccessGrantListRenderer } from "./access_grant.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: "test-uuid-1234-5678-abcd-ef0123456789",
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "@acme/*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "local" },
    createdAt: "2026-06-18T00:00:00Z",
    ...overrides,
  };
}

Deno.test("accessGrantListRenderer log: shows header", () => {
  const renderer = createAccessGrantListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render([makeGrant()]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "ID");
  assertStringIncludes(output[0], "SUBJECT");
  assertStringIncludes(output[0], "EFFECT");
});

Deno.test("accessGrantListRenderer log: shows grant data", () => {
  const renderer = createAccessGrantListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render([makeGrant()]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[1], "test-uuid-1234-5678-abcd-ef0123456789");
  assertStringIncludes(output[1], "user:adam");
  assertStringIncludes(output[1], "allow");
  assertStringIncludes(output[1], "workflow:@acme/*");
});

Deno.test("accessGrantListRenderer log: shows empty message", () => {
  const renderer = createAccessGrantListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render([]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "No active grants found");
});

Deno.test("accessGrantListRenderer json: outputs JSON array", () => {
  const renderer = createAccessGrantListRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render([makeGrant()]);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertStringIncludes(parsed[0].id, "test-uuid");
});
