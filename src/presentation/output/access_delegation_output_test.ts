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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DelegationView } from "../../libswamp/access/delegation_list.ts";
import {
  renderDelegation,
  renderDelegationEnded,
  renderDelegationList,
} from "./access_delegation_output.ts";

await initializeLogging({});

const VIEW: DelegationView = {
  id: "6f1c2a52-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  integrationId: "slack-bot",
  state: "issued",
  person: { username: "adam", email: "adam@example.com" },
  external: {
    platform: "slack",
    teamId: "T1",
    userId: "U1",
    display: "Adam",
    workspace: "Acme",
  },
  ceilingDigest: "sha256:digest",
  createdAt: new Date(0).toISOString(),
  consentedAt: new Date(1_000).toISOString(),
  expiresAt: new Date(10_000).toISOString(),
  club: { linkId: "link-1", endState: "none", endAttempts: 0 },
  tokenGeneration: 2,
  accessTokenExpiresAt: new Date(5_000).toISOString(),
};

const PENDING: DelegationView = {
  ...VIEW,
  state: "ended",
  endedAt: new Date(3_000).toISOString(),
  endCause: "operator",
  tokenGeneration: undefined,
  accessTokenExpiresAt: undefined,
  club: {
    linkId: "link-1",
    endState: "pending",
    endAttempts: 3,
    lastEndError: "swamp-club answered 503",
    nextEndAttemptAt: new Date(4_000).toISOString(),
  },
};

function captured(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return stripAnsiCode(lines.join("\n"));
}

Deno.test("renderDelegationList: json is the array of views", () => {
  const output = captured(() =>
    renderDelegationList({ delegations: [VIEW], count: 1 }, "json")
  );
  assertEquals(JSON.parse(output), [VIEW]);
});

Deno.test("renderDelegationList: log mode is a table of id, integration, state, person, external user and expiry", () => {
  const output = captured(() =>
    renderDelegationList({ delegations: [VIEW], count: 1 }, "log")
  );
  for (
    const text of [
      "ID",
      "INTEGRATION",
      "EXPIRES",
      VIEW.id,
      "slack-bot",
      "issued",
      "adam <adam@example.com>",
      "Adam (slack:U1)",
      VIEW.expiresAt!,
    ]
  ) assertStringIncludes(output, text);
});

Deno.test("renderDelegationList: log mode says when there are none", () => {
  assertStringIncludes(
    captured(() => renderDelegationList({ delegations: [], count: 0 }, "log")),
    "No delegations.",
  );
});

Deno.test("renderDelegation: json is the view; log mode shows its details", () => {
  assertEquals(
    JSON.parse(captured(() => renderDelegation(VIEW, "json"))),
    VIEW,
  );
  const output = captured(() => renderDelegation(VIEW, "log"));
  for (
    const text of [
      `Delegation: ${VIEW.id}`,
      "Integration: slack-bot",
      "State: issued",
      "Person: adam <adam@example.com>",
      "External user: Adam (slack:U1)",
      "Tokens: generation 2",
      "Swamp Club link: link-1",
    ]
  ) assertStringIncludes(output, text);
  assert(!output.includes("not told yet"), output);
});

Deno.test("renderDelegation: a pending end says swamp-club has not been told, with the attempts and the last error", () => {
  const output = captured(() => renderDelegation(PENDING, "log"));
  assertStringIncludes(output, "not told yet");
  assertStringIncludes(output, "attempts: 3");
  assertStringIncludes(output, "swamp-club answered 503");
  assertStringIncludes(output, "End cause: operator");
});

Deno.test("renderDelegationEnded: json carries alreadyEnded beside the view", () => {
  const output = captured(() =>
    renderDelegationEnded({ delegation: PENDING, alreadyEnded: false }, "json")
  );
  assertEquals(JSON.parse(output), {
    ...JSON.parse(JSON.stringify(PENDING)),
    alreadyEnded: false,
  });
});

Deno.test("renderDelegationEnded: log mode says it ended and swamp-club will be told, or that it had already ended", () => {
  const ended = captured(() =>
    renderDelegationEnded({ delegation: PENDING, alreadyEnded: false }, "log")
  );
  assertStringIncludes(ended, `Delegation ${PENDING.id} ended.`);
  assertStringIncludes(ended, "will tell swamp-club");
  const already = captured(() =>
    renderDelegationEnded({ delegation: PENDING, alreadyEnded: true }, "log")
  );
  assertStringIncludes(already, "had already ended");
});
