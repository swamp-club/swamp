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
import { sampleFingerprint } from "./federation_test_helpers.ts";
import { InstanceId } from "./instance_id.ts";
import { MemberName } from "./member_name.ts";
import { MemberRoster } from "./member_roster.ts";
import { ServeMember } from "./serve_member.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function member(name: string, role: "member" | "hub" = "member"): ServeMember {
  return ServeMember.join({
    memberId: crypto.randomUUID(),
    name: MemberName.create(name),
    role,
    fingerprint: sampleFingerprint(),
    now: NOW,
  });
}

Deno.test("MemberRoster.isNameTaken: a live member holds its name, a removed one frees it", () => {
  const live = member("edge");
  const gone = member("old").remove(NOW).member;
  const roster = new MemberRoster([live, gone]);
  assertEquals(roster.isNameTaken(MemberName.create("edge")), true);
  assertEquals(roster.isNameTaken(MemberName.create("old")), false);
});

Deno.test("MemberRoster.isNameTaken: the hub's name, with or without its record", () => {
  assertEquals(
    new MemberRoster([member("core", "hub")]).isNameTaken(
      MemberName.create("core"),
    ),
    true,
  );
  assertEquals(
    new MemberRoster([], "hub").isNameTaken(MemberName.create("hub")),
    true,
  );
});

Deno.test("MemberRoster.duplicateLiveNames: reports two live records of one name", () => {
  const a = member("edge");
  const b = member("edge");
  assertEquals(MemberRoster.duplicateLiveNames([a, b]), ["edge"]);
  assertEquals(
    MemberRoster.duplicateLiveNames([a, b.remove(NOW).member]),
    [],
  );
});

Deno.test("MemberRoster: a removed member's record does not block the name after check-ins", () => {
  const id = InstanceId.create(crypto.randomUUID());
  const checked = member("edge").checkIn(id, sampleFingerprint(), NOW);
  if (!checked.ok) throw new Error(checked.refusal);
  const roster = new MemberRoster([checked.member.remove(NOW).member]);
  assertEquals(roster.isNameTaken(MemberName.create("edge")), false);
});
