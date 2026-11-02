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
import { markErrorPaths } from "../../domain/errors.ts";
import { describeTypeClaimant } from "../../domain/extensions/duplicate_type_user_error.ts";

/**
 * both sources must be populated so the user can resolve by hand; when one side
 * belongs to the failed save, first is the existing occupant, otherwise catalog
 * order
 */
export interface DuplicateTypeOccupant {
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly canonicalPath: string;
}

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
        `claimed by both ${describeTypeClaimant(args.firstSource)} ` +
        `at ${args.firstSource.canonicalPath} ` +
        `and ${describeTypeClaimant(args.secondSource)} ` +
        `at ${args.secondSource.canonicalPath}. ROLLBACK applied.`,
    );
    this.name = "DuplicateTypeError";
    this.kind = args.kind;
    this.typeNormalized = args.typeNormalized;
    this.firstSource = args.firstSource;
    this.secondSource = args.secondSource;
    markErrorPaths(this, [
      args.firstSource.canonicalPath,
      args.secondSource.canonicalPath,
    ]);
  }
}
