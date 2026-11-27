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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { sampleFingerprintProps } from "../../domain/serve/federation_test_helpers.ts";
import type { HubLinkState, HubLinkView } from "../../domain/serve/hub_link.ts";
import {
  renderMemberGet,
  renderMemberList,
  renderMemberRemove,
} from "./serve_member_output.ts";
import { renderHubForget, renderHubLink } from "./serve_hub_output.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

type Member = Parameters<typeof renderMemberGet>[0]["member"];

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;title\x07"),
    fc.fullUnicode(),
  ),
});

const memberArb = fc.record({
  name: text,
  role: text,
  status: text,
  memberId: text,
  joinedAt: text,
  removedAt: text,
  swampVersion: text,
  platform: text,
  arch: text,
  deploymentMode: text,
  datastoreKind: text,
  datastoreFormat: text,
  authMode: text,
  instanceId: text,
  instanceVersion: text,
  firstSeen: text,
  lastSeenAt: text,
  liveInstanceId: text,
  teamRole: text,
  startedAt: text,
});

type MemberFields = typeof memberArb extends fc.Arbitrary<infer T> ? T
  : never;

// the CLI renders a serve's JSON reply, and an older or newer serve may skip the
// validation these types assume, so every field is arbitrary text
function memberOf(m: MemberFields): Member {
  return {
    memberId: m.memberId,
    name: m.name,
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt,
    removedAt: m.removedAt,
    fingerprint: {
      ...sampleFingerprintProps(),
      swampVersion: m.swampVersion,
      platform: m.platform,
      arch: m.arch,
      deploymentMode: m.deploymentMode,
      datastoreKind: m.datastoreKind,
      datastoreFormat: m.datastoreFormat,
      authMode: m.authMode,
    },
    instances: [{
      instanceId: m.instanceId,
      swampVersion: m.instanceVersion,
      firstSeen: m.firstSeen,
    }],
    live: {
      lastSeenAt: m.lastSeenAt,
      instances: [{
        instanceId: m.liveInstanceId,
        lastSeenAt: m.lastSeenAt,
        runtime: {
          team: { role: m.teamRole, nodes: 2 },
          startedAt: m.startedAt,
          ready: true,
        },
      }],
    },
  } as unknown as Member;
}

function assertEscaped(output: string, printed: readonly string[]): void {
  assertNoControlCharacters(output);
  for (const value of printed) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

Deno.test("renderMemberList, renderMemberGet and renderMemberRemove: no member-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(memberArb, (m) => {
      const member = memberOf(m);
      assertEscaped(
        captureRaw(() => renderMemberList({ members: [member] }, "log", NOW)),
        [m.name, m.role, m.status, m.swampVersion, m.joinedAt],
      );
      assertEscaped(
        captureRaw(() => renderMemberGet({ member }, "log", NOW)),
        [
          m.name,
          m.role,
          m.status,
          m.memberId,
          m.joinedAt,
          m.removedAt,
          m.swampVersion,
          m.platform,
          m.arch,
          m.deploymentMode,
          m.datastoreKind,
          m.datastoreFormat,
          m.authMode,
          m.instanceId,
          m.instanceVersion,
          m.firstSeen,
          m.lastSeenAt,
          m.liveInstanceId,
          m.teamRole,
          m.startedAt,
        ],
      );
      assertEscaped(
        captureRaw(() => renderMemberRemove({ member }, "log")),
        [m.name],
      );
    }),
  );
});

const STATES: readonly HubLinkState[] = [
  "joined",
  "joining",
  "unjoined",
  "refused",
  "mismatched",
];

const linkArb = fc.record({
  state: fc.constantFrom(...STATES),
  hubUrl: text,
  configuredHubUrl: text,
  hubName: text,
  memberName: text,
  memberId: text,
  joinedAt: text,
  stoppedId: text,
  stoppedAt: text,
  failingId: text,
  result: text.filter((r) => r !== "ok"),
  lastAttemptAt: text,
  nextAttemptAt: text,
  okId: text,
  lastSuccessAt: text,
  time: text,
});

type LinkFields = typeof linkArb extends fc.Arbitrary<infer T> ? T : never;

function linkOf(l: LinkFields): HubLinkView {
  const instance = {
    startedAt: l.time,
    aliveAt: l.time,
    lastAttemptAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 2,
    nextAttemptAt: null,
    stoppedAt: null,
    result: null,
  };
  return {
    state: l.state,
    hubUrl: l.hubUrl,
    configuredHubUrl: l.configuredHubUrl,
    hubName: l.hubName,
    memberName: l.memberName,
    memberId: l.memberId,
    joinedAt: l.joinedAt,
    instances: [
      { ...instance, instanceId: l.stoppedId, stoppedAt: l.stoppedAt },
      {
        ...instance,
        instanceId: l.failingId,
        result: l.result,
        lastAttemptAt: l.lastAttemptAt,
        nextAttemptAt: l.nextAttemptAt,
      },
      {
        ...instance,
        instanceId: l.okId,
        result: "ok",
        lastSuccessAt: l.lastSuccessAt,
      },
    ],
  };
}

Deno.test("renderHubLink and renderHubForget: no hub-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(linkArb, (l) => {
      assertEscaped(
        captureRaw(() => renderHubLink({ link: linkOf(l) }, "log")),
        [
          l.hubUrl,
          l.configuredHubUrl,
          l.hubName,
          l.memberName,
          l.memberId,
          l.joinedAt,
          l.stoppedId,
          l.stoppedAt,
          l.failingId,
          l.result,
          l.lastAttemptAt,
          l.nextAttemptAt,
          l.okId,
          l.lastSuccessAt,
        ],
      );
      assertEscaped(
        captureRaw(() =>
          renderHubForget(
            { forgot: true, hubUrl: l.hubUrl, memberName: l.memberName },
            "log",
          )
        ),
        [l.hubUrl, l.memberName],
      );
    }),
  );
});

Deno.test("renderMemberGet and renderHubLink: JSON output is the input exactly", () => {
  fc.assert(
    fc.property(memberArb, linkArb, (m, l) => {
      const member = memberOf(m);
      assertEquals(
        JSON.parse(captureRaw(() => renderMemberGet({ member }, "json"))),
        { member },
      );
      const link = linkOf(l);
      assertEquals(
        JSON.parse(captureRaw(() => renderHubLink({ link }, "json"))),
        { link },
      );
    }),
  );
});
