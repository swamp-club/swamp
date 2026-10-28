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

import { assertEquals, assertThrows } from "@std/assert";
import type { DatastoreClaimData } from "../../libswamp/datastores/claim.ts";
import type { DatastoreReleaseData } from "../../libswamp/datastores/release.ts";
import { UserError } from "../../domain/errors.ts";
import { createDatastoreClaimRenderer } from "./datastore_claim.ts";
import { createDatastoreReleaseRenderer } from "./datastore_release.ts";

function capture(fn: () => void): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return output.join("\n");
}

const CLAIM: DatastoreClaimData = {
  address: "https://swamp.example.com",
  claimedAt: "2026-10-28T12:00:00.000Z",
  claimedAtCursor: 7,
  alreadyClaimed: false,
};

Deno.test("datastoreClaimRenderer json: prints the claim as its data", () => {
  const output = capture(() =>
    createDatastoreClaimRenderer("json").handlers().completed({
      kind: "completed",
      data: CLAIM,
    })
  );
  assertEquals(JSON.parse(output), CLAIM);
});

Deno.test("datastoreClaimRenderer log: renders a new and an existing claim without printing to stdout", () => {
  const handlers = createDatastoreClaimRenderer("log").handlers();
  const output = capture(() => {
    handlers.catching_up({ kind: "catching_up" });
    handlers.completed({ kind: "completed", data: CLAIM });
    handlers.completed({
      kind: "completed",
      data: { ...CLAIM, alreadyClaimed: true },
    });
  });
  assertEquals(output, "");
});

Deno.test("datastoreReleaseRenderer json: prints whether a claim was removed, and whose", () => {
  const released: DatastoreReleaseData = {
    released: true,
    address: "https://swamp.example.com",
    claimedAt: "2026-10-28T12:00:00.000Z",
  };
  for (const data of [released, { released: false }]) {
    const output = capture(() =>
      createDatastoreReleaseRenderer("json").handlers().completed({
        kind: "completed",
        data,
      })
    );
    assertEquals(JSON.parse(output), data);
  }
});

Deno.test("datastoreClaimRenderer and datastoreReleaseRenderer: an error event is a user error in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    const error = {
      kind: "error" as const,
      error: { code: "datastore_claimed", message: "refused" },
    };
    assertThrows(
      () => createDatastoreClaimRenderer(mode).handlers().error(error),
      UserError,
      "refused",
    );
    assertThrows(
      () => createDatastoreReleaseRenderer(mode).handlers().error(error),
      UserError,
      "refused",
    );
  }
});
