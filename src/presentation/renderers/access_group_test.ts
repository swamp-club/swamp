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
import {
  createAccessGroupIdpRenderer,
  createAccessGroupListRenderer,
} from "./access_group.ts";
import type { Group } from "../../domain/models/access/group_model.ts";
import type { AccessGroupIdpEntry } from "../../serve/protocol.ts";

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    name: "release-managers",
    members: [{ kind: "user", id: "adam" }],
    createdBy: { kind: "user", id: "local" },
    createdAt: "2026-06-18T00:00:00Z",
    ...overrides,
  };
}

Deno.test("accessGroupListRenderer log: shows header", () => {
  const renderer = createAccessGroupListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([makeGroup()]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "NAME");
  assertStringIncludes(output[0], "MEMBERS");
});

Deno.test("accessGroupListRenderer log: shows group data", () => {
  const renderer = createAccessGroupListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([makeGroup()]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[1], "release-managers");
  assertStringIncludes(output[1], "1");
});

Deno.test("accessGroupListRenderer log: shows empty message", () => {
  const renderer = createAccessGroupListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "No groups found");
});

Deno.test("accessGroupListRenderer log: shows members", () => {
  const renderer = createAccessGroupListRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderMembers(makeGroup());
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "release-managers");
  assertStringIncludes(output[1], "user:adam");
});

Deno.test("accessGroupListRenderer json: outputs JSON array", () => {
  const renderer = createAccessGroupListRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([makeGroup()]);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join(""));
  assertStringIncludes(parsed[0].name, "release-managers");
});

// ── IdP group renderer tests ─────────────────────────────────────────

function makeIdpEntry(
  overrides: Partial<AccessGroupIdpEntry> = {},
): AccessGroupIdpEntry {
  return {
    name: "platform-eng",
    activeTokenCount: 3,
    lastSeenAt: "2026-08-10T12:00:00Z",
    ...overrides,
  };
}

Deno.test("accessGroupIdpRenderer log: shows header and data", () => {
  const renderer = createAccessGroupIdpRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([makeIdpEntry()]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "GROUP");
  assertStringIncludes(output[0], "ACTIVE TOKENS");
  assertStringIncludes(output[0], "LAST SEEN");
  assertStringIncludes(output[1], "platform-eng");
  assertStringIncludes(output[1], "3");
  assertStringIncludes(output[1], "2026-08-10");
});

Deno.test("accessGroupIdpRenderer log: shows empty message", () => {
  const renderer = createAccessGroupIdpRenderer("log");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([]);
  } finally {
    console.log = origLog;
  }
  assertStringIncludes(output[0], "No IdP groups found");
});

Deno.test("accessGroupIdpRenderer json: outputs JSON array", () => {
  const renderer = createAccessGroupIdpRenderer("json");
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.renderList([makeIdpEntry(), makeIdpEntry({ name: "ops-team" })]);
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output.join("")) as AccessGroupIdpEntry[];
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].name, "platform-eng");
  assertEquals(parsed[1].name, "ops-team");
});
