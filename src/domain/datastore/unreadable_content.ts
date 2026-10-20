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

/**
 * Content a datastore could not materialise (swamp-club#3617).
 *
 * @module
 */

import { UserError } from "../errors.ts";

/**
 * The error code of a read of content the datastore could not materialise:
 * a v3 record whose chunk is missing or damaged.
 */
export const UNREADABLE_CONTENT_CODE = "datastore_v3_record_unreadable";

/**
 * Whether `error` is a read of content the datastore could not materialise.
 * Checked by its code, so readers that catch a failed read to treat the
 * content as absent rethrow it instead, whatever class carries the code.
 */
export function isUnreadableContentError(error: unknown): boolean {
  return error instanceof UserError && error.code === UNREADABLE_CONTENT_CODE;
}
