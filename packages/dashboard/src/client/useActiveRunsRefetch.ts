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

import { useEffect, useRef } from "react";
import {
  type ActiveRunRef,
  activeRunsKey,
  shouldRefetchRuns,
} from "./resume_state";

/**
 * Refetches a view's runs when the health snapshot shows serve starting or
 * finishing a run, or still driving one the rows show suspended. Keeps
 * approved runs that serve resumes itself in step with serve, whoever made
 * the approval. At most one refetch per snapshot.
 */
export function useActiveRunsRefetch(
  activeRuns: readonly ActiveRunRef[] | undefined,
  rows: readonly { runId: string; status: string }[],
  refetch: () => void,
): void {
  const previousKey = useRef(activeRunsKey(activeRuns));
  const latest = useRef({ rows, refetch });
  latest.current = { rows, refetch };

  useEffect(() => {
    const refetchNeeded = shouldRefetchRuns(
      previousKey.current,
      activeRuns,
      latest.current.rows,
    );
    previousKey.current = activeRunsKey(activeRuns);
    if (refetchNeeded) latest.current.refetch();
  }, [activeRuns]);
}
