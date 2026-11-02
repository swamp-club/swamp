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
 * messages build both spellings from one template; the behavior spelling is the
 * message, and the model spelling rides along for the CLI boundary to print
 * under swamp model. Words naming code stay as written
 */

export interface BehaviorWords {
  readonly noun: string;
  readonly Noun: string;
  readonly nouns: string;
  readonly Nouns: string;
  readonly method: string;
  readonly Method: string;
}

export const BEHAVIOR_WORDS: BehaviorWords = {
  noun: "behavior",
  Noun: "Behavior",
  nouns: "behaviors",
  Nouns: "Behaviors",
  method: "method",
  Method: "Method",
};

export const MODEL_WORDS: BehaviorWords = {
  noun: "model",
  Noun: "Model",
  nouns: "models",
  Nouns: "Models",
  method: "model method",
  Method: "Model method",
};

export interface WordedText {
  readonly text: string;
  readonly modelText: string;
}

export function wordedText(
  build: (words: BehaviorWords) => string,
): WordedText {
  return { text: build(BEHAVIOR_WORDS), modelText: build(MODEL_WORDS) };
}

/**
 * a module-private symbol on a non-enumerable property, so JSON output,
 * Object.keys and default inspection never see it
 */
const MODEL_WORDING = Symbol("swamp.modelWording");

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
 * the cause chain is never read: a wrapper with its own message must not print
 * its cause's text in its place
 */
export function modelWording(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const marked = (value as Record<symbol, unknown>)[MODEL_WORDING];
  return typeof marked === "string" ? marked : undefined;
}

/**
 * copies only when both carry the same message, as when an error is rethrown as
 * another type; a wrapper with a different message builds its own wordedText
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

export function wordedError(worded: WordedText): Error {
  return markModelWording(new Error(worded.text), worded.modelText);
}

export function wordedUserError(worded: WordedText, code?: string): UserError {
  return markModelWording(new UserError(worded.text, code), worded.modelText);
}

export function messageFor(
  value: { readonly message: string },
  surface: "model" | "behavior",
): string {
  if (surface === "model") return modelWording(value) ?? value.message;
  return value.message;
}
