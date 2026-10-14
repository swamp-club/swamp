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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  carryModelWording,
  markModelWording,
  messageFor,
  modelWording,
  wordedError,
  wordedText,
  wordedUserError,
} from "./behavior_wording.ts";
import { UserError } from "./errors.ts";

Deno.test("wordedText: builds the behavior and model spellings from one template", () => {
  const worded = wordedText((w) =>
    `${w.Noun} not found: x (${w.nouns}, ${w.method})`
  );
  assertEquals(worded.text, "Behavior not found: x (behaviors, method)");
  assertEquals(worded.modelText, "Model not found: x (models, model method)");
});

Deno.test("wordedUserError: the message is the behavior spelling and the marker holds the model one", () => {
  const error = wordedUserError(
    wordedText((w) => `${w.Noun} not found: x`),
    "not_found",
  );
  assertEquals(error.message, "Behavior not found: x");
  assertEquals(error.code, "not_found");
  assertEquals(modelWording(error), "Model not found: x");
  assertEquals(messageFor(error, "model"), "Model not found: x");
  assertEquals(messageFor(error, "behavior"), "Behavior not found: x");
});

Deno.test("markModelWording: the marker is hidden from JSON and Object.keys", () => {
  const error = wordedError(wordedText((w) => `${w.Noun} x`));
  assertEquals(Object.keys(error), []);
  const swampError = markModelWording(
    { code: "not_found", message: "Behavior x" },
    "Model x",
  );
  assertEquals(
    JSON.stringify(swampError),
    '{"code":"not_found","message":"Behavior x"}',
  );
  assertEquals(modelWording(swampError), "Model x");
});

Deno.test("markModelWording: a text equal in both spellings stores nothing", () => {
  const error = markModelWording(new Error("same"), "same");
  assertEquals(modelWording(error), undefined);
});

Deno.test("modelWording: never reads the cause chain", () => {
  const cause = wordedError(wordedText((w) => `${w.Noun} not found: x`));
  const wrapper = new UserError("Could not load: x", undefined);
  (wrapper as Error).cause = cause;
  assertEquals(modelWording(wrapper), undefined);
  assertEquals(messageFor(wrapper, "model"), "Could not load: x");
});

Deno.test("carryModelWording: copies the marker only when the message is unchanged", () => {
  const from = wordedError(wordedText((w) => `${w.Noun} not found: x`));
  const same = carryModelWording(from, new UserError(from.message));
  assertEquals(modelWording(same), "Model not found: x");
  const changed = carryModelWording(
    from,
    new UserError(`Failed: ${from.message}`),
  );
  assertEquals(modelWording(changed), undefined);
});

Deno.test("carryModelWording: returns the target unchanged when the source has no marker", () => {
  const to = new UserError("plain");
  assertStrictEquals(carryModelWording(new Error("plain"), to), to);
  assertEquals(modelWording(to), undefined);
});
