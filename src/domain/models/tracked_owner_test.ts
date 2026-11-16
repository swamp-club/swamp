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
  type JudgingProcess,
  type OwnerProbe,
  trackedOwnerGone,
  type TrackedOwnerRow,
} from "./tracked_owner.ts";

const SELF_PID = 2;
const OTHER_PID = 4242;

function self(
  overrides: Partial<JudgingProcess> = {},
  probe: OwnerProbe = { present: true, zombie: false, startTime: "t-other" },
): JudgingProcess {
  return {
    pid: SELF_PID,
    startTime: "t-self",
    instanceId: "serve-now",
    probe: () => probe,
    ...overrides,
  };
}

function row(overrides: Partial<TrackedOwnerRow> = {}): TrackedOwnerRow {
  return {
    pid: SELF_PID,
    ownerStartTime: "t-self",
    instanceId: "serve-now",
    ...overrides,
  };
}

Deno.test("trackedOwnerGone: this process's pid and start time is this process", () => {
  assertEquals(trackedOwnerGone(row(), self()), false);
  assertEquals(
    trackedOwnerGone(row({ instanceId: "serve-before" }), self()),
    false,
  );
});

Deno.test("trackedOwnerGone: this process's pid under another start time is a predecessor", () => {
  assertEquals(
    trackedOwnerGone(row({ ownerStartTime: "t-before" }), self()),
    true,
  );
});

Deno.test("trackedOwnerGone: a row with no start time under this pid is judged by instance id", () => {
  const legacy = (instanceId: string | undefined) =>
    row({ ownerStartTime: null, instanceId });
  assertEquals(trackedOwnerGone(legacy("serve-before"), self()), true);
  assertEquals(trackedOwnerGone(legacy("serve-now"), self()), false);
  assertEquals(trackedOwnerGone(legacy(undefined), self()), false);
  assertEquals(
    trackedOwnerGone(legacy("serve-before"), self({ instanceId: undefined })),
    false,
  );
});

Deno.test("trackedOwnerGone: this pid with an unreadable own start time never judges a stamped row by instance id", () => {
  assertEquals(
    trackedOwnerGone(
      row({ ownerStartTime: "t-before", instanceId: "serve-before" }),
      self({ startTime: undefined }),
    ),
    false,
  );
});

Deno.test("trackedOwnerGone: another pid is gone when absent or a zombie", () => {
  const other = row({ pid: OTHER_PID, ownerStartTime: "t-other" });
  assertEquals(
    trackedOwnerGone(other, self({}, { present: false, zombie: false })),
    true,
  );
  assertEquals(
    trackedOwnerGone(
      other,
      self({}, { present: true, zombie: true, startTime: "t-other" }),
    ),
    true,
  );
});

Deno.test("trackedOwnerGone: another pid now held by a later process is gone", () => {
  assertEquals(
    trackedOwnerGone(
      row({ pid: OTHER_PID, ownerStartTime: "t-before" }),
      self(),
    ),
    true,
  );
  assertEquals(
    trackedOwnerGone(
      row({ pid: OTHER_PID, ownerStartTime: "t-other" }),
      self(),
    ),
    false,
  );
});

Deno.test("trackedOwnerGone: an unreadable start time on either side leaves presence to decide", () => {
  assertEquals(
    trackedOwnerGone(row({ pid: OTHER_PID, ownerStartTime: null }), self()),
    false,
  );
  assertEquals(
    trackedOwnerGone(
      row({ pid: OTHER_PID, ownerStartTime: "t-before" }),
      self({}, { present: true, zombie: false }),
    ),
    false,
  );
});
