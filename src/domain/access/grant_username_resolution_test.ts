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
import type { ParsedGrantFileEntry } from "./grant_file.ts";
import {
  grantFileUsernames,
  type GrantUsernameResolver,
  type ParsedGrantSource,
  resolveGrantFileUsernames,
  unresolvableUsernames,
  type UsernameLookup,
  type UsernameResolutionRequest,
} from "./grant_username_resolution.ts";

function entry(
  subject: ParsedGrantFileEntry["subject"],
  effect: "allow" | "deny" = "allow",
): ParsedGrantFileEntry {
  return {
    subject,
    effect,
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
  };
}

/** A resolver answering from a fixed table, recording each request. */
function tableResolver(table: Record<string, string>) {
  const requests: UsernameResolutionRequest[] = [];
  const resolver: GrantUsernameResolver = {
    resolve(request) {
      requests.push(request);
      return Promise.resolve(
        new Map<string, UsernameLookup>(
          request.names.map((name) => [
            name,
            Object.hasOwn(table, name)
              ? { status: "resolved", sub: table[name] }
              : { status: "unresolved", message: "not found" },
          ]),
        ),
      );
    },
  };
  return { resolver, requests };
}

function sources(
  ...files: [string, ParsedGrantFileEntry[]][]
): Map<string, ParsedGrantSource> {
  return new Map(
    files.map(([name, entries]) => [name, { filename: name, entries }]),
  );
}

Deno.test("resolveGrantFileUsernames: a username becomes user:<sub>", async () => {
  const { resolver } = tableResolver({ alice: "sub-alice" });
  const result = await resolveGrantFileUsernames(
    sources(["team.yaml", [
      entry({ kind: "username", name: "alice" }),
      entry({ kind: "group", name: "ops" }),
    ]]),
    resolver,
    { complete: true },
  );
  const team = result.sources.get("team.yaml")!;
  assertEquals(team.errors, []);
  assertEquals(team.entries.map((e) => e.subject), [
    { kind: "user", name: "sub-alice" },
    { kind: "group", name: "ops" },
  ]);
  assertEquals({ ...result.usernamesBySub }, { "sub-alice": "alice" });
});

Deno.test("resolveGrantFileUsernames: an unresolved name rejects the whole file, deny included", async () => {
  const { resolver } = tableResolver({ alice: "sub-alice" });
  const result = await resolveGrantFileUsernames(
    sources(
      ["team.yaml", [
        entry({ kind: "username", name: "alice" }),
        entry({ kind: "username", name: "mallory" }, "deny"),
        entry({ kind: "username", name: "mallory" }),
      ]],
      ["other.yaml", [entry({ kind: "username", name: "alice" })]],
    ),
    resolver,
    { complete: true },
  );
  const team = result.sources.get("team.yaml")!;
  assertEquals(team.entries, []);
  // One error per name, however many entries name it.
  assertEquals(team.errors.length, 1);
  assertEquals(team.errors[0].filename, "team.yaml");
  assertStringIncludes(team.errors[0].message, 'Subject "username:mallory"');
  assertStringIncludes(team.errors[0].message, "not found");
  assertEquals(result.sources.get("other.yaml")!.errors, []);
});

Deno.test("resolveGrantFileUsernames: a username and its sub in one file are a duplicate", async () => {
  const { resolver } = tableResolver({ alice: "sub-alice" });
  const result = await resolveGrantFileUsernames(
    sources(["team.yaml", [
      entry({ kind: "user", name: "sub-alice" }),
      entry({ kind: "username", name: "alice" }),
    ]]),
    resolver,
    { complete: true },
  );
  const team = result.sources.get("team.yaml")!;
  assertEquals(team.entries, []);
  assertStringIncludes(team.errors[0].message, "Duplicate grant entry");
});

Deno.test("resolveGrantFileUsernames: two usernames for one account are a duplicate", async () => {
  const { resolver } = tableResolver({ alice: "sub-a", "alice-old": "sub-a" });
  const result = await resolveGrantFileUsernames(
    sources(["team.yaml", [
      entry({ kind: "username", name: "alice" }),
      entry({ kind: "username", name: "alice-old" }),
    ]]),
    resolver,
    { complete: true },
  );
  assertStringIncludes(
    result.sources.get("team.yaml")!.errors[0].message,
    "resolves to user:sub-a",
  );
});

Deno.test("resolveGrantFileUsernames: asks once for every name, passing complete through", async () => {
  const { resolver, requests } = tableResolver({});
  await resolveGrantFileUsernames(
    sources(
      ["a.yaml", [entry({ kind: "username", name: "x" })]],
      ["b.yaml", [
        entry({ kind: "username", name: "x" }, "deny"),
        entry({ kind: "username", name: "y" }),
      ]],
    ),
    resolver,
    { complete: false },
  );
  assertEquals(requests, [{ names: ["x", "y"], complete: false }]);
});

Deno.test("resolveGrantFileUsernames: files without usernames pass through unchanged", async () => {
  const result = await resolveGrantFileUsernames(
    sources(["team.yaml", [entry({ kind: "user", name: "sub-1" })]]),
    unresolvableUsernames("unused"),
    { complete: true },
  );
  assertEquals(result.sources.get("team.yaml")!.entries, [
    entry({ kind: "user", name: "sub-1" }),
  ]);
});

Deno.test("unresolvableUsernames: rejects every name with its message", async () => {
  const result = await resolveGrantFileUsernames(
    sources(["team.yaml", [entry({ kind: "username", name: "alice" })]]),
    unresolvableUsernames("username subjects need --auth-mode oauth"),
    { complete: true },
  );
  assertStringIncludes(
    result.sources.get("team.yaml")!.errors[0].message,
    "need --auth-mode oauth",
  );
});

Deno.test("grantFileUsernames: lists each name once in first-seen order", () => {
  assertEquals(
    grantFileUsernames([
      entry({ kind: "username", name: "b" }),
      entry({ kind: "user", name: "b" }),
      entry({ kind: "username", name: "a" }),
      entry({ kind: "username", name: "b" }),
    ]),
    ["b", "a"],
  );
});
