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

import { useCallback, useEffect, useState } from "react";
import { pendingApprovals } from "./approvals.ts";
import {
  type DecidedGate,
  gateKey,
  pruneDecided,
} from "../components/decision_confirm.ts";

/**
 * The gates decided from this page, each held settled until a
 * `workflow.approvals` reply no longer lists it, so a listing read before
 * the decision landed never offers a second decision (swamp-club#3697).
 */
export function useDecidedGates(approvalsPayload: unknown): {
  decided: ReadonlyMap<string, DecidedGate>;
  hold: (gate: { runId: string; stepName: string }, as: DecidedGate) => void;
} {
  const [decided, setDecided] = useState<ReadonlyMap<string, DecidedGate>>(
    () => new Map(),
  );
  useEffect(() => {
    if (approvalsPayload === null || approvalsPayload === undefined) return;
    const listed = new Set(pendingApprovals(approvalsPayload).map(gateKey));
    setDecided((prev) => pruneDecided(prev, listed));
  }, [approvalsPayload]);
  const hold = useCallback(
    (gate: { runId: string; stepName: string }, as: DecidedGate) =>
      setDecided((prev) => new Map(prev).set(gateKey(gate), as)),
    [],
  );
  return { decided, hold };
}
