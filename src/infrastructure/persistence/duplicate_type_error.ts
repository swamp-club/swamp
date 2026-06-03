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

import type { ExtensionKind } from "./extension_catalog_store.ts";

/**
 * Carries enough information to point a user at both Sources sharing
 * the conflicting `(kind, typeNormalized)` so they can resolve the
 * conflict by hand.
 *
 * Both `firstSource` and `secondSource` MUST be populated — naming both
 * paths is a hard requirement of the design. Naming only one is the
 * "first-wins" silent corruption W1b is closing.
 */
export interface DuplicateTypeOccupant {
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly canonicalPath: string;
}

/**
 * Thrown by `ExtensionRepository.saveAll` when two non-Tombstoned
 * Sources across the post-save catalog state share the same
 * `(kind, typeNormalized)` tuple. The transaction is rolled back before
 * the throw, so the catalog is left in its pre-save state.
 *
 * The day-to-day case for I-Repo-1 firing legitimately is exactly the
 * upgrade-as-atomic-transition transaction:
 * `saveAll([vN.tombstoneAll(), vN+1])`. When that transaction succeeds,
 * v1's Sources are Tombstoned in the post-state and only v2 occupies
 * the type slot. If the lifecycle service forgets the `tombstoneAll()`
 * step, this error fires — naming both v1's and v2's source paths so
 * the developer can see what happened.
 */
export class DuplicateTypeError extends Error {
  readonly kind: ExtensionKind;
  readonly typeNormalized: string;
  readonly firstSource: DuplicateTypeOccupant;
  readonly secondSource: DuplicateTypeOccupant;

  constructor(args: {
    kind: ExtensionKind;
    typeNormalized: string;
    firstSource: DuplicateTypeOccupant;
    secondSource: DuplicateTypeOccupant;
  }) {
    super(
      `I-Repo-1 violation: type "${args.typeNormalized}" (kind=${args.kind}) ` +
        `claimed by both ${args.firstSource.extensionName}@${args.firstSource.extensionVersion} ` +
        `at ${args.firstSource.canonicalPath} ` +
        `and ${args.secondSource.extensionName}@${args.secondSource.extensionVersion} ` +
        `at ${args.secondSource.canonicalPath}. ROLLBACK applied.`,
    );
    this.name = "DuplicateTypeError";
    this.kind = args.kind;
    this.typeNormalized = args.typeNormalized;
    this.firstSource = args.firstSource;
    this.secondSource = args.secondSource;
  }
}

// `DuplicateTypeUserError` (the user-facing wrapper) lives in
// `src/domain/extensions/duplicate_type_user_error.ts` so the
// presentation layer can import it without violating DDD layer rules.
