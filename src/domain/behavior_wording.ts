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

import { UserError } from "./errors.ts";

/**
 * Messages in the spelling the user typed (swamp-club#3437).
 *
 * Behavior is the product term for a model (design/primitives/behaviors.md),
 * so every message reads in behavior words by default. Only the legacy
 * `swamp model …` tree reads in model words. The code that builds a message
 * rarely knows which tree ran, so it builds both spellings from one template
 * with {@link wordedText}: the behavior spelling becomes the message, and the
 * model spelling rides along on the error ({@link markModelWording}) or the
 * warning, for the CLI boundary to print when the command was `swamp model`.
 *
 * Words that name code — `export const model`, the `models/` folder,
 * `context.runModel`, flag names — are not nouns here and stay in the template
 * as written.
 */

/** The nouns of one spelling. */
export interface BehaviorWords {
  /** `behavior` or `model`. */
  readonly noun: string;
  /** `Behavior` or `Model`. */
  readonly Noun: string;
  /** `behaviors` or `models`. */
  readonly nouns: string;
  /** `Behaviors` or `Models`. */
  readonly Nouns: string;
  /**
   * A method of one: `method` or `model method`. The glossary renames
   * "model method" to plain "method".
   */
  readonly method: string;
  /** `Method` or `Model method`. */
  readonly Method: string;
}

/** The product spelling, used by every command outside `swamp model`. */
export const BEHAVIOR_WORDS: BehaviorWords = {
  noun: "behavior",
  Noun: "Behavior",
  nouns: "behaviors",
  Nouns: "Behaviors",
  method: "method",
  Method: "Method",
};

/** The legacy spelling, used only under `swamp model …`. */
export const MODEL_WORDS: BehaviorWords = {
  noun: "model",
  Noun: "Model",
  nouns: "models",
  Nouns: "Models",
  method: "model method",
  Method: "Model method",
};

/** One message in both spellings. */
export interface WordedText {
  /** The behavior spelling: the message everywhere but `swamp model`. */
  readonly text: string;
  /** The model spelling, printed under `swamp model …`. */
  readonly modelText: string;
}

/** Builds `build`'s message in both spellings. */
export function wordedText(
  build: (words: BehaviorWords) => string,
): WordedText {
  return { text: build(BEHAVIOR_WORDS), modelText: build(MODEL_WORDS) };
}

/**
 * Where an error or a SwampError keeps its model spelling. A module-private
 * symbol on a non-enumerable property, so JSON output, `Object.keys` and
 * default inspection never see it.
 */
const MODEL_WORDING = Symbol("swamp.modelWording");

/**
 * Stores `modelText` as the model spelling of `target`'s message. A text
 * equal in both spellings stores nothing.
 *
 * @returns The same target, so a call site can `throw markModelWording(...)`
 */
export function markModelWording<T extends object>(
  target: T,
  modelText: string,
): T {
  const message = (target as { message?: unknown }).message;
  if (message === modelText) return target;
  Object.defineProperty(target, MODEL_WORDING, {
    value: modelText,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * The model spelling marked on `value` itself, or `undefined`. The `cause`
 * chain is never read: a wrapper with its own message must not print its
 * cause's text in its place.
 */
export function modelWording(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const marked = (value as Record<symbol, unknown>)[MODEL_WORDING];
  return typeof marked === "string" ? marked : undefined;
}

/**
 * Copies `from`'s model spelling to `to` when both carry the same message, as
 * when an error is rethrown as another type. A wrapper whose message differs
 * gets nothing; it builds its own {@link wordedText} if it needs one.
 *
 * @returns `to`
 */
export function carryModelWording<T extends object>(
  from: unknown,
  to: T,
): T {
  const modelText = modelWording(from);
  if (modelText === undefined) return to;
  const fromMessage = (from as { message?: unknown }).message;
  const toMessage = (to as { message?: unknown }).message;
  if (fromMessage !== toMessage) return to;
  return markModelWording(to, modelText);
}

/** An Error whose message is `worded`, carrying its model spelling. */
export function wordedError(worded: WordedText): Error {
  return markModelWording(new Error(worded.text), worded.modelText);
}

/** A UserError whose message is `worded`, carrying its model spelling. */
export function wordedUserError(worded: WordedText, code?: string): UserError {
  return markModelWording(new UserError(worded.text, code), worded.modelText);
}

/**
 * The text of `value`'s message in the spelling of `surface`. `surface` is
 * `"model"` only under `swamp model …`.
 */
export function messageFor(
  value: { readonly message: string },
  surface: "model" | "behavior",
): string {
  if (surface === "model") return modelWording(value) ?? value.message;
  return value.message;
}
