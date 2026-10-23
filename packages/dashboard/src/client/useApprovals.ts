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

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ApprovalsReply } from "./approvals.ts";
import {
  type ApprovalsMark,
  type ApprovalsSnapshot,
  createApprovalsRequest,
  sinceMark,
} from "./approvals_request.ts";
import { useSwamp } from "./SwampProvider.tsx";

export interface SharedApprovals extends ApprovalsSnapshot {
  /** Ordinary reload: coalesces with a read already in flight. */
  refetch(): void;
  /** After a mutation: supersedes any earlier read. */
  refresh(): void;
}

/** Mounted once by Dashboard, which is keyed to the connection generation. */
export function useApprovals(): SharedApprovals {
  const { request } = useSwamp();
  const [owner] = useState(() =>
    createApprovalsRequest(() => request<ApprovalsReply>("workflow.approvals"))
  );
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  useEffect(() => {
    owner.start().catch(() => {});
    return owner.stop;
  }, [owner]);
  const refetch = useCallback(() => {
    owner.reload().catch(() => {});
  }, [owner]);
  const refresh = useCallback(() => {
    owner.refresh().catch(() => {});
  }, [owner]);
  return { ...snapshot, refetch, refresh };
}

/**
 * A page's view of the shared listing. It reads on entry and, as a request
 * the page owned would, shows only what settled after it mounted: a listing
 * retained from before entry could still offer a gate that was decided or
 * expired since, without an error or a way to retry.
 */
export function usePageApprovals(shared: SharedApprovals): SharedApprovals {
  const [mark] = useState<ApprovalsMark>(() => ({
    replies: shared.replies,
    failures: shared.failures,
  }));
  const { refetch } = shared;
  useEffect(() => refetch(), [refetch]);
  return { ...shared, ...sinceMark(shared, mark) };
}
