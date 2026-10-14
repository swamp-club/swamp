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
  behaviorTwinPath,
  isBehaviorGroupWord,
  isMethodLevelWord,
} from "./behavior_twin.ts";

Deno.test("behaviorTwinPath: adds the method level for run, describe and history", () => {
  assertEquals(behaviorTwinPath(["behavior", "run"]), [
    "model",
    "method",
    "run",
  ]);
  assertEquals(behaviorTwinPath(["behavior", "describe"]), [
    "model",
    "method",
    "describe",
  ]);
  assertEquals(behaviorTwinPath(["behavior", "history", "search"]), [
    "model",
    "method",
    "history",
    "search",
  ]);
});

Deno.test("behaviorTwinPath: maps every other word directly", () => {
  assertEquals(behaviorTwinPath(["behavior"]), ["model"]);
  assertEquals(behaviorTwinPath(["behavior", "create"]), ["model", "create"]);
  assertEquals(behaviorTwinPath(["behavior", "output", "search"]), [
    "model",
    "output",
    "search",
  ]);
  assertEquals(behaviorTwinPath(["behavior", "type", "describe"]), [
    "model",
    "type",
    "describe",
  ]);
});

Deno.test("behaviorTwinPath: treats behaviour like behavior", () => {
  assertEquals(behaviorTwinPath(["behaviour", "run"]), [
    "model",
    "method",
    "run",
  ]);
  assertEquals(behaviorTwinPath(["behaviour", "get"]), ["model", "get"]);
});

Deno.test("behaviorTwinPath: returns other paths unchanged as a copy", () => {
  for (
    const path of [
      [],
      ["model", "method", "run"],
      ["workflow", "run"],
      ["help", "behavior"],
      ["behaviors", "run"],
    ]
  ) {
    const twin = behaviorTwinPath(path);
    assertEquals(twin, path);
    assertEquals(twin === path, false);
  }
});

Deno.test("isBehaviorGroupWord: accepts only the group name and its alias", () => {
  assertEquals(isBehaviorGroupWord("behavior"), true);
  assertEquals(isBehaviorGroupWord("behaviour"), true);
  assertEquals(isBehaviorGroupWord("model"), false);
  assertEquals(isBehaviorGroupWord("behaviors"), false);
  assertEquals(isBehaviorGroupWord(undefined), false);
});

Deno.test("isMethodLevelWord: accepts only run, describe and history", () => {
  assertEquals(isMethodLevelWord("run"), true);
  assertEquals(isMethodLevelWord("describe"), true);
  assertEquals(isMethodLevelWord("history"), true);
  assertEquals(isMethodLevelWord("get"), false);
  assertEquals(isMethodLevelWord("method"), false);
  assertEquals(isMethodLevelWord(undefined), false);
});
