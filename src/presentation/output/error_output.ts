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
import { AuthGateBlockedError } from "../../domain/auth/auth_gate_blocked_error.ts";
import { SignalRefusedUserError } from "../../domain/workflows/signal_refused_user_error.ts";
import type { OutputMode } from "./output.ts";
import type { CommandSurface } from "../command_surface.ts";
import { messageFor } from "../../domain/behavior_wording.ts";
import { takeAuthGateWarning } from "../renderers/auth_gate_warning.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../../domain/datastore_v3/litestream_replication.ts";
import {
  V3_STORAGE_UNREACHABLE_CODE,
  V3_WRITER_BUSY_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  CATCH_UP_UNREACHABLE_CODE,
  READ_MODEL_BUSY_CODE,
} from "../../domain/datastore_v3/read_model.ts";
import {
  COMMIT_UNREACHABLE_CODE,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";

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
 * - {@link SignalRefusedUserError} adds `refusal` and, for a key no open
 *   wait holds, `lastWait`: the wait that last held the key, how it was
 *   settled and when.
 * - {@link RunPartlyCommittedError} adds `runs`, each `{workflowId, runId}`:
 *   the workflow runs left running, to pass to `swamp workflow recover`.
 */
export function buildErrorJson(
  err: Error,
  surface: CommandSurface = "behavior",
): Record<string, unknown> {
  const data: Record<string, unknown> = { error: messageFor(err, surface) };
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
    // Report lock timeouts under the documented lowercase code whatever case
    // the extension used, matching the exit code 75 from exitCodeForError.
    data.code = maybeCode.toLowerCase() === "lock_timeout"
      ? "lock_timeout"
      : maybeCode;
  }
  if (err instanceof AuthGateBlockedError) {
    // Why the auth gate blocked, as data: `kind` plus any retry or age hint,
    // so scripts and agents can branch without parsing the message.
    data.reason = { ...err.reason };
    data.temporary = err.temporary;
  }
  if (err instanceof SignalRefusedUserError) {
    data.refusal = err.refusal;
    if (err.lastWait) data.lastWait = { ...err.lastWait };
    if (err.pending) data.pending = { ...err.pending };
  }
  if (err instanceof RunPartlyCommittedError) {
    data.runs = err.runs.map((run) => ({ ...run }));
  }
  if (err instanceof DuplicateTypeUserError) {
    data.duplicateType = {
      kind: err.kind,
      type: err.typeNormalized,
      isGhostRow: err.isGhostRow,
      rolledBack: err.rolledBack,
      rollback: err.rollback,
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
 *   callers should retry with backoff. Matched in any case: datastore
 *   extensions throw `LOCK_TIMEOUT`, and core only translates the ones
 *   raised through a lock it wrapped.
 * - `75` for an auth gate block a later run can clear (swamp-club refusing,
 *   unreachable or failing), so CI can retry it.
 * - `75` for `datastore_v3_replication_unconfirmed`: the command's commits
 *   are saved but a sync did not confirm them in the replica, and the next
 *   write replicates them.
 * - `75` for `datastore_v3_writer_busy`: another process holds the v3
 *   datastore's writer lease, and the command changed nothing
 *   (swamp-club#3564). `datastore_v3_writer_fenced` stays `1`: a command
 *   whose lease was taken over may have landed some of its commits, so a
 *   blind retry is not safe. So does `datastore_v3_commit_may_land`
 *   (swamp-club#3586): its change may still be committed by a later
 *   command.
 * - `75` for `datastore_v3_commit_unreachable`: a commit that could not
 *   reach the datastore's storage was given up, so nothing was committed
 *   and a retry is safe for the datastore (swamp-club#3759).
 *   `datastore_v3_run_partly_committed` stays `1` (swamp-club#3802): a
 *   checkpoint committed its workflow runs, which are left running, so a
 *   retry would start another run instead of settling them. So does
 *   `datastore_v3_commit_partly_committed`: part of the change had landed
 *   (a checkpoint's, or an earlier partition of the same commit), and a
 *   re-run can meet it, as a token of the same name, instead of redoing it.
 * - `75` for `datastore_v3_storage_unreachable` and
 *   `datastore_v3_catch_up_unreachable` (swamp-club#3802): the storage could
 *   not be reached while the command got ready to write, or while it
 *   brought the checkout up to date, so nothing was changed.
 * - `1` for all other errors, including a missing or revoked credential.
 */
export function exitCodeForError(error: unknown): number {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code.toLowerCase() === "lock_timeout") {
    return 75;
  }
  // A block a later run can clear (swamp-club refusing, unreachable or
  // failing) is a temporary failure too; a missing or revoked credential is
  // not.
  if (error instanceof AuthGateBlockedError && error.temporary) return 75;
  // Commits a sync could not confirm are saved, and the next write
  // replicates them (swamp-club#3416): a temporary failure.
  if (code === V3_REPLICATION_UNCONFIRMED_CODE) return 75;
  // Writer lease contention: nothing changed, so a retry is safe.
  if (code === V3_WRITER_BUSY_CODE) return 75;
  // Another process's catch-up outlasted the wait: nothing was read.
  if (code === READ_MODEL_BUSY_CODE) return 75;
  // A commit given up because the storage was unreachable: nothing landed.
  if (code === COMMIT_UNREACHABLE_CODE) return 75;
  // Cut off from the storage before writing, or while catching up: nothing
  // changed (swamp-club#3802).
  if (code === V3_STORAGE_UNREACHABLE_CODE) return 75;
  if (code === CATCH_UP_UNREACHABLE_CODE) return 75;
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
 * Returns remediation guidance if the error message is Deno's failure to read
 * the OS certificate store, or `undefined` otherwise (swamp-club#2314).
 *
 * Deno reads the store when it builds the TLS root store for the first
 * request, so the failure reaches whichever network call ran first — as a raw
 * `Error` from `fetch()`, or embedded in a wrapping `UserError`. The remedy is
 * opt-in: falling back to the bundled roots silently would drop any corporate
 * root the operator installed in the OS store. Messages that already name the
 * remedy (from `createTlsHttpClient`) get no second copy.
 */
export function platformCertStoreHint(message: string): string | undefined {
  if (
    !message.includes("Failed to load platform certificates") ||
    message.includes("DENO_TLS_CA_STORE=mozilla")
  ) {
    return undefined;
  }
  return [
    "The operating system's certificate store could not be read. swamp reads it",
    'when DENO_TLS_CA_STORE includes "system" (swamp sets "system,mozilla" when',
    "the variable is unset).",
    "",
    "Before retrying, switch to Deno's bundled root certificates only:",
    "  export DENO_TLS_CA_STORE=mozilla",
    "",
    "Roots installed only in the OS store, such as a corporate CA, are then not",
    "trusted. If you need one, export it to a PEM file and also set:",
    "  export SSL_CERT_FILE=/path/to/root-ca.pem",
  ].join("\n");
}

/**
 * `err` with `message` as its message, for a spelling that differs from the
 * error's own (swamp-club#3437). The stack keeps its frames; only the first
 * line's message changes. `err` itself is left alone.
 */
function inSpelling(err: Error, message: string): Error {
  if (message === err.message) return err;
  const shown = new Error(message, { cause: err.cause });
  shown.name = err.name;
  if (err.stack) shown.stack = err.stack.replace(err.message, message);
  return shown;
}

/**
 * Renders an error to the user.
 *
 * In JSON mode this is the SINGLE emitter for fatal output: it writes
 * the JSON error to stderr and does NOT call `logger.fatal`, so log-mode
 * sinks never produce a duplicate FTL line. In log mode it falls
 * through to LogTape — UserError / Cliffy ValidationError emit just the
 * message; other errors emit the full Error (stack trace included),
 * except an unreadable OS certificate store, which renders like a
 * UserError with its remedy hint.
 *
 * `surface` is the tree the command ran in: under `swamp model …` a message
 * marked with its model spelling prints that spelling (swamp-club#3437).
 */
export function renderError(
  error: unknown,
  outputMode?: OutputMode,
  surface: CommandSurface = "behavior",
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = messageFor(err, surface);
  // A certificate-store failure is an environment problem the user can fix,
  // not a swamp bug, so it gets no stack trace even when it arrives raw.
  const certStoreHint = platformCertStoreHint(err.message);
  const hint = tlsErrorHint(err.message) ?? certStoreHint;

  if (outputMode === "json") {
    const json = buildErrorJson(err, surface);
    if (certStoreHint) {
      delete json.stack;
    }
    if (hint) {
      json.hint = hint;
    }
    // An offline auth gate warning rides on the error so stderr stays one
    // JSON document (swamp-club#2938).
    Object.assign(json, takeAuthGateWarning());
    // deno-lint-ignore no-console
    console.error(JSON.stringify(json, null, 2));
    return;
  }

  if (err instanceof UserError || certStoreHint) {
    console.error(`\n${red(bold("Error:"))} ${message}`);
  } else if (err instanceof ValidationError) {
    logger.fatal("Error: {message}", { message });
  } else {
    logger.fatal("{error}", { error: inSpelling(err, message) });
  }

  if (hint) {
    console.error(`\n${yellow(bold("Hint:"))} ${dim(hint)}`);
  }
}
