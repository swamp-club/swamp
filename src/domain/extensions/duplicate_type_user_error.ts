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
 * The kind of bundle entry — mirrors `ExtensionKind` in
 * `infrastructure/persistence/extension_catalog_store.ts`. Duplicated
 * here so {@link DuplicateTypeUserError} (which presentation needs to
 * import) can stay in the domain layer without pulling in infrastructure.
 */
export type DuplicateTypeKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

/**
 * Carries enough information to point a user at one of the two
 * extensions sharing the conflicting `(kind, typeNormalized)` so they
 * can resolve the conflict by hand.
 */
export interface DuplicateTypeOccupant {
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly canonicalPath: string;
}

/** One extension of an install that collided, and its version before. */
export interface InstallChange {
  readonly name: string;
  /** The version the install put in. */
  readonly version: string;
  /** The version installed before, or null when there was none. */
  readonly priorVersion: string | null;
}

/**
 * How the rollback of an install that collided ended.
 *
 * - `rolled-back`: every extension in the install (listed in `reverted`)
 *   is back on its prior version, or gone where there was none.
 * - `kept`: the lockfile could not be restored and was left untouched,
 *   so every extension stays on its new version, consistently.
 * - `unsettled`: the rollback could not finish (the lockfile could not
 *   be read back, it held neither the restored entries nor the new
 *   ones, or a root could not be moved back). The install journals stay
 *   for the next extension install or removal, which settles each from
 *   its lockfile entry, or names a journal whose disk state it cannot
 *   account for.
 */
export type InstallRollbackOutcome =
  | {
    readonly status: "rolled-back";
    readonly reverted?: ReadonlyArray<InstallChange>;
  }
  | { readonly status: "kept"; readonly kept: ReadonlyArray<InstallChange> }
  | { readonly status: "unsettled"; readonly lockfilePath: string };

/**
 * User-facing wrapper thrown by the W2 lifecycle services after the
 * install that collided is rolled back (see `rollback`). Extends
 * {@link UserError} so the top-level error renderer formats a clean
 * single-line message in log mode (no stack trace), and carries the
 * structured fields so JSON mode emits them alongside the message.
 *
 * **JSON shape pinned by plan v4 step 11:**
 *
 * ```json
 * {
 *   "error": "<human-readable single-line message>",
 *   "duplicateType": {
 *     "kind": "model",
 *     "type": "@scope/foo",
 *     "isGhostRow": false,
 *     "rolledBack": true,
 *     "rollback": { "status": "rolled-back" },
 *     "existing": {
 *       "extensionName": "@scopeA/aa",
 *       "extensionVersion": "1.0.0",
 *       "canonicalPath": "/repo/.swamp/pulled-extensions/@scopeA/aa/models/foo.ts"
 *     },
 *     "conflicting": {
 *       "extensionName": "@scopeB/bb",
 *       "extensionVersion": "1.0.0",
 *       "canonicalPath": "/repo/.swamp/pulled-extensions/@scopeB/bb/models/foo.ts"
 *     }
 *   }
 * }
 * ```
 *
 * `presentation/output/error_output.ts` recognises this subclass and
 * adds the `duplicateType` field to the JSON output. Log mode uses
 * just the message, as for any other UserError.
 */
export class DuplicateTypeUserError extends UserError {
  readonly kind: DuplicateTypeKind;
  readonly typeNormalized: string;
  readonly existing: DuplicateTypeOccupant;
  readonly conflicting: DuplicateTypeOccupant;
  readonly isGhostRow: boolean;
  /** How the rollback of the install ended; `rolled-back` by default. */
  readonly rollback: InstallRollbackOutcome;

  constructor(args: {
    kind: DuplicateTypeKind;
    typeNormalized: string;
    existing: DuplicateTypeOccupant;
    conflicting: DuplicateTypeOccupant;
    isGhostRow?: boolean;
    rollback?: InstallRollbackOutcome;
  }) {
    const ghostRow = args.isGhostRow ?? false;
    const rollback = args.rollback ?? { status: "rolled-back" };
    const recovery = ghostRow
      ? "Ghost catalog entry detected (source deleted outside swamp). " +
        "Run `swamp doctor extensions` to reclassify and retry."
      : `Run \`swamp extension rm ${args.existing.extensionName}\` first if ` +
        `you intended to replace it.`;
    const claimed =
      `Type "${args.typeNormalized}" (kind=${args.kind}) is already claimed by ` +
      `${args.existing.extensionName}@${args.existing.extensionVersion} ` +
      `at ${args.existing.canonicalPath}.`;
    const conflicting =
      `${args.conflicting.extensionName}@${args.conflicting.extensionVersion} ` +
      `at ${args.conflicting.canonicalPath}`;
    super(
      rollback.status === "kept"
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

  /** True when the install that collided was rolled back. */
  get rolledBack(): boolean {
    return this.rollback.status === "rolled-back";
  }
}

/**
 * What to run to get out of a kept install: go back to each extension's
 * prior version, or remove one it installed fresh; or remove the
 * extension that already held the type.
 */
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

/**
 * What a rollback left installed of the extension that collided: its
 * previous version when it had one.
 */
function rolledBackNote(
  reverted: ReadonlyArray<InstallChange> | undefined,
  name: string,
): string {
  const prior = reverted?.find((r) => r.name === name)?.priorVersion;
  return prior
    ? `rolled back; ${name}@${prior} remains installed.`
    : "filesystem changes rolled back.";
}
