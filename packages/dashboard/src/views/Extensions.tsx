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

import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { Skeleton } from "../components/Skeleton";
import { loadState } from "../client/load_state.ts";
import { formatCount } from "../lib/format.ts";
import {
  EXTENSION_COLUMNS,
  ExtensionsTableSkeleton,
} from "./PageSkeletons.tsx";

interface ExtensionEntry {
  name: string;
  version: string;
  updateStatus?: string;
  channel?: string;
}

export function Extensions() {
  const req = useRequest("extension.list");
  const extensions = extractArray<ExtensionEntry>(req.data);
  const state = loadState(req, () => extensions.length === 0);

  return (
    <>
      <div className="page-header">
        <h1>Extensions</h1>
        <div className="header-right">
          {state === "loading"
            ? <Skeleton width={92} height={28} radius={20} />
            : (
              <div
                className="health-pill"
                style={{
                  background: "var(--surface)",
                  color: "var(--text-2)",
                  border: "1px solid var(--border)",
                }}
              >
                {formatCount(extensions.length)} installed
              </div>
            )}
        </div>
      </div>

      <div className="panel">
        {state === "loading" && <ExtensionsTableSkeleton />}
        {state === "error" && (
          <LoadError
            subject="extensions"
            message={req.error}
            onRetry={req.refetch}
            inset
          />
        )}
        {state === "empty" && (
          <EmptyState title="No extensions installed">
            Extensions add behavior types, vaults and datastores to this repo.
            Install one with <code>swamp extension pull @collective/name</code>.
          </EmptyState>
        )}
        {state === "ready" && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {EXTENSION_COLUMNS.map((c) => (
                    <th key={c.header}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {extensions.map((ext) => (
                  <tr key={ext.name}>
                    <td style={{ fontWeight: 500 }}>{ext.name}</td>
                    <td>
                      <span className="cron-badge">{ext.version}</span>
                    </td>
                    <td
                      style={{ fontSize: "0.82rem", color: "var(--text-3)" }}
                    >
                      {ext.channel ?? "stable"}
                    </td>
                    <td>
                      <StatusPill
                        status={ext.updateStatus === "update_available"
                          ? "suspended"
                          : "succeeded"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
