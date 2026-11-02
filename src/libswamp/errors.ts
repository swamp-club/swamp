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

import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import {
  carryModelWording,
  markModelWording,
  type WordedText,
  wordedText,
} from "../domain/behavior_wording.ts";

export interface SwampError {
  readonly code: string;
  readonly message: string;
  readonly cause?: Error;
  readonly details?: unknown;
}

/**
 * some libswamp functions throw a SwampError (a plain object) rather than an
 * Error; this is a shape check, and Error instances are excluded even with a
 * string code, so provider errors keep their own handling
 */
export function isSwampError(value: unknown): value is SwampError {
  return typeof value === "object" && value !== null &&
    !(value instanceof Error) &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string";
}

export function notAuthenticated(): SwampError {
  return {
    code: "not_authenticated",
    message: "Not authenticated. Run 'swamp auth login' to sign in.",
  };
}

/** stored credentials that hold identity but no key */
export function noStoredLoginKey(): SwampError {
  return {
    code: "not_authenticated",
    message:
      "Not authenticated. auth.json holds identity cached from an earlier " +
      "SWAMP_API_KEY, SWAMP_API_KEY_FILE or --club-api-key-file run, but no " +
      "login key. Run 'swamp auth login' to sign in, set the API key source " +
      "again, or run 'swamp auth logout' to remove the file.",
  };
}

export function invalidApiKey(): SwampError {
  return {
    code: "invalid_api_key",
    message:
      "Stored API key is no longer valid. Run 'swamp auth login' to re-authenticate.",
  };
}

export function cancelled(cause?: Error): SwampError {
  return {
    code: "cancelled",
    message: "Operation was cancelled.",
    cause,
  };
}

export function notFound(entityType: string, idOrName: string): SwampError {
  return {
    code: "not_found",
    message: `${entityType} not found: ${idOrName}`,
    details: { entityType, idOrName },
  };
}

export function wordedSwampError(
  code: string,
  worded: WordedText,
  details?: unknown,
): SwampError {
  const error: SwampError = details === undefined
    ? { code, message: worded.text }
    : { code, message: worded.text, details };
  return markModelWording(error, worded.modelText);
}

export function behaviorNotFound(idOrName: string): SwampError {
  return wordedSwampError(
    "not_found",
    wordedText((w) => `${w.Noun} not found: ${idOrName}`),
    { entityType: "Model", idOrName },
  );
}

export function behaviorTypeNotFound(type: string): SwampError {
  return wordedSwampError(
    "not_found",
    wordedText((w) => `${w.Noun} type not found: ${type}`),
    { entityType: "Model type", idOrName: type },
  );
}

export function alreadyExists(entityType: string, name: string): SwampError {
  return {
    code: "already_exists",
    message: `${entityType} already exists: ${name}`,
    details: { entityType, name },
  };
}

export function forbidden(message: string): SwampError {
  return {
    code: "forbidden",
    message,
  };
}

export function validationFailed(
  message: string,
  details?: unknown,
): SwampError {
  return {
    code: "validation_failed",
    message,
    details,
  };
}

/**
 * paths marked on the SwampError's cause carry over, so telemetry can still
 * remove them exactly
 */
export function userErrorFromSwampError(error: SwampError): UserError {
  return carryModelWording(
    error,
    markErrorPaths(
      new UserError(error.message, error.code),
      errorPaths(error.cause),
    ),
  );
}
