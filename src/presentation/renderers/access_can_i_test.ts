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
import { assertStringIncludes } from "@std/assert";
import {
  type AccessCanIResult,
  type CanIDecision,
  createAccessCanIRenderer,
} from "./access_can_i.ts";

function makeDecision(
  overrides: Partial<CanIDecision> = {},
): CanIDecision {
  return {
    action: "run",
    resource: "workflow:@acme/deploy",
    effect: "allow",
    grantId: "7f3a1234-5678-abcd-ef01-234567890abc",
    via: "idp-group:platform-eng",
    ...overrides,
  };
}

function captureRender(
  mode: "log" | "json",
  result: AccessCanIResult,
): string[] {
  const renderer = createAccessCanIRenderer(mode);
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(result);
  } finally {
    console.log = origLog;
  }
  return output;
}

// ── Factory ─────────────────────────────────────────────────────────────

Deno.test("createAccessCanIRenderer: returns renderer for log mode", () => {
  const renderer = createAccessCanIRenderer("log");
  assertEquals(typeof renderer.render, "function");
});

Deno.test("createAccessCanIRenderer: returns renderer for json mode", () => {
  const renderer = createAccessCanIRenderer("json");
  assertEquals(typeof renderer.render, "function");
});

// ── Log mode: specific check ────────────────────────────────────────────

Deno.test("accessCanIRenderer log: specific check shows ALLOW with grant provenance", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [makeDecision()],
    query: { action: "run", resource: "workflow:@acme/deploy" },
  });
  assertStringIncludes(output[0], "ALLOW");
  assertStringIncludes(output[0], "7f3a1234");
  assertStringIncludes(output[0], "run");
  assertStringIncludes(output[0], "workflow:@acme/deploy");
});

Deno.test("accessCanIRenderer log: specific check shows DENY with action and resource on implicit deny", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [],
    query: { action: "admin", resource: "access:*" },
  });
  assertStringIncludes(output[0], "DENY");
  assertStringIncludes(output[0], "admin");
  assertStringIncludes(output[0], "access:*");
  assertStringIncludes(output[0], "user:adam");
});

Deno.test("accessCanIRenderer log: specific check lists all grants when multiple match", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [
      makeDecision(),
      makeDecision({
        grantId: "abc12345-0000-0000-0000-000000000000",
        via: "group:admins",
        effect: "deny",
      }),
    ],
    query: { action: "run", resource: "workflow:@acme/deploy" },
  });
  assertStringIncludes(output[0], "ALLOW");
  assertStringIncludes(output[2], "All matching grants:");
  assertStringIncludes(output[3], "ALLOW");
  assertStringIncludes(output[3], "7f3a1234");
  assertStringIncludes(output[4], "DENY");
  assertStringIncludes(output[4], "abc12345");
});

// ── Log mode: enumeration ───────────────────────────────────────────────

Deno.test("accessCanIRenderer log: enumeration shows no grants message", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [],
  });
  assertStringIncludes(output[0], "No matching grants");
  assertStringIncludes(output[0], "user:adam");
});

Deno.test("accessCanIRenderer log: enumeration shows permissions header and decision rows", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [
      makeDecision(),
      makeDecision({
        action: "read",
        resource: "data:@acme/dev-*",
        via: "group:development",
      }),
    ],
  });
  assertStringIncludes(output[0], "Permissions for user:adam:");
  assertStringIncludes(output[1], "workflow:@acme/deploy");
  assertStringIncludes(output[1], "run");
  assertStringIncludes(output[1], "✓");
  assertStringIncludes(output[2], "data:@acme/dev-*");
  assertStringIncludes(output[2], "read");
});

Deno.test("accessCanIRenderer log: enumeration shows condition text", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [
      makeDecision({ condition: "resource.tags.env == 'staging'" }),
    ],
  });
  assertStringIncludes(output[1], "[when: resource.tags.env == 'staging']");
});

Deno.test("accessCanIRenderer log: enumeration shows deny marker for deny effect", () => {
  const output = captureRender("log", {
    principal: "user:adam",
    decisions: [
      makeDecision({ effect: "deny" }),
    ],
  });
  assertStringIncludes(output[1], "✗");
});

// ── JSON mode: specific check ───────────────────────────────────────────

Deno.test("accessCanIRenderer json: specific check includes top-level effect", () => {
  const output = captureRender("json", {
    principal: "user:adam",
    decisions: [makeDecision()],
    query: { action: "run", resource: "workflow:@acme/deploy" },
  });
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.effect, "allow");
  assertEquals(parsed.action, "run");
  assertEquals(parsed.resource, "workflow:@acme/deploy");
  assertEquals(parsed.principal, "user:adam");
  assertEquals(parsed.decisions.length, 1);
});

Deno.test("accessCanIRenderer json: specific check implicit deny sets effect to deny", () => {
  const output = captureRender("json", {
    principal: "user:adam",
    decisions: [],
    query: { action: "admin", resource: "access:*" },
  });
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.effect, "deny");
  assertEquals(parsed.action, "admin");
  assertEquals(parsed.resource, "access:*");
});

// ── JSON mode: enumeration ──────────────────────────────────────────────

Deno.test("accessCanIRenderer json: enumeration outputs principal and decisions", () => {
  const output = captureRender("json", {
    principal: "user:adam",
    decisions: [makeDecision(), makeDecision({ action: "read" })],
  });
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.principal, "user:adam");
  assertEquals(parsed.decisions.length, 2);
  assertEquals(parsed.effect, undefined);
});
