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
  CommitUnreachableError,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ReadModelCatchUpUnreachableError } from "../../domain/datastore_v3/read_model.ts";
import { V3StorageUnreachableError } from "../../domain/datastore_v3/writer_lease.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";

export const MAX_OUTAGE_CAUSE_DEPTH = 8;

/** serve, which a team checkout writes through, is the storage it reaches */
export function isDatastoreOutage(error: unknown): boolean {
  return error instanceof CommitUnreachableError ||
    error instanceof RunPartlyCommittedError ||
    error instanceof V3StorageUnreachableError ||
    error instanceof ReadModelCatchUpUnreachableError ||
    error instanceof ServeUnreachableError;
}

export function causeChainHoldsDatastoreOutage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_OUTAGE_CAUSE_DEPTH; depth++) {
    if (isDatastoreOutage(current)) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}
