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

import { ValidationError } from "@cliffy/command";
import { bold, dim, red, yellow } from "@std/fmt/colors";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { DuplicateTypeUserError } from "../../domain/extensions/duplicate_type_user_error.ts";
import type { OutputMode } from "./output.ts";

const logger = getSwampLogger(["error"]);

/**
 * Builds the JSON error object for structured output.
 *
 * Default shape: `{ error: string, stack?: string, code?: string }`. The
 * `code` field is set when the underlying error carries a machine-
 * readable identifier (e.g. `UserError.code` or any error object
 * exposing a string `code` property — `SwampError`-like). Both `code`
 * and `stack` are optional; consumers must tolerate their presence or
 * absence.
 *
 * Specific {@link UserError} subclasses extend the default shape with
 * structured fields:
 *
 * - {@link DuplicateTypeUserError} adds a `duplicateType` object with
 *   `kind`, `type`, `existing`, and `conflicting` (per plan v4 step
 *   11). Lets `--json` consumers (jq, AI agents, CI scripts) read the
 *   collision details without re-parsing the message.
 */
export function buildErrorJson(err: Error): Record<string, unknown> {
  const data: Record<string, unknown> = { error: err.message };
  if (
    !(err instanceof UserError) && !(err instanceof ValidationError) &&
    err.stack
  ) {
    const stackLines = err.stack.split("\n").filter((line) =>
      line.trim().startsWith("at ")
    );
    if (stackLines.length > 0) {
      data.stack = stackLines.join("\n");
    }
  }
  const maybeCode = (err as { code?: unknown }).code;
  if (typeof maybeCode === "string" && maybeCode.length > 0) {
    data.code = maybeCode;
  }
  if (err instanceof DuplicateTypeUserError) {
    data.duplicateType = {
      kind: err.kind,
      type: err.typeNormalized,
      isGhostRow: err.isGhostRow,
      existing: {
        extensionName: err.existing.extensionName,
        extensionVersion: err.existing.extensionVersion,
        canonicalPath: err.existing.canonicalPath,
      },
      conflicting: {
        extensionName: err.conflicting.extensionName,
        extensionVersion: err.conflicting.extensionVersion,
        canonicalPath: err.conflicting.canonicalPath,
      },
    };
  }
  return data;
}

/**
 * Returns the process exit code for an error.
 *
 * - `75` (EX_TEMPFAIL) for `lock_timeout` — a temporary failure that
 *   callers should retry with backoff.
 * - `1` for all other errors.
 */
export function exitCodeForError(error: unknown): number {
  const code = (error as { code?: unknown })?.code;
  if (code === "lock_timeout") return 75;
  return 1;
}

/**
 * Returns a TLS diagnostic hint if the error message indicates an
 * `UnknownIssuer` TLS failure, or `undefined` otherwise. Compiled Deno
 * binaries use `rustls-native-certs` / `deno_native_certs` which read
 * static keychain entries on macOS — they do not use the OS's full trust
 * evaluation (`SecTrustEvaluateWithError`), so roots distributed via
 * Apple's OTA trust updates are invisible. This hint guides users to the
 * existing `SSL_CERT_FILE` workaround.
 */
export function tlsErrorHint(message: string): string | undefined {
  if (
    !message.includes("UnknownIssuer") &&
    !message.includes("invalid peer certificate")
  ) {
    return undefined;
  }
  return [
    "The TLS certificate was rejected because its root CA is not in Deno's trust store.",
    "On macOS, Deno does not use the operating system's full certificate trust",
    "evaluation, so some certificates trusted by curl and browsers are not recognized.",
    "",
    "Workaround: set SSL_CERT_FILE to a PEM file containing the missing root CA:",
    "  export SSL_CERT_FILE=/path/to/root-ca.pem",
    "",
    "This is a known Deno limitation — see https://github.com/denoland/deno/issues/36402",
  ].join("\n");
}

/**
 * Renders an error to the user.
 *
 * In JSON mode this is the SINGLE emitter for fatal output: it writes
 * the JSON error to stderr and does NOT call `logger.fatal`, so log-mode
 * sinks never produce a duplicate FTL line. In log mode it falls
 * through to LogTape — UserError / Cliffy ValidationError emit just the
 * message; other errors emit the full Error (stack trace included).
 */
export function renderError(error: unknown, outputMode?: OutputMode): void {
  const err = error instanceof Error ? error : new Error(String(error));

  if (outputMode === "json") {
    const json = buildErrorJson(err);
    const hint = tlsErrorHint(err.message);
    if (hint) {
      json.hint = hint;
    }
    // deno-lint-ignore no-console
    console.error(JSON.stringify(json, null, 2));
    return;
  }

  if (err instanceof UserError) {
    console.error(`\n${red(bold("Error:"))} ${err.message}`);
  } else if (err instanceof ValidationError) {
    logger.fatal("Error: {message}", { message: err.message });
  } else {
    logger.fatal("{error}", { error: err });
  }

  const hint = tlsErrorHint(err.message);
  if (hint) {
    console.error(`\n${yellow(bold("Hint:"))} ${dim(hint)}`);
  }
}
