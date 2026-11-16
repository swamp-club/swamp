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

const servePath = new URL("../src/cli/commands/serve.ts", import.meta.url);

function offsetsOf(source: string, needle: string): number[] {
  const offsets: number[] = [];
  for (
    let at = source.indexOf(needle);
    at !== -1;
    at = source.indexOf(needle, at + 1)
  ) {
    offsets.push(at);
  }
  return offsets;
}

Deno.test("serve forwarded prefix: read once, before any WebSocket upgrade closes the request's headers", async () => {
  const source = await Deno.readTextFile(servePath);
  const calls = offsetsOf(source, "forwardedPrefixOf(req");
  assertEquals(calls.length, 1, "forwardedPrefixOf(req ...) call sites");
  const upgrades = offsetsOf(source, "Deno.upgradeWebSocket(");
  assert(upgrades.length > 0);
  const branch = source.lastIndexOf(
    'if (upgrade.toLowerCase() === "websocket") {',
    calls[0],
  );
  assert(branch !== -1, "the read sits inside the WebSocket branch");
  for (const upgrade of upgrades.filter((at) => at > branch)) {
    assert(
      calls[0] < upgrade,
      `forwardedPrefixOf runs after the upgrade at offset ${upgrade}`,
    );
  }
});

Deno.test("serve forwarded prefix: every connection handed to handleConnection gets the value read before the upgrade", async () => {
  const source = await Deno.readTextFile(servePath);
  const sites = offsetsOf(source, "handleConnection(\n");
  assertEquals(sites.length, 3, "handleConnection call sites in serve.ts");
  for (const site of sites) {
    const call = source.slice(site, source.indexOf(");", site));
    assert(
      /,\s*forwardedPrefix,?\s*$/.test(call),
      `handleConnection call at offset ${site} passes something else`,
    );
  }
});
