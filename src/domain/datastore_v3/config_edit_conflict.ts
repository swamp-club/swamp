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

import { markModelWording } from "../behavior_wording.ts";
import { UserError } from "../errors.ts";
import { PartitionsRefusedError } from "./commit_log_unit_of_work.ts";

/** Error code for {@link ConfigEditConflictError}. */
export const CONFIG_EDIT_CONFLICT_CODE = "config_edit_conflict";

/** One managed-config record another writer changed under an edit. */
export interface ConfigEditConflict {
  /** What was edited: a definition of a kind, or the extension lockfile. */
  readonly kind: "model" | "workflow" | "vault" | "lockfile";
  /** The definition's name; undefined for the lockfile. */
  readonly name?: string;
  /** The record key whose expected version did not hold. */
  readonly key: string;
  /** Who changed it: the commit's principal, else its writer's host. */
  readonly changedBy?: string;
  /** When the change was accepted. */
  readonly changedAt?: string;
}

/**
 * A managed-config edit started from a version another writer has since
 * changed, so it was refused and nothing of it was saved (swamp-club#4097).
 * `cause` is the datastore's refusal.
 */
export class ConfigEditConflictError extends UserError {
  constructor(
    readonly conflicts: readonly ConfigEditConflict[],
    cause: unknown,
  ) {
    super(conflictMessage(conflicts, "behavior"), CONFIG_EDIT_CONFLICT_CODE);
    this.name = "ConfigEditConflictError";
    this.cause = cause;
    markModelWording(this, conflictMessage(conflicts, "model"));
  }
}

/**
 * The edit conflict a refused commit stands for, itself or as the cause of
 * the error that wrapped it: every refusal of a
 * managed-config definition's or the lockfile's partition whose expected
 * version did not hold. Undefined for any other error, or a refusal with
 * any other reason or partition, which is not an edit conflict.
 */
export function configEditConflictOf(
  error: unknown,
): ConfigEditConflictError | undefined {
  // A refusal may arrive wrapped, as a lockfile publish's does.
  for (let depth = 0; depth < 4; depth++) {
    if (error instanceof ConfigEditConflictError) return error;
    if (error instanceof PartitionsRefusedError) break;
    if (!(error instanceof Error) || error.cause === undefined) {
      return undefined;
    }
    error = error.cause;
  }
  if (!(error instanceof PartitionsRefusedError)) return undefined;
  const conflicts: ConfigEditConflict[] = [];
  for (const refusal of error.refusals) {
    if (refusal.reason !== "expect-failed" || refusal.key === undefined) {
      return undefined;
    }
    const identity = refusal.partition.identity;
    const changed = {
      key: refusal.key,
      ...(refusal.changedBy === undefined
        ? {}
        : { changedBy: refusal.changedBy }),
      ...(refusal.changedAt === undefined
        ? {}
        : { changedAt: refusal.changedAt }),
    };
    if (identity.kind === "lockfile") {
      conflicts.push({ kind: "lockfile", ...changed });
    } else if (identity.kind === "config") {
      conflicts.push({
        kind: identity.definitionKind,
        name: identity.name,
        ...changed,
      });
    } else {
      return undefined;
    }
  }
  return new ConfigEditConflictError(conflicts, error);
}

function conflictMessage(
  conflicts: readonly ConfigEditConflict[],
  surface: "model" | "behavior",
): string {
  return conflicts.map((conflict) => {
    const who = conflict.changedBy === undefined
      ? ""
      : ` by ${conflict.changedBy}`;
    const when = conflict.changedAt === undefined
      ? ""
      : ` at ${conflict.changedAt}`;
    if (conflict.kind === "lockfile") {
      const detail = who === "" && when === ""
        ? ""
        : ` (${`${who}${when}`.trim()})`;
      return `The extension lockfile was changed in another checkout` +
        `${detail} while this command ran, so nothing was saved. Pull and ` +
        `retry: run the extension command again.`;
    }
    const get = `swamp ${
      commandOf(conflict.kind, surface)
    } get ${conflict.name}`;
    return `${nounOf(conflict.kind, surface)} '${conflict.name}' was ` +
      `changed${who}${when} after you loaded it, so your change to it was ` +
      `not saved. Run ` +
      `'${get}' to load the current version, re-apply your change to it, ` +
      `and run your command again.`;
  }).join("\n");
}

function commandOf(
  kind: "model" | "workflow" | "vault",
  surface: "model" | "behavior",
): string {
  return kind === "model" ? surface : kind;
}

function nounOf(
  kind: "model" | "workflow" | "vault",
  surface: "model" | "behavior",
): string {
  switch (kind) {
    case "model":
      return surface === "model" ? "Model" : "Behavior";
    case "workflow":
      return "Workflow";
    case "vault":
      return "Vault";
  }
}
