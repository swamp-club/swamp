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
import {
  sampleFingerprint,
  sampleFingerprintProps,
} from "../../domain/serve/federation_test_helpers.ts";
import { Fingerprint } from "../../domain/serve/fingerprint.ts";
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
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

const TOKEN: JoinTokenView = {
  memberName: "edge-1",
  state: "unused",
  createdAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
};

const RECORD = ServeMember.join({
  memberId: crypto.randomUUID(),
  name: MemberName.create("edge-1"),
  role: "member",
  fingerprint: sampleFingerprint(),
  now: NOW,
}).toJSON();

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const OLD_INSTANCE = "00000000-0000-4000-8000-000000000002";

const MEMBER = {
  ...RECORD,
  live: {
    lastSeenAt: new Date(NOW - 4_000).toISOString(),
    instances: [
      {
        instanceId: INSTANCE,
        lastSeenAt: new Date(NOW - 4_000).toISOString(),
        runtime: {
          team: { role: "leader" as const, nodes: 2 },
          startedAt: "2026-11-26T11:00:00.000Z",
          ready: true,
        },
      },
      {
        instanceId: OLD_INSTANCE,
        lastSeenAt: new Date(NOW - 125_000).toISOString(),
        runtime: null,
      },
    ],
  },
};

const NEVER_SEEN = { ...RECORD, live: { lastSeenAt: null, instances: [] } };

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
  const list = captured(() =>
    renderMemberList({ members: [MEMBER] }, "log", NOW)
  );
  assertStringIncludes(list, "STATUS");
  assertStringIncludes(list, "edge-1");
  assertStringIncludes(list, "online");
  assertStringIncludes(
    captured(() => renderMemberList({ members: [] }, "log")),
    "No members found.",
  );
  const get = captured(() => renderMemberGet({ member: MEMBER }, "log", NOW));
  assertStringIncludes(get, "Member: edge-1 (member)");
  assertStringIncludes(get, "Swamp version: 20261125.1629.0");
  assertEquals(
    JSON.parse(captured(() => renderMemberGet({ member: MEMBER }, "json"))),
    { member: MEMBER },
  );
});

Deno.test("renderMemberList: a LAST SEEN column after STATUS, '-' for a member never seen", () => {
  const lines = captured(() =>
    renderMemberList(
      { members: [MEMBER, { ...NEVER_SEEN, name: "edge-2" }] },
      "log",
      NOW,
    )
  ).split("\n");
  assertStringIncludes(lines[0], "STATUS  LAST SEEN  INSTANCES");
  assertStringIncludes(lines[1], "online  4s ago");
  assertEquals(lines[2].split(/\s{2,}/)[3], "-");
});

Deno.test("renderMemberGet: a Live section apart from the record's instances, one line per check-in", () => {
  const get = captured(() => renderMemberGet({ member: MEMBER }, "log", NOW));
  const live = get.slice(get.indexOf("Live:"));
  assertStringIncludes(live, "Last seen: 4s ago (2026-11-26T11:59:56.000Z)");
  assertStringIncludes(
    live,
    `${INSTANCE} live 4s ago (leader of 2, started 2026-11-26T11:00:00.000Z, ready)`,
  );
  assertEquals(live.endsWith(`${OLD_INSTANCE} stale 2m ago`), true);
  assertEquals(live.split(INSTANCE).length, 2);
  const never = captured(() =>
    renderMemberGet({ member: NEVER_SEEN }, "log", NOW)
  );
  assertStringIncludes(never, "Last seen: -");
});

const RESTARTED_INSTANCE = "00000000-0000-4000-8000-000000000003";

const RESTARTED = {
  ...RECORD,
  live: {
    lastSeenAt: new Date(NOW - 5_000).toISOString(),
    instances: [
      { at: 5_000, id: INSTANCE },
      { at: 120_000, id: OLD_INSTANCE },
      { at: 19 * 60 * 60 * 1000, id: RESTARTED_INSTANCE },
    ].map(({ at, id }) => ({
      instanceId: id,
      lastSeenAt: new Date(NOW - at).toISOString(),
      runtime: {
        team: null,
        startedAt: "2026-11-26T00:00:00.000Z",
        ready: true,
      },
    })),
  },
};

function instancesColumn(out: string, row = 1): string {
  return out.split("\n")[row].split(/\s{2,}/)[4];
}

