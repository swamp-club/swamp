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
import {
  type AccessCheckResult,
  createAccessCheckRenderer,
} from "./access_check.ts";

function makeResult(
  overrides: Partial<AccessCheckResult> = {},
): AccessCheckResult {
  return {
    subject: "user:adam",
    action: "run",
    resource: "workflow:@acme/deploy",
    collectives: [],
    decisions: [{
      effect: "allow",
      grantId: "test-uuid-1234-5678-abcd-ef0123456789",
      subject: { kind: "idp-group", name: "platform-eng" },
    }],
    ...overrides,
  };
}

Deno.test("accessCheckRenderer log: shows ALLOW", () => {
  const renderer = createAccessCheckRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult());
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "ALLOW");
  assertStringIncludes(output[0], "test-uui");
});

Deno.test("accessCheckRenderer log: shows DENY when no decisions", () => {
  const renderer = createAccessCheckRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult({ decisions: [] }));
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "DENY");
  assertStringIncludes(output[0], "no matching grants");
});

Deno.test("accessCheckRenderer json: outputs structured JSON", () => {
  const renderer = createAccessCheckRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult());
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertStringIncludes(parsed.effect, "allow");
  assertStringIncludes(parsed.subject, "user:adam");
});

Deno.test("accessCheckRenderer json: implicit deny when no grants", () => {
  const renderer = createAccessCheckRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult({ decisions: [] }));
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertStringIncludes(parsed.effect, "deny");
});
