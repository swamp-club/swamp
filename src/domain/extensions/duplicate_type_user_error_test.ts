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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import { UserError } from "../errors.ts";
import {
  DuplicateTypeUserError,
  type InstallRollbackOutcome,
} from "./duplicate_type_user_error.ts";

const EXISTING = {
  extensionName: "@scopeA/aa",
  extensionVersion: "1.0.0",
  canonicalPath: "/repo/.swamp/pulled-extensions/@scopeA/aa/models/foo.ts",
};
const CONFLICTING = {
  extensionName: "@scopeB/bb",
  extensionVersion: "2.0.0",
  canonicalPath: "/repo/.swamp/pulled-extensions/@scopeB/bb/models/foo.ts",
};

const CLAIMED = `Type "@scope/foo" (kind=model) is already claimed by ` +
  `@scopeA/aa@1.0.0 at ${EXISTING.canonicalPath}.`;
const CONFLICTING_AT = `@scopeB/bb@2.0.0 at ${CONFLICTING.canonicalPath}`;
const RM_RECOVERY =
  "Run `swamp extension rm @scopeA/aa` first if you intended to replace it.";
const GHOST_RECOVERY =
  "Ghost catalog entry detected (source deleted outside swamp). " +
  "Run `swamp doctor extensions` to reclassify and retry.";

function makeError(
  opts: { rollback?: InstallRollbackOutcome; isGhostRow?: boolean } = {},
): DuplicateTypeUserError {
  return new DuplicateTypeUserError({
    kind: "model",
    typeNormalized: "@scope/foo",
    existing: EXISTING,
    conflicting: CONFLICTING,
    ...opts,
  });
}

Deno.test("DuplicateTypeUserError: defaults rollback to rolled-back when omitted", () => {
  const err = makeError();
  assertEquals(err.rollback, { status: "rolled-back" });
  assertEquals(err.rolledBack, true);
  assertEquals(err.isGhostRow, false);
  assertEquals(err.name, "DuplicateTypeUserError");
  assertInstanceOf(err, UserError);
});

Deno.test("DuplicateTypeUserError: rolled-back message is unchanged, with rm recovery", () => {
  const err = makeError({ rollback: { status: "rolled-back" } });
  assertEquals(
    err.message,
    `${CLAIMED} Cannot install ${CONFLICTING_AT} — filesystem changes ` +
      `rolled back. ${RM_RECOVERY}`,
  );
  assertEquals(err.message, makeError().message);
  assertEquals(err.rolledBack, true);
});

Deno.test("DuplicateTypeUserError: rolled-back ghost row points at doctor", () => {
  const err = makeError({
    rollback: { status: "rolled-back" },
    isGhostRow: true,
  });
  assertEquals(
    err.message,
    `${CLAIMED} Cannot install ${CONFLICTING_AT} — filesystem changes ` +
      `rolled back. ${GHOST_RECOVERY}`,
  );
  assertEquals(err.isGhostRow, true);
  assertEquals(err.rolledBack, true);
  assertEquals(makeError({ isGhostRow: true }).message, err.message);
});

Deno.test("DuplicateTypeUserError: kept message says the install was kept and how to undo it", () => {
  const rollback: InstallRollbackOutcome = {
    status: "kept",
    kept: [{ name: "@scopeB/bb", version: "2.0.0", priorVersion: "1.0.0" }],
  };
  const err = makeError({ rollback });
  assertEquals(
    err.message,
    `${CLAIMED} ${CONFLICTING_AT} claims it too, and was installed anyway: ` +
      `the lockfile could not be restored, so the install was kept. ` +
      "To undo it, run `swamp extension pull @scopeB/bb@1.0.0`; or run " +
      "`swamp extension rm @scopeA/aa` to keep the new version instead.",
  );
  assertEquals(err.rollback, rollback);
  assertEquals(err.rolledBack, false);
  assertEquals(err.message.includes("Cannot install"), false);
  assertEquals(err.message.includes("rolled back"), false);
  assertEquals(err.message.includes("doctor"), false);
});

