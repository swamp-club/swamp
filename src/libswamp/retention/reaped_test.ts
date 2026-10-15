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
  decorateNotFound,
  findReapedBefore,
  withReapedHint,
} from "./reaped.ts";
import {
  failingWatermarks,
  FAKE_REAPED_CUTOFF,
  fakeWatermarks,
} from "./reaped_test_helpers.ts";
import { notFound, validationFailed } from "../errors.ts";
import { modelWording } from "../../domain/behavior_wording.ts";
import { wordedSwampError } from "../errors.ts";
import { wordedText } from "../../domain/behavior_wording.ts";

Deno.test("findReapedBefore: returns the watermark's cutoff and retention", async () => {
  assertEquals(
    await findReapedBefore(fakeWatermarks(["workflowRuns"]), "workflowRuns"),
    { cutoff: FAKE_REAPED_CUTOFF, retention: "14d" },
  );
});

Deno.test("findReapedBefore: null without a repository or a watermark", async () => {
  assertEquals(await findReapedBefore(undefined, "data"), null);
  assertEquals(
    await findReapedBefore(fakeWatermarks(["workflowRuns"]), "data"),
    null,
  );
});

Deno.test("findReapedBefore: never throws when the repository rejects", async () => {
  assertEquals(await findReapedBefore(failingWatermarks(), "outputs"), null);
});

Deno.test("decorateNotFound: appends the reaped hint and details", () => {
  const error = decorateNotFound(
    notFound("Workflow run", "abc"),
    "workflowRuns",
    { cutoff: FAKE_REAPED_CUTOFF, retention: "14d" },
  );
  assertEquals(error.code, "not_found");
  assertEquals(
    error.message,
    `Workflow run not found: abc; runs before ${FAKE_REAPED_CUTOFF} have been reaped by retention (14d)`,
  );
  assertEquals(error.details, {
    entityType: "Workflow run",
    idOrName: "abc",
    reapedBefore: FAKE_REAPED_CUTOFF,
    retention: "14d",
  });
});

Deno.test("decorateNotFound: data reads as a mass noun", () => {
  const error = decorateNotFound(notFound("Data", "x"), "data", {
    cutoff: FAKE_REAPED_CUTOFF,
    retention: "30d",
  });
  assertEquals(
    error.message,
    `Data not found: x; data before ${FAKE_REAPED_CUTOFF} has been reaped by retention (30d)`,
  );
});

Deno.test("decorateNotFound: leaves other codes and missing watermarks alone", () => {
  const invalid = validationFailed("bad");
  assertEquals(
    decorateNotFound(invalid, "data", {
      cutoff: FAKE_REAPED_CUTOFF,
      retention: "1d",
    }),
    invalid,
  );
  const missing = notFound("Data", "x");
  assertEquals(decorateNotFound(missing, "data", null), missing);
});

Deno.test("decorateNotFound: keeps the model spelling, with the hint", () => {
  const error = decorateNotFound(
    wordedSwampError(
      "not_found",
      wordedText((w) => `${w.Noun} output not found`),
    ),
    "outputs",
    { cutoff: FAKE_REAPED_CUTOFF, retention: "7d" },
  );
  const suffix =
    `; outputs before ${FAKE_REAPED_CUTOFF} have been reaped by retention (7d)`;
  assertEquals(error.message, `Behavior output not found${suffix}`);
  assertEquals(modelWording(error), `Model output not found${suffix}`);
});

Deno.test("withReapedHint: returns the error unchanged when the repository rejects", async () => {
  const error = notFound("Data", "x");
  assertEquals(await withReapedHint(error, "data", failingWatermarks()), error);
});

Deno.test("findReapedBefore: null while the kind's last pass has not finished", async () => {
  const incomplete = {
    get: () =>
      Promise.resolve({
        kind: "workflowRuns" as const,
        cutoff: "2026-10-01T00:00:00.000Z",
        retention: "14d",
        lastPassAt: "2026-10-15T00:00:00.000Z",
        complete: false,
        deleted: 0,
        bytesReclaimed: 0,
      }),
    getAll: () => Promise.resolve([]),
    put: () => Promise.resolve(),
    claimHourlyPass: () => Promise.resolve(true),
  };
  assertEquals(await findReapedBefore(incomplete, "workflowRuns"), null);
});

Deno.test("findReapedBefore: null when the watermark read outlasts its deadline", async () => {
  let release!: () => void;
  const stalled = {
    get: () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
    getAll: () => Promise.resolve([]),
    put: () => Promise.resolve(),
    claimHourlyPass: () => Promise.resolve(true),
  };
  assertEquals(await findReapedBefore(stalled, "workflowRuns", 10), null);
  release();
});