Deno.test("renderMemberList: INSTANCES counts live instances only, 0 when none is live, '-' without a live view", () => {
  assertEquals(
    instancesColumn(
      captured(() => renderMemberList({ members: [RESTARTED] }, "log", NOW)),
    ),
    "1",
  );
  const noneLive = {
    ...RESTARTED,
    live: { ...RESTARTED.live, instances: RESTARTED.live.instances.slice(1) },
  };
  assertEquals(
    instancesColumn(
      captured(() => renderMemberList({ members: [noneLive] }, "log", NOW)),
    ),
    "0",
  );
  assertEquals(
    instancesColumn(
      captured(() => renderMemberList({ members: [RECORD] }, "log", NOW)),
    ),
    "-",
  );
  const unparsed = {
    ...RESTARTED,
    live: {
      ...RESTARTED.live,
      instances: [{ ...RESTARTED.live.instances[0], lastSeenAt: "garbage" }],
    },
  };
  assertEquals(
    instancesColumn(
      captured(() => renderMemberList({ members: [unparsed] }, "log", NOW)),
    ),
    "0",
  );
});

Deno.test("renderMemberGet: labels each instance live, stale or offline, and shows runtime facts only for a live one", () => {
  const get = captured(() =>
    renderMemberGet({ member: RESTARTED }, "log", NOW)
  );
  const live = get.slice(get.indexOf("Live:"));
  assertStringIncludes(
    live,
    `${INSTANCE} live 5s ago (no team, started 2026-11-26T00:00:00.000Z, ready)`,
  );
  assertStringIncludes(live, `${OLD_INSTANCE} stale 2m ago\n`);
  assertStringIncludes(live, `${RESTARTED_INSTANCE} offline 19h ago`);
  assertEquals(live.split("ready").length, 2);
  const instances = get.slice(get.indexOf("Instances:"), get.indexOf("Live:"));
  assertEquals(instances.includes("live"), false);
});

Deno.test("renderMemberList and renderMemberGet: an instance's state is read against the hub's time, not the CLI's", () => {
  const hubNow = new Date(NOW).toISOString();
  const cliAhead = NOW + 60 * 60 * 1000;
  assertEquals(
    instancesColumn(
      captured(() =>
        renderMemberList({ members: [RESTARTED], now: hubNow }, "log", cliAhead)
      ),
    ),
    "1",
  );
  assertEquals(
    instancesColumn(
      captured(() =>
        renderMemberList({ members: [RESTARTED] }, "log", cliAhead)
      ),
    ),
    "0",
  );
  const get = captured(() =>
    renderMemberGet({ member: RESTARTED, now: hubNow }, "log", cliAhead)
  );
  assertStringIncludes(get, `${INSTANCE} live 5s ago`);
});

Deno.test("renderMemberList and renderMemberGet: json output is the reply as given, whatever its instances' states", () => {
  const now = new Date(NOW).toISOString();
  assertEquals(
    captured(() => renderMemberList({ members: [RESTARTED], now }, "json")),
    JSON.stringify({ members: [RESTARTED], now }, null, 2),
  );
  assertEquals(
    captured(() => renderMemberGet({ member: RESTARTED, now }, "json")),
    JSON.stringify({ member: RESTARTED, now }, null, 2),
  );
});

Deno.test("renderMemberList and renderMemberGet: json mode carries the live view", () => {
  assertEquals(
    JSON.parse(
      captured(() => renderMemberList({ members: [MEMBER] }, "json", NOW)),
    ),
    { members: [MEMBER] },
  );
});

Deno.test("renderMemberList and renderMemberGet: a reply without a live view, from an older serve, renders '-' instead of failing", () => {
  const lines = captured(() =>
    renderMemberList({ members: [RECORD] }, "log", NOW)
  ).split("\n");
  assertEquals(lines[1].split(/\s{2,}/)[3], "-");
  const get = captured(() => renderMemberGet({ member: RECORD }, "log", NOW));
  assertStringIncludes(get, "Live:\n  not reported by this server");
  assertEquals(
    JSON.parse(captured(() => renderMemberGet({ member: RECORD }, "json"))),
    { member: RECORD },
  );
});

Deno.test("renderMemberRemove: both modes name the member", () => {
  const removed = { ...RECORD, status: "removed" as const };
  assertStringIncludes(
    captured(() => renderMemberRemove({ member: removed }, "log")),
    "Member edge-1 removed.",
  );
  assertEquals(
    JSON.parse(captured(() => renderMemberRemove({ member: removed }, "json"))),
    { member: removed },
  );
});

