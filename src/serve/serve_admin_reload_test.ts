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
import { planAdminReload } from "./serve_admin_reload.ts";

const identity = (entry: string) => entry;

Deno.test("planAdminReload: removing an admin takes their subject out of force", () => {
  const plan = planAdminReload({
    configuredBefore: ["user:alice", "user:bob"],
    configuredAfter: ["user:alice"],
    inForce: ["user:alice", "user:bob"],
    subjectOf: identity,
  });
  assertEquals(plan.inForce, ["user:alice"]);
  assertEquals(plan.removedSubjects, ["user:bob"]);
  assertEquals(plan.configured, ["user:alice"]);
  assertEquals(plan.waiting, []);
});

Deno.test("planAdminReload: adding an admin waits for a restart and changes nothing in force", () => {
  const plan = planAdminReload({
    configuredBefore: ["user:alice"],
    configuredAfter: ["user:alice", "user:carol"],
    inForce: ["user:alice"],
    subjectOf: identity,
  });
  assertEquals(plan.inForce, ["user:alice"]);
  assertEquals(plan.removedSubjects, []);
  assertEquals(plan.configured, ["user:alice"]);
  assertEquals(plan.waiting, ["user:carol"]);
  assertEquals(plan.waitingSubjects, ["user:carol"]);
});

Deno.test("planAdminReload: a swap removes one admin and leaves the other waiting, even with none left in force", () => {
  const plan = planAdminReload({
    configuredBefore: ["user:alice"],
    configuredAfter: ["user:bob"],
    inForce: ["user:alice"],
    subjectOf: identity,
  });
  assertEquals(plan.inForce, []);
  assertEquals(plan.removedSubjects, ["user:alice"]);
  assertEquals(plan.waiting, ["user:bob"]);
});

Deno.test("planAdminReload: an OAuth name maps to the subject startup resolved it to", () => {
  const subjects: Record<string, string> = {
    alice: "user:sub-a",
    bob: "user:sub-b",
  };
  const plan = planAdminReload({
    configuredBefore: ["alice", "bob", "ghost"],
    configuredAfter: ["alice"],
    inForce: ["user:sub-a", "user:sub-b"],
    subjectOf: (entry) => subjects[entry],
  });
  // ghost never resolved, so it was never in force and revokes nothing
  assertEquals(plan.removedSubjects, ["user:sub-b"]);
  assertEquals(plan.inForce, ["user:sub-a"]);
  assertEquals(plan.configured, ["alice"]);
});

Deno.test("planAdminReload: a subject another kept entry still names stays in force", () => {
  const subjects: Record<string, string> = {
    alice: "user:sub-a",
    "user:alice": "user:sub-a",
  };
  const plan = planAdminReload({
    configuredBefore: ["alice", "user:alice"],
    configuredAfter: ["user:alice"],
    inForce: ["user:sub-a"],
    subjectOf: (entry) => subjects[entry],
  });
  assertEquals(plan.removedSubjects, []);
  assertEquals(plan.inForce, ["user:sub-a"]);
});

Deno.test("planAdminReload: group and idp-group admins are removed by their own entry", () => {
  const plan = planAdminReload({
    configuredBefore: ["group:ops", "idp-group:sre", "user:alice"],
    configuredAfter: ["user:alice"],
    inForce: ["group:ops", "idp-group:sre", "user:alice"],
    subjectOf: identity,
  });
  assertEquals(plan.removedSubjects, ["group:ops", "idp-group:sre"]);
  assertEquals(plan.inForce, ["user:alice"]);
});

Deno.test("planAdminReload: an unchanged list changes nothing", () => {
  const plan = planAdminReload({
    configuredBefore: ["user:alice"],
    configuredAfter: ["user:alice"],
    inForce: ["user:alice"],
    subjectOf: identity,
  });
  assertEquals(plan.removedSubjects, []);
  assertEquals(plan.waiting, []);
  assertEquals(plan.inForce, ["user:alice"]);
});
