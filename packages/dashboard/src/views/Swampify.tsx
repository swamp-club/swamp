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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useCallback } from "react";
import { useComparisonRecords, useSwampify } from "../client/useSwampify.ts";
import { useSwamp } from "../client/SwampProvider.tsx";
import { PAGE_WORKSPACE } from "../client/workspace_path.ts";
import type { SwampifyLauncher } from "../lib/swampify_view.ts";
import { navigateTo } from "../hooks/useRouter.ts";
import { SwampifyPage } from "./swampify/SwampifyPage.tsx";
import "../styles/swampify.css";

/** The page wired to serve: reads its items and comparison bodies itself. */
export function Swampify({ optionId }: { optionId: string | null }) {
  const state = useSwampify();
  const { records, load } = useComparisonRecords();
  const { request } = useSwamp();
  const launch = useCallback<SwampifyLauncher>(async (text, harness) => {
    const reply = await request<
      { data?: { opened?: boolean; command?: string } }
    >("swampify.launch", { text, harness, trustConfirmed: true });
    return {
      opened: reply.data?.opened === true,
      command: reply.data?.command ?? "",
    };
  }, [request]);
  return (
    <SwampifyPage
      state={state}
      records={records}
      onLoadComparison={(row) => void load(row)}
      optionId={optionId}
      launch={PAGE_WORKSPACE === null ? undefined : launch}
      onOpenOption={(id) =>
        navigateTo({
          view: "swampify",
          detail: id === null ? null : { kind: "swampifyOption", optionId: id },
        })}
    />
  );
}
