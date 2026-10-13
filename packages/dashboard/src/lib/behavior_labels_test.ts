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
  ALL_BEHAVIORS_LABEL,
  BEHAVIOR_COLUMN,
  behaviorNoun,
  BEHAVIORS_LABEL,
  NO_BEHAVIORS_TITLE,
} from "./behavior_labels.ts";

Deno.test("behavior labels: the dashboards say behavior, not model", () => {
  assertEquals(BEHAVIORS_LABEL, "Behaviors");
  assertEquals(NO_BEHAVIORS_TITLE, "No behaviors defined yet");
  assertEquals(ALL_BEHAVIORS_LABEL, "All behaviors");
  assertEquals(BEHAVIOR_COLUMN, "Behavior");
  for (
    const label of [
      BEHAVIORS_LABEL,
      NO_BEHAVIORS_TITLE,
      ALL_BEHAVIORS_LABEL,
      BEHAVIOR_COLUMN,
    ]
  ) {
    assertEquals(/model/i.test(label), false, label);
  }
});

Deno.test("behaviorNoun: singular for one, plural otherwise", () => {
  assertEquals(behaviorNoun(0), "behaviors");
  assertEquals(behaviorNoun(1), "behavior");
  assertEquals(behaviorNoun(2), "behaviors");
});
