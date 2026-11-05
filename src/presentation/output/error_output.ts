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
  OFFLINE_CONFIG_EDIT_CODE,
  OFFLINE_LEASE_REQUIRED_CODE,
} from "../../domain/datastore_v3/offline_write_policy.ts";
import { LEASE_RECORD_NOT_REMOVED_CODE } from "../../domain/datastore_v3/persisted_lease.ts";
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
import {
  ConfigEditConflictError,
  configEditConflictOf,
} from "../../domain/datastore_v3/config_edit_conflict.ts";
import { takeAuthGateWarning } from "../renderers/auth_gate_warning.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../../domain/datastore_v3/litestream_replication.ts";
import {
  SERVE_FOLLOWER_BEHIND_CODE,
  SERVE_NOT_LEADER_CODE,
} from "../../domain/datastore_v3/serve_leader.ts";
import { V3_COPY_SETUP_RACED_CODE } from "../../domain/datastore_v3/copy_setup_raced_error.ts";
import {
  V3_SERVE_UNREACHABLE_CODE,
  V3_STORAGE_UNREACHABLE_CODE,
  V3_WRITER_BUSY_CODE,
  WriterFencedError,
  type WriterFencedReason,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  CATCH_UP_UNREACHABLE_CODE,
  READ_MODEL_BUSY_CODE,
} from "../../domain/datastore_v3/read_model.ts";
import {
  COMMIT_LEASE_LOST_CODE,
  COMMIT_UNREACHABLE_CODE,
  CommitLeaseLostError,
  LEASE_LAPSED_CODE,
  leaseLostRefusalOf,
  recoveryNeedsAcknowledgement,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";

const logger = getSwampLogger(["error"]);

/**
 * a forwarded request lost at the leader: the domain error's flag, or serve's
 * reply details on the thin-client path; only a literal true is copied
 */
function forwardedInFlight(err: Error): boolean {
  if ((err as { code?: unknown }).code !== SERVE_NOT_LEADER_CODE) return false;
  if ((err as { inFlight?: unknown }).inFlight === true) return true;
  const details = (err as { details?: unknown }).details;
  return typeof details === "object" && details !== null &&
    (details as { inFlight?: unknown }).inFlight === true;
}

/** what the failed command did, which a retry-safe exit depends on */
export interface ErrorPresentationContext {
  /**
   * absent: a lost or lapsed lease and a fenced writer assume something
   * landed and exit 1; the unreachable codes keep their exit 75
   */
  readonly commandLanded?: boolean;
  readonly workflowCommand?: boolean;
}

/** the writer that took over found nothing of this command committed */
const FENCED_NOTHING_COMMITTED: ReadonlySet<WriterFencedReason> = new Set([
  "taken-over",
  "released",
  "copy-restoring",
]);

/** a lost or lapsed lease, as the coded error the user is shown */
function leaseErrorOf(error: unknown): Error | undefined {
  const refusal = leaseLostRefusalOf(error);
  if (refusal !== undefined) {
    const coded = new CommitLeaseLostError(refusal.message);
    coded.cause = refusal;
    return coded;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return error instanceof Error &&
      (code === COMMIT_LEASE_LOST_CODE || code === LEASE_LAPSED_CODE)
    ? error
    : undefined;
}

function leaseHint(context: ErrorPresentationContext): string {
  if (context.commandLanded === false) {
    return "Nothing this command changed in the datastore was committed: " +
      "run it again once the behavior's lock is free, after checking " +
      "anything its methods may already have changed outside swamp.";
  }
  return context.workflowCommand === true
    ? "Steps of this run may have been committed before the lease was lost: " +
      "resume the run with 'swamp workflow resume', or settle it with " +
      "'swamp workflow recover', rather than running the workflow again."
    : "Some of this command's changes may have been committed before the " +
      "lease was lost: check the behavior's data before running it again.";
}

/**
 * code and stack are optional, so consumers must tolerate their absence;
 * specific UserError subclasses add structured fields.
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
  if (forwardedInFlight(err)) data.inFlight = true;
  if (err instanceof AuthGateBlockedError) {
    // Why the auth gate blocked, as data: `kind` plus any retry or age hint,
    // so scripts and agents can branch without parsing the message.
    data.reason = { ...err.reason };
    data.temporary = err.temporary;
  }
  if (err instanceof ConfigEditConflictError) {
    data.conflicts = err.conflicts.map((conflict) => ({ ...conflict }));
  }
  if (err instanceof SignalRefusedUserError) {
    data.refusal = err.refusal;
    if (err.lastWait) data.lastWait = { ...err.lastWait };
    if (err.pending) data.pending = { ...err.pending };
  }
  if (err instanceof RunPartlyCommittedError) {
    data.runs = err.runs.map((run) => ({
      workflowId: run.workflowId,
      runId: run.runId,
      acknowledgeUnknown: recoveryNeedsAcknowledgement(run),
    }));
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
 * 75 (EX_TEMPFAIL) when nothing changed or a retry is safe, so callers can
 * retry with backoff; 1 otherwise, including fenced, may-land and
 * partly-committed datastore errors where a blind retry is unsafe.
 */
export function exitCodeForError(
  error: unknown,
  context: ErrorPresentationContext = {},
): number {
  const nothingLanded = context.commandLanded === false;
  // refused or cancelled before writing: a retry is safe only if nothing
  // else of the command landed
  if (leaseErrorOf(error) !== undefined) return nothingLanded ? 75 : 1;
  if (
    error instanceof WriterFencedError &&
    FENCED_NOTHING_COMMITTED.has(error.reason)
  ) {
    return nothingLanded ? 75 : 1;
  }
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code.toLowerCase() === "lock_timeout") {
    return 75;
  }
  // a block a later run can clear is a temporary failure; a missing or revoked
  // credential is not.
  if (error instanceof AuthGateBlockedError && error.temporary) return 75;
  // commits a sync could not confirm are saved and the next write replicates
  // them: a temporary failure
  if (code === V3_REPLICATION_UNCONFIRMED_CODE) return 75;
  // Writer lease contention: nothing changed, so a retry is safe.
  if (code === V3_WRITER_BUSY_CODE) return 75;
  // Another process's catch-up outlasted the wait: nothing was read.
  if (code === READ_MODEL_BUSY_CODE) return 75;
  // A commit given up because the storage was unreachable: nothing of it
  // landed, though an earlier commit of the command may have.
  if (code === COMMIT_UNREACHABLE_CODE) {
    return context.commandLanded === true ? 1 : 75;
  }
  // cut off from the storage before writing, or while catching up: nothing
  // changed
  if (code === V3_STORAGE_UNREACHABLE_CODE) return 75;
  if (code === CATCH_UP_UNREACHABLE_CODE) return 75;
  // the serve the datastore is written through is unreachable: the write was
  // refused, not sent to the storage
  if (code === V3_SERVE_UNREACHABLE_CODE) {
    return context.commandLanded === true ? 1 : 75;
  }
  // a serve node that does not lead refused the write
  if (code === SERVE_NOT_LEADER_CODE) return 75;
  // a follower whose copy is behind the caller's refused a read while it
  // catches up; nothing changed
  if (code === SERVE_FOLLOWER_BEHIND_CODE) return 75;
  // refused offline before anything changed: run again once serve is reachable,
  // or with the behavior's lease taken online
  if (code === OFFLINE_LEASE_REQUIRED_CODE) return 75;
  if (code === OFFLINE_CONFIG_EDIT_CODE) return 75;
  // A forced release whose kept record stayed: retrying finishes it.
  if (code === LEASE_RECORD_NOT_REMOVED_CODE) return 75;
  // another command is setting up the checkout's copy; nothing changed
  if (code === V3_COPY_SETUP_RACED_CODE) return 75;
  return 1;
}

/**
 * compiled binaries read only static macOS keychain entries, not full trust
 * evaluation, so OTA-distributed roots are invisible; the hint points to the
 * SSL_CERT_FILE workaround.
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
 * the remedy is opt-in: silently falling back to bundled roots would drop any
 * corporate root in the OS store. Messages already naming the remedy get no
 * second copy.
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

function inSpelling(err: Error, message: string): Error {
  if (message === err.message) return err;
  const shown = new Error(message, { cause: err.cause });
  shown.name = err.name;
  if (err.stack) shown.stack = err.stack.replace(err.message, message);
  return shown;
}

/**
 * in JSON mode this is the single emitter for fatal output and does not call
 * logger.fatal, so log sinks never print a duplicate line.
 */
export function renderError(
  error: unknown,
  outputMode?: OutputMode,
  surface: CommandSurface = "behavior",
  context: ErrorPresentationContext = {},
): void {
  // a refused stale config edit is the user's to resolve, not a crash
  const leaseError = leaseErrorOf(error);
  const err = configEditConflictOf(error) ?? leaseError ??
    (error instanceof Error ? error : new Error(String(error)));
  const message = messageFor(err, surface);
  // A certificate-store failure is an environment problem the user can fix,
  // not a swamp bug, so it gets no stack trace even when it arrives raw.
  const certStoreHint = platformCertStoreHint(err.message);
  const hint = tlsErrorHint(err.message) ?? certStoreHint ??
    (leaseError !== undefined ? leaseHint(context) : undefined);

  if (outputMode === "json") {
    const json = buildErrorJson(err, surface);
    if (certStoreHint) {
      delete json.stack;
    }
    if (hint) {
      json.hint = hint;
    }
    // an offline auth gate warning rides on the error so stderr stays one JSON
    // document
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
