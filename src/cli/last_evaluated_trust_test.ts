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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import {
  EVALUATION_OTHER_WRITER,
  type EvaluationTrust,
} from "../infrastructure/datastore_v3/trusted_evaluations.ts";
import {
  checkLastEvaluation,
  type LastEvaluatedDeps,
} from "./last_evaluated_trust.ts";

const REPOS = {} as Parameters<typeof checkLastEvaluation>[1];
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

Deno.test("checkLastEvaluation: a checkout not written through serve stands without reading", async () => {
  let read = false;
  assertEquals(
    await checkLastEvaluation("/r", REPOS, "log", () => {
      read = true;
      return Promise.resolve(null);
    }, deps({ upstream: () => Promise.resolve(undefined) })),
    { stands: true, vetted: false },
  );
  assertEquals(read, false);
});

Deno.test("checkLastEvaluation: what the trust vouches for is what the run is handed, read as this member", async () => {
  const seen: string[] = [];
  const cache = { name: "checked" };
  assertEquals(
    await checkLastEvaluation(
      "/r",
      REPOS,
      "json",
      () => Promise.resolve(cache),
      deps({ seen }),
    ),
    { stands: true, vetted: true, cache },
  );
  assertEquals(seen, ["user:ana"]);
});

Deno.test("checkLastEvaluation: no evaluation is vetted as none, and an unknown name is left for the run to report", async () => {
  assertEquals(
    await checkLastEvaluation(
      "/r",
      REPOS,
      "json",
      () => Promise.resolve(null),
      deps(),
    ),
    { stands: true, vetted: true, cache: null },
  );
  assertEquals(
    await checkLastEvaluation(
      "/r",
      REPOS,
      "json",
      () => Promise.resolve(undefined),
      deps(),
    ),
    { stands: true, vetted: false },
  );
});

Deno.test("checkLastEvaluation: a refusal the caller raises keeps its code and words", async () => {
  const error = await assertRejects(
    () =>
      checkLastEvaluation(
        "/r",
        REPOS,
        "json",
        () =>
          Promise.reject(
            new UserError("Nothing to replay.", "evaluation_not_checked"),
          ),
        deps(),
      ),
    UserError,
  );
  assertEquals(error.message, "Nothing to replay.");
});

Deno.test("checkLastEvaluation: an evaluation it cannot vouch for keeps its own reason and one next step", async () => {
  const error = await assertRejects(
    () =>
      checkLastEvaluation(
        "/r",
        REPOS,
        "json",
        () =>
          Promise.reject(
            new UserError(
              "It changed while it was read. Run again.",
              "evaluation_not_trusted",
            ),
          ),
        deps(),
      ),
    UserError,
  );
  assertEquals(error.code, "evaluation_not_checked");
  assertStringIncludes(
    error.message,
    "It changed while it was read. Run again.",
  );
  assertEquals(error.message.includes("without --last-evaluated"), false);
});

Deno.test("checkLastEvaluation: a member it cannot name takes the strict path, never serve's", async () => {
  for (const principal of [undefined, ""]) {
    const seen: string[] = [];
    await checkLastEvaluation(
      "/r",
      REPOS,
      "log",
      () => Promise.resolve({}),
      deps({ seen, principal: () => Promise.resolve(principal) }),
    );
    assertEquals(seen, [""]);
  }
});

Deno.test("checkLastEvaluation: in JSON mode a refused evaluation is an event naming its cause and the dropped inputs", async () => {
  const [check, written] = await stderrOf(() =>
    checkLastEvaluation(
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
  assertEquals(check, { stands: false });
  assertEquals(written.length, 1);
  const event = JSON.parse(written[0]);
  assertEquals(event.event, "last_evaluated_set_aside");
  assertEquals(event.inputsReplayed, false);
  assertStringIncludes(event.reason, "Evaluate it from this checkout");
  assertStringIncludes(event.reason, "pass them with --input");
});

Deno.test("checkLastEvaluation: the advice says when the member is unknown", async () => {
  const [check, written] = await stderrOf(() =>
    checkLastEvaluation(
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
  assertEquals(check, { stands: false });
  assertStringIncludes(
    JSON.parse(written[0]).reason,
    "token from the environment",
  );
});

Deno.test("checkLastEvaluation: any other failure refuses, since a fresh evaluation could run different inputs", async () => {
  for (const mode of ["json", "log"] as const) {
    const error = await assertRejects(
      () =>
        checkLastEvaluation(
          "/r",
          REPOS,
          mode,
          () => Promise.reject(new Error("disk full.")),
          deps(),
        ),
      UserError,
    );
    assertStringIncludes(error.message, "disk full. Run again");
  }
});

Deno.test("checkLastEvaluation: in log mode it prints no JSON", async () => {
  const [check, written] = await stderrOf(() =>
    checkLastEvaluation(
      "/r",
      REPOS,
      "log",
      () =>
        Promise.reject(
          new UserError("Another member wrote it.", EVALUATION_OTHER_WRITER),
        ),
      deps(),
    )
  );
  assertEquals(check, { stands: false });
  assertEquals(written, []);
});
