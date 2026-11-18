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

import { assertEquals, assertRejects } from "@std/assert";
import { ModelType } from "../model_type.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "./enrollment_token_model.ts";
import {
  type EnrollmentTokenWriteOrdering,
  isEnrollmentTokenType,
  orderEnrollmentTokenWrite,
  setEnrollmentTokenWriteOrdering,
} from "./enrollment_token_write_ordering.ts";

function countingOrdering(): {
  ordering: EnrollmentTokenWriteOrdering;
  calls: () => number;
} {
  let calls = 0;
  return {
    ordering: (fn) => {
      calls++;
      return fn();
    },
    calls: () => calls,
  };
}

Deno.test("orderEnrollmentTokenWrite: runs fn directly when no ordering is set", async () => {
  setEnrollmentTokenWriteOrdering(null);
  assertEquals(
    await orderEnrollmentTokenWrite(
      ENROLLMENT_TOKEN_MODEL_TYPE,
      () => Promise.resolve("ran"),
    ),
    "ran",
  );
});

Deno.test("orderEnrollmentTokenWrite: runs a token record's fn through the set ordering", async () => {
  const { ordering, calls } = countingOrdering();
  setEnrollmentTokenWriteOrdering(ordering);
  try {
    assertEquals(
      await orderEnrollmentTokenWrite(
        ModelType.create("Swamp.Enrollment-Token"),
        () => Promise.resolve("ran"),
      ),
      "ran",
    );
    assertEquals(calls(), 1);
  } finally {
    setEnrollmentTokenWriteOrdering(null);
  }
});

Deno.test("orderEnrollmentTokenWrite: runs another type's fn without the ordering", async () => {
  const { ordering, calls } = countingOrdering();
  setEnrollmentTokenWriteOrdering(ordering);
  try {
    await orderEnrollmentTokenWrite(
      ModelType.create("swamp/step-lease"),
      () => Promise.resolve(),
    );
    assertEquals(calls(), 0);
  } finally {
    setEnrollmentTokenWriteOrdering(null);
  }
});

Deno.test("orderEnrollmentTokenWrite: a run cancelled while it waited for its turn never runs", async () => {
  const turn = Promise.withResolvers<void>();
  setEnrollmentTokenWriteOrdering(async (fn) => {
    await turn.promise;
    return await fn();
  });
  try {
    const controller = new AbortController();
    let ran = false;
    const pending = orderEnrollmentTokenWrite(
      ENROLLMENT_TOKEN_MODEL_TYPE,
      () => {
        ran = true;
        return Promise.resolve();
      },
      controller.signal,
    );
    controller.abort(new Error("run cancelled"));
    turn.resolve();
    await assertRejects(() => pending, Error, "run cancelled");
    assertEquals(ran, false);
  } finally {
    setEnrollmentTokenWriteOrdering(null);
  }
});

Deno.test("isEnrollmentTokenType: matches every spelling that resolves to the token model, and nothing else", () => {
  assertEquals(isEnrollmentTokenType(ENROLLMENT_TOKEN_MODEL_TYPE), true);
  assertEquals(
    isEnrollmentTokenType(ModelType.create("Swamp.Enrollment-Token")),
    true,
  );
  assertEquals(
    isEnrollmentTokenType(ModelType.create("swamp/server-token")),
    false,
  );
});

Deno.test("orderEnrollmentTokenWrite: clearing the ordering stops routing through it", async () => {
  const { ordering, calls } = countingOrdering();
  setEnrollmentTokenWriteOrdering(ordering);
  setEnrollmentTokenWriteOrdering(null);
  await orderEnrollmentTokenWrite(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    () => Promise.resolve(),
  );
  assertEquals(calls(), 0);
});