Deno.test("DuplicateTypeUserError: kept advice removes an extension with no prior version", () => {
  const err = makeError({
    rollback: {
      status: "kept",
      kept: [{ name: "@scopeB/bb", version: "2.0.0", priorVersion: null }],
    },
  });
  assertStringIncludes(
    err.message,
    "To undo it, run `swamp extension rm @scopeB/bb`; or run " +
      "`swamp extension rm @scopeA/aa` to keep the new version instead.",
  );
  assertEquals(err.message.includes("swamp extension pull"), false);
});

Deno.test("DuplicateTypeUserError: kept advice lists every kept extension in install order", () => {
  const err = makeError({
    rollback: {
      status: "kept",
      kept: [
        { name: "@scopeB/bb", version: "2.0.0", priorVersion: "1.0.0" },
        { name: "@scopeB/dep-new", version: "3.0.0", priorVersion: null },
        { name: "@scopeB/dep-old", version: "5.0.0", priorVersion: "4.0.0" },
      ],
    },
  });
  assertStringIncludes(
    err.message,
    "To undo it, run `swamp extension pull @scopeB/bb@1.0.0` and " +
      "`swamp extension rm @scopeB/dep-new` and " +
      "`swamp extension pull @scopeB/dep-old@4.0.0`; or run " +
      "`swamp extension rm @scopeA/aa` to keep the new version instead.",
  );
  assert(err.message.endsWith("to keep the new version instead."));
  assertEquals(err.rolledBack, false);
});

Deno.test("DuplicateTypeUserError: kept message never suggests doctor, even for a ghost row", () => {
  const err = makeError({
    isGhostRow: true,
    rollback: {
      status: "kept",
      kept: [{ name: "@scopeB/bb", version: "2.0.0", priorVersion: "1.0.0" }],
    },
  });
  assertEquals(err.message.includes("doctor"), false);
  assertEquals(err.message.includes("Cannot install"), false);
  assertEquals(err.message.includes("rolled back"), false);
  assertEquals(err.isGhostRow, true);
});

Deno.test("DuplicateTypeUserError: unsettled message says the next install or removal completes it", () => {
  const lockfilePath = "/repo/extensions/models/upstream_extensions.json";
  const rollback: InstallRollbackOutcome = {
    status: "unsettled",
    lockfilePath,
  };
  const err = makeError({ rollback });
  assertEquals(
    err.message,
    `${CLAIMED} Cannot install ${CONFLICTING_AT}. The rollback could not ` +
      "finish; the next `swamp extension` install or removal completes it, " +
      "or names the install journal it could not settle " +
      `(lockfile: ${lockfilePath}). ${RM_RECOVERY}`,
  );
  assertEquals(err.rollback, rollback);
  assertEquals(err.rolledBack, false);
  assertEquals(err.message.includes("rolled back"), false);
});

Deno.test("DuplicateTypeUserError: unsettled ghost row keeps the doctor recovery", () => {
  const err = makeError({
    isGhostRow: true,
    rollback: { status: "unsettled", lockfilePath: "/l.json" },
  });
  assertStringIncludes(err.message, "(lockfile: /l.json)");
  assert(err.message.endsWith(GHOST_RECOVERY));
  assertEquals(err.rolledBack, false);
});

Deno.test("DuplicateTypeUserError: rolledBack is true only for rolled-back", () => {
  const cases: Array<[InstallRollbackOutcome, boolean]> = [
    [{ status: "rolled-back" }, true],
    [{ status: "kept", kept: [] }, false],
    [{ status: "unsettled", lockfilePath: "/l.json" }, false],
  ];
  for (const [rollback, expected] of cases) {
    assertEquals(makeError({ rollback }).rolledBack, expected, rollback.status);
  }
});

Deno.test("DuplicateTypeUserError: kept with no extensions listed still gives a way out", () => {
  const err = makeError({ rollback: { status: "kept", kept: [] } });
  assertEquals(err.message.includes("run ;"), false);
  assertEquals(err.message.includes("swamp extension rm"), true);
});
