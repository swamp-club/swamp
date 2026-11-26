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
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import { MemberName } from "../../domain/serve/member_name.ts";
import { ServeMember } from "../../domain/serve/serve_member.ts";
import type { JoinTokenView } from "../../domain/serve/join_token.ts";
import {
  renderMemberGet,
  renderMemberList,
  renderMemberRemove,
  renderMemberTokenCreate,
  renderMemberTokenList,
  renderMemberTokenRevoke,
} from "./serve_member_output.ts";

await initializeLogging({});

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const TOKEN: JoinTokenView = {
  memberName: "edge-1",
  state: "unused",
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
};

const MEMBER = ServeMember.join({
  memberId: crypto.randomUUID(),
  name: MemberName.create("edge-1"),
  role: "member",
  fingerprint: sampleFingerprint(),
  now: NOW,
}).toJSON();

function captured(render: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (message: string) => lines.push(message);
  try {
    render();
  } finally {
    console.log = original;
  }
  return stripAnsiCode(lines.join("\n"));
}

Deno.test("renderMemberTokenCreate: log mode prints the token once with the shown-once warning", () => {
  const out = captured(() =>
    renderMemberTokenCreate(
      { token: TOKEN, joinToken: "edge-1.s3cret" },
      "log",
    )
  );
  assertStringIncludes(out, "Join token: edge-1");
  assertStringIncludes(out, "edge-1.s3cret");
  assertStringIncludes(out, "shown once");
});

Deno.test("renderMemberTokenCreate: json mode carries the token and its view", () => {
  const out = captured(() =>
    renderMemberTokenCreate(
      { token: TOKEN, joinToken: "edge-1.s3cret" },
      "json",
    )
  );
  assertEquals(JSON.parse(out), { token: TOKEN, joinToken: "edge-1.s3cret" });
});

Deno.test("renderMemberTokenList: log mode tabulates tokens and says when there are none", () => {
  const out = captured(() => renderMemberTokenList({ tokens: [TOKEN] }, "log"));
  assertStringIncludes(out, "NAME");
  assertStringIncludes(out, "edge-1");
  assertStringIncludes(out, "unused");
  assertStringIncludes(
    captured(() => renderMemberTokenList({ tokens: [] }, "log")),
    "No join tokens found.",
  );
  assertEquals(
    JSON.parse(captured(() => renderMemberTokenList({ tokens: [] }, "json"))),
    { tokens: [] },
  );
});

Deno.test("renderMemberTokenRevoke: both modes name the token", () => {
  const revoked = { ...TOKEN, state: "revoked" as const };
  assertStringIncludes(
    captured(() => renderMemberTokenRevoke({ token: revoked }, "log")),
    "Join token edge-1 revoked.",
  );
  assertEquals(
    JSON.parse(
      captured(() => renderMemberTokenRevoke({ token: revoked }, "json")),
    ),
    { token: revoked },
  );
});

Deno.test("renderMemberList and renderMemberGet: show the member's status and fingerprint", () => {
  const list = captured(() => renderMemberList({ members: [MEMBER] }, "log"));
  assertStringIncludes(list, "STATUS");
  assertStringIncludes(list, "edge-1");
  assertStringIncludes(list, "online");
  assertStringIncludes(
    captured(() => renderMemberList({ members: [] }, "log")),
    "No members found.",
  );
  const get = captured(() => renderMemberGet({ member: MEMBER }, "log"));
  assertStringIncludes(get, "Member: edge-1 (member)");
  assertStringIncludes(get, "Swamp version: 20261125.1629.0");
  assertEquals(
    JSON.parse(captured(() => renderMemberGet({ member: MEMBER }, "json"))),
    { member: MEMBER },
  );
});

Deno.test("renderMemberRemove: both modes name the member", () => {
  const removed = { ...MEMBER, status: "removed" as const };
  assertStringIncludes(
    captured(() => renderMemberRemove({ member: removed }, "log")),
    "Member edge-1 removed.",
  );
  assertEquals(
    JSON.parse(captured(() => renderMemberRemove({ member: removed }, "json"))),
    { member: removed },
  );
});
