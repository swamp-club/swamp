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
  type ExtensionIdentity,
  ExtensionReplacement,
} from "./extension_replacement.ts";

function id(
  version: string,
  publishedChannel: string | null = "stable",
  channel: string | null = "stable",
): ExtensionIdentity {
  return { version, channel, publishedChannel };
}

Deno.test("ExtensionReplacement.create: a newer incoming version is an upgrade", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.09.23.1"),
    incoming: id("2026.10.01.1"),
  });
  assertEquals(r.change, "upgrade");
  assertEquals(r.channelChanged, false);
});

Deno.test("ExtensionReplacement.create: an older incoming version is a downgrade", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.10.01.1"),
    incoming: id("2026.09.01.1"),
  });
  assertEquals(r.change, "downgrade");
});

Deno.test("ExtensionReplacement.create: the same version is same", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.10.01.1"),
    incoming: id("2026.10.01.1"),
  });
  assertEquals(r.change, "same");
});

Deno.test("ExtensionReplacement.create: the micro counter orders versions on one day", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.10.01.2"),
    incoming: id("2026.10.01.10"),
  });
  assertEquals(r.change, "upgrade");
});

Deno.test("ExtensionReplacement.create: differing published channels are a channel change", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.09.23.1", "stable"),
    incoming: id("2026.10.01.1", "beta"),
  });
  assertEquals(r.change, "upgrade");
  assertEquals(r.channelChanged, true);
});

Deno.test("ExtensionReplacement.create: differing followed channels alone are not a channel change", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.09.23.1", "beta", "stable"),
    incoming: id("2026.10.01.1", "beta", "beta"),
  });
  assertEquals(r.channelChanged, false);
});

Deno.test("ExtensionReplacement.create: an unknown current version is unknown", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: null,
    incoming: id("2026.10.01.1", "beta"),
  });
  assertEquals(r.current, null);
  assertEquals(r.change, "unknown");
  assertEquals(r.channelChanged, false);
});

Deno.test("ExtensionReplacement.create: an unknown published channel is never a channel change", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.09.23.1", null, null),
    incoming: id("2026.10.01.1", "beta"),
  });
  assertEquals(r.change, "upgrade");
  assertEquals(r.channelChanged, false);
});

Deno.test("ExtensionReplacement.create: an installed version that is not CalVer is unknown", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("\u001b[31mevil"),
    incoming: id("2026.10.01.1"),
  });
  assertEquals(r.current, null);
  assertEquals(r.change, "unknown");
});

Deno.test("ExtensionReplacement.create: a channel that is not a release channel is dropped", () => {
  const r = ExtensionReplacement.create({
    name: "@a/b",
    current: id("2026.09.23.1", "nightly", "nightly"),
    incoming: id("2026.10.01.1", "beta"),
  });
  assertEquals(r.current?.publishedChannel, null);
  assertEquals(r.current?.channel, null);
  assertEquals(r.channelChanged, false);
});
