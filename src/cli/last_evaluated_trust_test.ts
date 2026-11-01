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
import { UserError } from "../domain/errors.ts";
import {
  EVALUATION_OTHER_WRITER,
  type EvaluationTrust,
} from "../infrastructure/datastore_v3/trusted_evaluations.ts";
import {
  type LastEvaluatedDeps,
  lastEvaluatedStands,
} from "./last_evaluated_trust.ts";

const REPOS = {} as Parameters<typeof lastEvaluatedStands>[1];
const TRUST = {} as EvaluationTrust;

function deps(
  fields: Partial<LastEvaluatedDeps> & { seen?: string[] } = {},
): LastEvaluatedDeps {
  return {
    upstream: () => Promise.resolve("https://serve.example"),
    principal: () => Promise.resolve("user:ana"),
    trust: (_repo, _repos, own) => {
      fields.seen?.push(own);
      return Promise.resolve(TRUST);
    },
    ...fields,
  };
}

/** What `fn` writes to stderr with console.error, while it runs. */
async function stderrOf<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const written: string[] = [];
  const original = console.error;
  console.error = (line: string) => written.push(line);
  try {
    return [await fn(), written];
  } finally {
    console.error = original;
  }
}

Deno.test("lastEvaluatedStands: a checkout not written through serve stands without reading", async () => {
  let read = false;
  assertEquals(
    await lastEvaluatedStands("/r", REPOS, "log", () => {
      read = true;
      return Promise.resolve();
    }, deps({ upstream: () => Promise.resolve(undefined) })),
    true,
  );
  assertEquals(read, false);
});

Deno.test("lastEvaluatedStands: an evaluation the trust vouches for stands, read as this member", async () => {
  const seen: string[] = [];
  assertEquals(
    await lastEvaluatedStands(
      "/r",
      REPOS,
      "json",
      () => Promise.resolve(),
      deps({ seen }),
    ),
    true,
  );
  assertEquals(seen, ["user:ana"]);
});

Deno.test("lastEvaluatedStands: a member it cannot name takes the strict path, never serve's", async () => {
  for (const principal of [undefined, ""]) {
    const seen: string[] = [];
    await lastEvaluatedStands(
      "/r",
      REPOS,
      "log",
      () => Promise.resolve(),
      deps({ seen, principal: () => Promise.resolve(principal) }),
    );
    assertEquals(seen, [""]);
  }
});

Deno.test("lastEvaluatedStands: in JSON mode a refused evaluation is an event naming its cause and the dropped inputs", async () => {
  const [stands, written] = await stderrOf(() =>
    lastEvaluatedStands(
      "/r",
      REPOS,
      "json",
      () =>
        Promise.reject(
          new UserError("Another member wrote it.", EVALUATION_OTHER_WRITER),
        ),
      deps(),
    )
  );
  assertEquals(stands, false);
  assertEquals(written.length, 1);
  const event = JSON.parse(written[0]);
  assertEquals(event.event, "last_evaluated_set_aside");
  assertEquals(event.inputsReplayed, false);
  assertStringIncludes(event.reason, "Evaluate it from this checkout");
});

Deno.test("lastEvaluatedStands: the advice fits the cause, and a read that fails evaluates again", async () => {
  const [unknownMember, written] = await stderrOf(() =>
    lastEvaluatedStands(
      "/r",
      REPOS,
      "json",
      () =>
        Promise.reject(
          new UserError("Another member wrote it.", EVALUATION_OTHER_WRITER),
        ),
      deps({ principal: () => Promise.resolve(undefined) }),
    )
  );
  assertEquals(unknownMember, false);
  assertStringIncludes(
    JSON.parse(written[0]).reason,
    "token from the environment",
  );

  const [failed, failure] = await stderrOf(() =>
    lastEvaluatedStands(
      "/r",
      REPOS,
      "json",
      () => Promise.reject(new Error("disk full")),
      deps(),
    )
  );
  assertEquals(failed, false);
  assertStringIncludes(JSON.parse(failure[0]).reason, "Could not check");
  assertStringIncludes(JSON.parse(failure[0]).reason, "disk full");
});

Deno.test("lastEvaluatedStands: in log mode it prints no JSON", async () => {
  const [stands, written] = await stderrOf(() =>
    lastEvaluatedStands(
      "/r",
      REPOS,
      "log",
      () => Promise.reject(new Error("disk full")),
      deps(),
    )
  );
  assertEquals(stands, false);
  assertEquals(written, []);
});
