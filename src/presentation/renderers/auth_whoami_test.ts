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
import { stripAnsiCode } from "@std/fmt/colors";
import {
  type AuthWhoamiEvent,
  consumeStream,
  type WhoamiCollectiveEntitlement,
  type WhoamiIdentity,
} from "../../libswamp/mod.ts";
import { createAuthWhoamiRenderer } from "./auth_whoami.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

function makeIdentity(
  opts?: { collectives?: string[] },
): WhoamiIdentity {
  return {
    serverUrl: "https://club.example.com",
    id: "user-1",
    username: "alice",
    email: "alice@example.com",
    name: "Alice",
    ...(opts?.collectives ? { collectives: opts.collectives } : {}),
  };
}

function makeCollectiveTokenIdentity(
  opts?: { scopes?: string[]; collectives?: string[] },
): WhoamiIdentity {
  return {
    serverUrl: "https://club.example.com",
    id: "",
    username: "",
    email: "",
    name: "",
    collectiveToken: true,
    collectiveSlug: "myorg",
    scopes: opts?.scopes ?? ["extensions:push"],
    ...(opts?.collectives
      ? { collectives: opts.collectives }
      : { collectives: ["myorg"] }),
  };
}

async function* toStream(
  events: AuthWhoamiEvent[],
): AsyncGenerator<AuthWhoamiEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogAuthWhoamiRenderer - completed event runs without error", async () => {
  const renderer = createAuthWhoamiRenderer("log");
  const events: AuthWhoamiEvent[] = [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://club.example.com" },
    { kind: "completed", identity: makeIdentity() },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogAuthWhoamiRenderer - collectives handled without error", async () => {
  const renderer = createAuthWhoamiRenderer("log");
  const events: AuthWhoamiEvent[] = [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://club.example.com" },
    {
      kind: "completed",
      identity: makeIdentity({ collectives: ["org-a", "org-b"] }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogAuthWhoamiRenderer - error event throws UserError", () => {
  const renderer = createAuthWhoamiRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_authenticated", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});

Deno.test("JsonAuthWhoamiRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const events: AuthWhoamiEvent[] = [
      { kind: "loading_credentials" },
      { kind: "contacting_server", serverUrl: "https://club.example.com" },
      { kind: "completed", identity: makeIdentity() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.authenticated, true);
    assertEquals(parsed.serverUrl, "https://club.example.com");
    assertEquals(parsed.username, "alice");
    assertEquals(parsed.email, "alice@example.com");
    assertEquals(parsed.id, "user-1");
    assertEquals(parsed.name, "Alice");
    assertEquals(parsed.collectives, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - collectives included when present", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const events: AuthWhoamiEvent[] = [
      { kind: "loading_credentials" },
      {
        kind: "completed",
        identity: makeIdentity({ collectives: ["org-a"] }),
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.collectives, ["org-a"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - intermediate events produce no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const handlers = renderer.handlers();
    handlers.loading_credentials({ kind: "loading_credentials" });
    handlers.contacting_server({
      kind: "contacting_server",
      serverUrl: "https://club.example.com",
    });
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - error event throws UserError", () => {
  const renderer = createAuthWhoamiRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_authenticated", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});

Deno.test("LogAuthWhoamiRenderer - collective token displays slug and scopes", async () => {
  const renderer = createAuthWhoamiRenderer("log");
  const events: AuthWhoamiEvent[] = [
    { kind: "loading_credentials" },
    {
      kind: "completed",
      identity: makeCollectiveTokenIdentity({
        scopes: ["extensions:push", "extensions:yank"],
      }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonAuthWhoamiRenderer - collective token serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const events: AuthWhoamiEvent[] = [
      { kind: "loading_credentials" },
      {
        kind: "completed",
        identity: makeCollectiveTokenIdentity({
          scopes: ["extensions:push"],
        }),
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.authenticated, true);
    assertEquals(parsed.collectiveToken, true);
    assertEquals(parsed.collectiveSlug, "myorg");
    assertEquals(parsed.scopes, ["extensions:push"]);
    assertEquals(parsed.collectives, ["myorg"]);
    assertEquals(parsed.username, undefined);
    assertEquals(parsed.email, undefined);
    assertEquals(parsed.id, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("createAuthWhoamiRenderer - factory returns correct type per mode", () => {
  const logRenderer = createAuthWhoamiRenderer("log");
  const jsonRenderer = createAuthWhoamiRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});

// --- entitlement rendering (issue #1544) ---

function makeEntitledIdentity(
  entitlements: WhoamiCollectiveEntitlement[],
  plan?: string,
): WhoamiIdentity {
  return {
    ...makeIdentity({ collectives: entitlements.map((c) => c.slug) }),
    ...(plan ? { plan } : {}),
    collectiveEntitlements: entitlements,
  };
}

function captureLog(identity: WhoamiIdentity, mode: OutputMode): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createAuthWhoamiRenderer(mode);
    renderer.handlers().completed({ kind: "completed", identity });
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

Deno.test("LogAuthWhoamiRenderer - no entitlement renders the pre-entitlement output", () => {
  // The compatibility guarantee: upgrading the CLI alone, against an older or
  // self-hosted swamp-club, must not change a byte of this.
  const output = captureLog(
    makeIdentity({ collectives: ["org-a", "org-b"] }),
    "log",
  );

  assertEquals(
    output,
    "alice (alice@example.com) on https://club.example.com\n" +
      "Collectives: org-a, org-b",
  );
});

Deno.test("LogAuthWhoamiRenderer - shows the plan roll-up and per-collective block", () => {
  const output = captureLog(
    makeEntitledIdentity([
      {
        slug: "acme",
        plan: "team",
        planName: "Team",
        subscriptionStatus: "active",
        trial: null,
      },
      {
        slug: "keeb",
        plan: "free",
        planName: "Free",
        trial: {
          state: "active",
          startedAt: "2026-07-20T00:00:00.000Z",
          endsAt: "2026-08-19T00:00:00.000Z",
          daysRemaining: 13,
        },
      },
    ], "team"),
    "log",
  );

  assertStringIncludes(output, "Plan: Team");
  assertStringIncludes(output, "Collectives:");
  assertStringIncludes(output, "acme  Team  active");
  assertStringIncludes(
    output,
    "keeb  Free  trial: 13 days left (ends 2026-08-19)",
  );
});

Deno.test("LogAuthWhoamiRenderer - a paying collective is never shown a trial", () => {
  // Same rule the web surface applies to its trial banner. The data is still
  // in --json; only the display suppresses it.
  const output = captureLog(
    makeEntitledIdentity([
      {
        slug: "acme",
        plan: "team",
        planName: "Team",
        subscriptionStatus: "active",
        trial: {
          state: "active",
          startedAt: "2026-07-20T00:00:00.000Z",
          endsAt: "2026-08-19T00:00:00.000Z",
          daysRemaining: 13,
        },
      },
    ], "team"),
    "log",
  );

  assertEquals(output.includes("trial"), false);
  assertStringIncludes(output, "active");
});

Deno.test("LogAuthWhoamiRenderer - an expired trial says so", () => {
  const output = captureLog(
    makeEntitledIdentity([
      {
        slug: "keeb",
        plan: "free",
        planName: "Free",
        trial: {
          state: "expired",
          startedAt: "2026-05-01T00:00:00.000Z",
          endsAt: "2026-05-31T00:00:00.000Z",
          daysRemaining: 0,
        },
      },
    ], "free"),
    "log",
  );

  assertStringIncludes(output, "trial expired");
});

Deno.test("LogAuthWhoamiRenderer - one day left is singular", () => {
  const output = captureLog(
    makeEntitledIdentity([
      {
        slug: "keeb",
        plan: "free",
        planName: "Free",
        trial: {
          state: "active",
          startedAt: "2026-07-08T00:00:00.000Z",
          endsAt: "2026-08-07T00:00:00.000Z",
          daysRemaining: 1,
        },
      },
    ], "free"),
    "log",
  );

  assertStringIncludes(output, "trial: 1 day left");
});

Deno.test("LogAuthWhoamiRenderer - a member's withheld status renders no note", () => {
  const output = captureLog(
    makeEntitledIdentity([
      { slug: "acme", plan: "team", planName: "Team", trial: null },
    ], "team"),
    "log",
  );

  assertStringIncludes(output, "acme");
  assertStringIncludes(output, "Team");
  assertEquals(output.includes("active"), false);
});

Deno.test("JsonAuthWhoamiRenderer - passes plan and entitlement through verbatim", () => {
  const trial = {
    state: "active" as const,
    startedAt: "2026-07-20T00:00:00.000Z",
    endsAt: "2026-08-19T00:00:00.000Z",
    daysRemaining: 13,
  };
  const output = captureLog(
    makeEntitledIdentity([
      { slug: "acme", plan: "team", planName: "Team", trial },
    ], "team"),
    "json",
  );
  const parsed = JSON.parse(output);

  assertEquals(parsed.plan, "team");
  assertEquals(parsed.collectiveEntitlements.length, 1);
  assertEquals(parsed.collectiveEntitlements[0].planName, "Team");
  // Retained even though log mode would hide it for a paid collective —
  // --json is what gets pasted into a billing-triage report.
  assertEquals(parsed.collectiveEntitlements[0].trial, trial);
});

Deno.test("JsonAuthWhoamiRenderer - omits entitlement keys when the server sent none", () => {
  const output = captureLog(makeIdentity({ collectives: ["org-a"] }), "json");
  const parsed = JSON.parse(output);

  assertEquals("plan" in parsed, false);
  assertEquals("collectiveEntitlements" in parsed, false);
  assertEquals(parsed.collectives, ["org-a"]);
});
