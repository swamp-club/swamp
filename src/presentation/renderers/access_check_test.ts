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

import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("accessCheckRenderer log: shows DENY when deny grant precedes allow", () => {
  const renderer = createAccessCheckRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult({
      decisions: [
        {
          effect: "deny",
          grantId: "deny-uuid-1234-5678-abcd-ef0123456789",
          subject: { kind: "user", name: "adam" },
        },
        {
          effect: "allow",
          grantId: "allow-uuid-1234-5678-abcd-ef012345678",
          subject: { kind: "user", name: "adam" },
        },
      ],
    }));
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "DENY");
});

Deno.test("accessCheckRenderer json: verdict is deny when deny grant comes first", () => {
  const renderer = createAccessCheckRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(makeResult({
      decisions: [
        {
          effect: "deny",
          grantId: "deny-uuid-1234-5678-abcd-ef0123456789",
          subject: { kind: "user", name: "adam" },
        },
        {
          effect: "allow",
          grantId: "allow-uuid-1234-5678-abcd-ef012345678",
          subject: { kind: "user", name: "adam" },
        },
      ],
    }));
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.effect, "deny");
  assertEquals(parsed.matchingGrants.length, 2);
});

// --- approval policy ---

function captureLog(result: AccessCheckResult): string[] {
  const renderer = createAccessCheckRenderer("log");
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

const impliedApprove = makeResult({
  action: "approve",
  decisions: [{
    effect: "allow",
    grantId: "test-uuid-1234-5678-abcd-ef0123456789",
    subject: { kind: "group", name: "swamp-lanes" },
    impliedBy: "run",
  }],
});

Deno.test("accessCheckRenderer log: marks approve implied by run and names the server setting", () => {
  const output = captureLog({
    ...impliedApprove,
    approveRequiresExplicitGrant: false,
  });
  assertStringIncludes(output[0], "ALLOW");
  assertStringIncludes(output[0], "[implied by run]");
  const note = output[output.length - 1];
  assertStringIncludes(note, "allowed only through a run grant");
  assertStringIncludes(note, "auth.approve-requires-explicit-grant");
});

Deno.test("accessCheckRenderer log: local check hint names the serve flag", () => {
  const output = captureLog(impliedApprove);
  assertStringIncludes(
    output[output.length - 1],
    "--approve-requires-explicit-grant",
  );
});

Deno.test("accessCheckRenderer log: no note when an explicit approve grant also allows", () => {
  const output = captureLog({
    ...impliedApprove,
    decisions: [
      ...impliedApprove.decisions,
      {
        effect: "allow",
        grantId: "second-uuid-1234",
        subject: { kind: "user", name: "adam" },
      },
    ],
  });
  assertEquals(output.some((l) => l.includes("Note:")), false);
});

Deno.test("accessCheckRenderer log: states the policy when the server requires an explicit approve grant", () => {
  const output = captureLog({
    ...impliedApprove,
    decisions: [],
    approveRequiresExplicitGrant: true,
  });
  assertStringIncludes(output[0], "DENY (implicit)");
  assertStringIncludes(output[1], "run grants do not count");
});

Deno.test("accessCheckRenderer log: no approval note for other actions", () => {
  const output = captureLog(makeResult({ approveRequiresExplicitGrant: true }));
  assertEquals(output.length, 1);
});

Deno.test("accessCheckRenderer json: includes impliedBy and the approval policy", () => {
  const renderer = createAccessCheckRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render({ ...impliedApprove, approveRequiresExplicitGrant: false });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.approveRequiresExplicitGrant, false);
  assertEquals(parsed.matchingGrants[0].impliedBy, "run");
});

Deno.test("accessCheckRenderer json: omits the approval policy for a local check", () => {
  const renderer = createAccessCheckRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(impliedApprove);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertEquals("approveRequiresExplicitGrant" in parsed, false);
});
