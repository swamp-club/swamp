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
import {
  createInvocationContext,
  invocationContextFromData,
  invocationContextToData,
} from "./invocation_context.ts";
import type { AiTool } from "../repo/ai_tool.ts";

Deno.test("createInvocationContext: minimal context with mandatory fields only", () => {
  const ctx = createInvocationContext({
    agentSessionDetected: false,
    isInteractive: true,
    externalDatastoreConfigured: false,
  });
  assertEquals(ctx.configuredAiTools, undefined);
  assertEquals(ctx.detectedAiTool, undefined);
  assertEquals(ctx.agentSessionDetected, false);
  assertEquals(ctx.isInteractive, true);
  assertEquals(ctx.externalDatastoreConfigured, false);
});

Deno.test("createInvocationContext: configuredAiTools=[] preserved (not coerced to undefined)", () => {
  const ctx = createInvocationContext({
    configuredAiTools: [],
    agentSessionDetected: false,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });
  assertEquals(ctx.configuredAiTools, []);
});

Deno.test("createInvocationContext: copies configuredAiTools array (no aliasing)", () => {
  const tools: AiTool[] = ["claude", "cursor"];
  const ctx = createInvocationContext({
    configuredAiTools: tools,
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });
  tools.push("kiro");
  assertEquals(ctx.configuredAiTools, ["claude", "cursor"]);
});

Deno.test("createInvocationContext: externalDatastoreConfigured=true preserved", () => {
  const ctx = createInvocationContext({
    agentSessionDetected: false,
    isInteractive: false,
    externalDatastoreConfigured: true,
  });
  assertEquals(ctx.externalDatastoreConfigured, true);
});

Deno.test("invocationContextToData: round-trip with detectedAiTool and tools", () => {
  const ctx = createInvocationContext({
    configuredAiTools: ["claude", "cursor"],
    detectedAiTool: "claude",
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: true,
  });
  const data = invocationContextToData(ctx);
  assertEquals(data, {
    configuredAiTools: ["claude", "cursor"],
    detectedAiTool: "claude",
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: true,
  });
});

Deno.test("invocationContextToData: omits absent optional fields", () => {
  const ctx = createInvocationContext({
    agentSessionDetected: false,
    isInteractive: true,
    externalDatastoreConfigured: false,
  });
  const data = invocationContextToData(ctx);
  assertEquals("configuredAiTools" in data, false);
  assertEquals("detectedAiTool" in data, false);
});

Deno.test("invocationContextToData: empty configuredAiTools array is preserved on the wire", () => {
  const ctx = createInvocationContext({
    configuredAiTools: [],
    agentSessionDetected: false,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });
  const data = invocationContextToData(ctx);
  assertEquals(data.configuredAiTools, []);
});

Deno.test("invocationContextFromData: round-trip preserves every field", () => {
  const original = createInvocationContext({
    configuredAiTools: ["claude"],
    detectedAiTool: "claude",
    agentSessionDetected: true,
    isInteractive: true,
    externalDatastoreConfigured: true,
  });
  const restored = invocationContextFromData(invocationContextToData(original));
  assertEquals(restored.configuredAiTools, ["claude"]);
  assertEquals(restored.detectedAiTool, "claude");
  assertEquals(restored.agentSessionDetected, true);
  assertEquals(restored.isInteractive, true);
  assertEquals(restored.externalDatastoreConfigured, true);
});

Deno.test("invocationContextFromData: agent detected without specific tool round-trips", () => {
  const original = createInvocationContext({
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });
  const restored = invocationContextFromData(invocationContextToData(original));
  assertEquals(restored.detectedAiTool, undefined);
  assertEquals(restored.agentSessionDetected, true);
});