Deno.test("renderMemberList and renderMemberGet: ages are read against the hub's time, in the largest unit, and a later time is never just now", () => {
  const hubNow = new Date(NOW).toISOString();
  const skewed = NOW + 50 * 60 * 60 * 1000;
  const list = captured(() =>
    renderMemberList({ members: [MEMBER], now: hubNow }, "log", skewed)
  );
  assertStringIncludes(list, "online  4s ago");
  const days = captured(() =>
    renderMemberList(
      {
        members: [MEMBER],
        now: new Date(NOW + 50 * 60 * 60 * 1000).toISOString(),
      },
      "log",
    )
  );
  assertStringIncludes(days, "online  2d ago");
  const behind = captured(() =>
    renderMemberGet(
      { member: MEMBER, now: new Date(NOW - 60_000).toISOString() },
      "log",
    )
  );
  assertStringIncludes(behind, "Last seen: in 56s");
});

Deno.test("renderMemberList: a last-seen time that does not parse shows '-', never 0s ago", () => {
  const list = captured(() =>
    renderMemberList(
      {
        members: [{
          ...MEMBER,
          live: { lastSeenAt: "garbage", instances: [] },
        }],
      },
      "log",
      NOW,
    )
  );
  assertEquals(list.includes("0s ago"), false);
  assertEquals(list.split("\n")[1].split(/\s{2,}/)[3], "-");
});

Deno.test("renderMemberList and renderMemberGet: a fingerprint value this swamp does not define prints as written in both modes", () => {
  const later = ServeMember.join({
    memberId: crypto.randomUUID(),
    name: MemberName.create("edge-9"),
    role: "member",
    fingerprint: Fingerprint.fromWire({
      ...sampleFingerprintProps(),
      serveYamlVersion: 3,
      deploymentMode: "edge",
      datastoreFormat: "v4",
      authMode: "mtls",
      federationRole: "relay",
    }),
    now: NOW,
  }).toJSON();
  const member = {
    ...later,
    live: {
      lastSeenAt: new Date(NOW - 4_000).toISOString(),
      instances: [{
        instanceId: INSTANCE,
        lastSeenAt: new Date(NOW - 4_000).toISOString(),
        runtime: {
          team: { role: "observer", nodes: 3 },
          startedAt: null,
          ready: null,
        },
      }],
    },
  };
  const get = captured(() => renderMemberGet({ member }, "log", NOW));
  assertStringIncludes(get, "Mode: edge");
  assertStringIncludes(get, "(v4)");
  assertStringIncludes(get, "Auth mode: mtls");
  assertStringIncludes(get, "observer of 3");
  assertStringIncludes(
    captured(() => renderMemberList({ members: [member] }, "log", NOW)),
    "edge-9",
  );
  assertEquals(
    JSON.parse(captured(() => renderMemberGet({ member }, "json"))),
    { member },
  );
  assertEquals(
    JSON.parse(captured(() => renderMemberList({ members: [member] }, "json"))),
    { members: [member] },
  );
});

Deno.test("renderMemberGet: control characters a member sent in its fingerprint and runtime print escaped, and JSON is unchanged", () => {
  const hostile = {
    ...MEMBER,
    fingerprint: { ...MEMBER.fingerprint, platform: "linux\x1b[2J" },
    live: {
      ...MEMBER.live,
      instances: [{
        ...MEMBER.live.instances[0],
        runtime: {
          team: { role: "leader\x07", nodes: 2 },
          startedAt: null,
          ready: true,
        },
      }],
    },
  };
  const out = captureRaw(() =>
    renderMemberGet({ member: hostile }, "log", NOW)
  );
  assertNoControlCharacters(out);
  assertStringIncludes(stripAnsiCode(out), "Platform: linux\\x1b[2J/");
  assertStringIncludes(stripAnsiCode(out), "leader\\x07 of 2");
  const json = captureRaw(() => renderMemberGet({ member: hostile }, "json"));
  assertEquals(json, JSON.stringify({ member: hostile }, null, 2));
});

Deno.test("renderMemberList: an escaped swampVersion keeps the columns after it aligned", () => {
  const hostile = {
    ...MEMBER,
    fingerprint: { ...MEMBER.fingerprint, swampVersion: "1.0\x07" },
  };
  const out = captureRaw(() =>
    renderMemberList({ members: [hostile] }, "log", NOW)
  );
  assertNoControlCharacters(out);
  const [header, row] = stripAnsiCode(out).split("\n");
  assertStringIncludes(row, "1.0\\x07");
  assertEquals(row.indexOf(hostile.joinedAt), header.indexOf("JOINED"));
});
