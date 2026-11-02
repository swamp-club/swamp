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

import { markErrorPaths, UserError } from "../errors.ts";

/**
 * mirrors ExtensionKind in extension_catalog_store.ts, duplicated so this stays
 * in the domain layer without importing infrastructure
 */
export type DuplicateTypeKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export interface DuplicateTypeOccupant {
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly canonicalPath: string;
}

/**
 * a catalog row without an extension identity, such as a source-mounted file,
 * is described rather than rendered as a bare @
 */
export function describeTypeClaimant(occupant: DuplicateTypeOccupant): string {
  return occupant.extensionName === ""
    ? "a source outside any installed extension"
    : `${occupant.extensionName}@${occupant.extensionVersion}`;
}

export interface InstallChange {
  readonly name: string;
  readonly version: string;
  readonly priorVersion: string | null;
}

/**
 * kept: lockfile could not be restored, so every extension stays on its new
 * version. unsettled: rollback could not finish; journals stay for the next
 * install or removal to settle
 */
export type InstallRollbackOutcome =
  | {
    readonly status: "rolled-back";
    readonly reverted?: ReadonlyArray<InstallChange>;
  }
  | { readonly status: "kept"; readonly kept: ReadonlyArray<InstallChange> }
  | { readonly status: "unsettled"; readonly lockfilePath: string };

/**
 * error_output.ts adds the duplicateType field to JSON output; log mode uses
 * just the message
 */
export class DuplicateTypeUserError extends UserError {
  readonly kind: DuplicateTypeKind;
  readonly typeNormalized: string;
  readonly existing: DuplicateTypeOccupant;
  readonly conflicting: DuplicateTypeOccupant;
  readonly isGhostRow: boolean;
  readonly rollback: InstallRollbackOutcome;

  constructor(args: {
    kind: DuplicateTypeKind;
    typeNormalized: string;
    existing: DuplicateTypeOccupant;
    conflicting: DuplicateTypeOccupant;
    isGhostRow?: boolean;
    rollback?: InstallRollbackOutcome;
    /**
     * local-directories: both claimants are local sources in extensions/models
     * and extensions/behaviors, so nothing was installed and the message names
     * the two files
     */
    origin?: "install" | "local-directories";
  }) {
    const ghostRow = args.isGhostRow ?? false;
    const rollback = args.rollback ?? { status: "rolled-back" };
    const recovery = ghostRow
      ? "Ghost catalog entry detected (source deleted outside swamp). " +
        "Run `swamp doctor extensions` to reclassify and retry."
      : args.existing.extensionName === ""
      ? "Change or remove the type declaration in that source first if " +
        "you intended to replace it."
      : `Run \`swamp extension rm ${args.existing.extensionName}\` first if ` +
        `you intended to replace it.`;
    const claimed =
      `Type "${args.typeNormalized}" (kind=${args.kind}) is already claimed by ` +
      `${describeTypeClaimant(args.existing)} ` +
      `at ${args.existing.canonicalPath}.`;
    const conflicting = `${describeTypeClaimant(args.conflicting)} ` +
      `at ${args.conflicting.canonicalPath}`;
    super(
      args.origin === "local-directories"
        ? `Type "${args.typeNormalized}" (kind=${args.kind}) is defined in ` +
          `both ${args.existing.canonicalPath} and ` +
          `${args.conflicting.canonicalPath}. extensions/behaviors/ is ` +
          `another spelling of extensions/models/, so a type may be defined ` +
          `in only one of them. Change or remove the type declaration in ` +
          `one of the two sources.`
        : rollback.status === "kept"
        ? `${claimed} ${conflicting} claims it too, and was installed ` +
          `anyway: the lockfile could not be restored, so the install was ` +
          `kept. ${
            keptAdvice(rollback.kept, args.existing.extensionName, ghostRow)
          }`
        : rollback.status === "unsettled"
        ? `${claimed} Cannot install ${conflicting}. The rollback could not ` +
          `finish: the next \`swamp extension\` install or removal will ` +
          `finish it, or name the install journal to resolve by hand. ` +
          recovery
        : `${claimed} Cannot install ${conflicting} — ` +
          `${
            rolledBackNote(rollback.reverted, args.conflicting.extensionName)
          } ` +
          recovery,
    );
    this.name = "DuplicateTypeUserError";
    this.kind = args.kind;
    this.typeNormalized = args.typeNormalized;
    this.existing = args.existing;
    this.conflicting = args.conflicting;
    this.isGhostRow = ghostRow;
    this.rollback = rollback;
    markErrorPaths(this, [
      args.existing.canonicalPath,
      args.conflicting.canonicalPath,
    ]);
  }

  get rolledBack(): boolean {
    return this.rollback.status === "rolled-back";
  }
}

function keptAdvice(
  kept: ReadonlyArray<InstallChange>,
  existingName: string,
  ghostRow: boolean,
): string {
  // A ghost row's source is gone: reclassifying it, not removing that
  // extension, is what frees the type.
  const other = ghostRow
    ? "run `swamp doctor extensions` to reclassify the ghost catalog " +
      "entry that holds the type"
    : existingName === ""
    ? "change or remove the type declaration in the source that already " +
      "holds the type"
    : `run \`swamp extension rm ${existingName}\` to keep the new version ` +
      `instead`;
  if (kept.length === 0) {
    return `To resolve it, ${other}.`;
  }
  const steps = kept.map((k) =>
    k.priorVersion === null
      ? `\`swamp extension rm ${k.name}\``
      : `\`swamp extension pull ${k.name}@${k.priorVersion}\``
  );
  return `To undo it, run ${steps.join(" and ")}; or ${other}.`;
}

function rolledBackNote(
  reverted: ReadonlyArray<InstallChange> | undefined,
  name: string,
): string {
  const prior = reverted?.find((r) => r.name === name)?.priorVersion;
  return prior
    ? `rolled back; ${name}@${prior} remains installed.`
    : "filesystem changes rolled back.";
}
