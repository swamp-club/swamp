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
import { entryIdentityKey, parseGrantFile } from "./grant_file.ts";
import {
  type GrantUsernameResolver,
  resolveGrantFileUsernames,
  type UsernameLookup,
} from "./grant_username_resolution.ts";

const arbName = fc.stringOf(
  fc.constantFrom(..."abcdef0123-_.".split("")),
  { minLength: 1, maxLength: 8 },
);

/** Subjects written as username:<name> or user:<sub>, never naming one twice. */
const arbSubjects = fc.uniqueArray(
  fc.tuple(fc.boolean(), arbName),
  { minLength: 1, maxLength: 8, selector: ([, name]) => name },
);

function resolverFor(subs: ReadonlyMap<string, string>): GrantUsernameResolver {
  return {
    resolve: ({ names }) =>
      Promise.resolve(
        new Map<string, UsernameLookup>(
          names.map((name) => [
            name,
            subs.has(name)
              ? { status: "resolved", sub: subs.get(name)! }
              : { status: "unresolved", message: "not found" },
          ]),
        ),
      ),
  };
}

function grantFile(subjects: string[]): string {
  return `grants:
  - subjects: [${subjects.map((s) => JSON.stringify(s)).join(", ")}]
    effect: deny
    actions: [read, run]
    resource: "workflow:*"
`;
}

Deno.test("resolveGrantFileUsernames: a resolved file grants exactly what the same file written with subs grants", async () => {
  await fc.assert(
    fc.asyncProperty(arbSubjects, async (subjects) => {
      // Each name resolves to its own sub, so no two entries collide.
      const subs = new Map(subjects.map(([, name]) => [name, `sub-${name}`]));
      const written = subjects.map(([asUsername, name]) =>
        asUsername ? `username:${name}` : `user:sub-${name}`
      );
      const parsed = parseGrantFile("team.yaml", grantFile(written));
      assertEquals(parsed.errors, []);
      const resolved = await resolveGrantFileUsernames(
        new Map([["team.yaml", { filename: "team.yaml", ...parsed }]]),
        resolverFor(subs),
        { complete: true },
      );

      const direct = parseGrantFile(
        "team.yaml",
        grantFile(subjects.map(([, name]) => `user:sub-${name}`)),
      );
      const team = resolved.sources.get("team.yaml")!;
      assertEquals(team.errors, []);
      assertEquals(
        team.entries.map(entryIdentityKey),
        direct.entries.map(entryIdentityKey),
      );
    }),
  );
});

Deno.test("resolveGrantFileUsernames: any unresolved name rejects its whole file", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSubjects,
      fc.nat(),
      async (subjects, pick) => {
        const usernames = subjects.filter(([asUsername]) => asUsername);
        fc.pre(usernames.length > 0);
        const missing = usernames[pick % usernames.length][1];
        const subs = new Map(
          subjects.filter(([, name]) => name !== missing)
            .map(([, name]) => [name, `sub-${name}`]),
        );
        const parsed = parseGrantFile(
          "team.yaml",
          grantFile(
            subjects.map(([asUsername, name]) =>
              asUsername ? `username:${name}` : `user:sub-${name}`
            ),
          ),
        );
        const resolved = await resolveGrantFileUsernames(
          new Map([["team.yaml", { filename: "team.yaml", ...parsed }]]),
          resolverFor(subs),
          { complete: true },
        );
        const team = resolved.sources.get("team.yaml")!;
        assertEquals(team.entries, []);
        assert(
          team.errors.some((e) => e.message.includes(`username:${missing}"`)),
        );
      },
    ),
  );
});

Deno.test("resolveGrantFileUsernames: a username resolving to a sub the file also names is always a duplicate", async () => {
  await fc.assert(
    fc.asyncProperty(arbName, arbName, async (name, sub) => {
      const parsed = parseGrantFile(
        "team.yaml",
        grantFile([`user:${sub}`, `username:${name}`]),
      );
      const resolved = await resolveGrantFileUsernames(
        new Map([["team.yaml", { filename: "team.yaml", ...parsed }]]),
        resolverFor(new Map([[name, sub]])),
        { complete: true },
      );
      const team = resolved.sources.get("team.yaml")!;
      assertEquals(team.entries, []);
      assert(team.errors[0].message.startsWith("Duplicate grant entry"));
    }),
  );
});
