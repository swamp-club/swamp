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

import { UserError } from "../errors.ts";

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
  | "driver"
  | "datastore"
  | "report";

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

/**
 * User-facing wrapper thrown by the W2 lifecycle services after FS
 * rollback completes. Extends {@link UserError} so the top-level error
 * renderer formats a clean single-line message in log mode (no stack
 * trace), and carries the structured fields so JSON mode emits them
 * alongside the message.
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

  constructor(args: {
    kind: DuplicateTypeKind;
    typeNormalized: string;
    existing: DuplicateTypeOccupant;
    conflicting: DuplicateTypeOccupant;
    isGhostRow?: boolean;
  }) {
    const ghostRow = args.isGhostRow ?? false;
    const recovery = ghostRow
      ? "Ghost catalog entry detected (source deleted outside swamp). " +
        "Run `swamp doctor extensions` to reclassify and retry."
      : `Run \`swamp extension rm ${args.existing.extensionName}\` first if ` +
        `you intended to replace it.`;
    super(
      `Type "${args.typeNormalized}" (kind=${args.kind}) is already claimed by ` +
        `${args.existing.extensionName}@${args.existing.extensionVersion} ` +
        `at ${args.existing.canonicalPath}. Cannot install ` +
        `${args.conflicting.extensionName}@${args.conflicting.extensionVersion} ` +
        `at ${args.conflicting.canonicalPath} — filesystem changes rolled back. ` +
        recovery,
    );
    this.name = "DuplicateTypeUserError";
    this.kind = args.kind;
    this.typeNormalized = args.typeNormalized;
    this.existing = args.existing;
    this.conflicting = args.conflicting;
    this.isGhostRow = ghostRow;
  }
}
