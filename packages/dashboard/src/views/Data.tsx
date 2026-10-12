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

import { Select } from "../components/Select.tsx";
import { useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { RouteLink } from "../components/RouteLink";
import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { Skeleton } from "../components/Skeleton";
import { loadState } from "../client/load_state.ts";
import { formatCount, pluralize } from "../lib/format.ts";
import { dataRowLink } from "./artifact_links.ts";
import { DATA_COLUMNS, DataTableSkeleton } from "./PageSkeletons.tsx";

interface DataItem {
  name: string;
  modelName?: string;
  modelType?: string;
  type?: string;
  version?: number;
  tags?: Record<string, string>;
  contentType?: string;
}

const PAGE_SIZE = 25;

export function Data() {
  const [modelFilter, setModelFilter] = useState("");
  const [page, setPage] = useState(0);
  const payload: Record<string, unknown> = {};
  if (modelFilter) payload.model = modelFilter;

  const dataReq = useRequest("data.search", payload);
  const allItems = extractArray<DataItem>(dataReq.data);
  const state = loadState(dataReq, () => allItems.length === 0);

  // Keep the chosen model selectable while its results load.
  const models = [
    ...new Set(
      [modelFilter, ...allItems.map((i) => i.modelName)].filter(
        (m): m is string => Boolean(m),
      ),
    ),
  ];
  const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
  const items = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleModelChange = (m: string) => {
    setModelFilter(m);
    setPage(0);
  };

  return (
    <>
      <div className="page-header">
        <h1>Data</h1>
        <div className="header-right">
          <Select
            value={modelFilter}
            onChange={handleModelChange}
            ariaLabel="Model"
            options={[
              { value: "", label: "All models" },
              ...models.map((m) => ({ value: m, label: m })),
            ]}
          />
          {state === "loading"
            ? <Skeleton width={96} height={28} radius={20} />
            : (
              <div
                className="health-pill"
                style={{
                  background: "var(--surface)",
                  color: "var(--text-2)",
                  border: "1px solid var(--border)",
                }}
              >
                {pluralize(allItems.length, "artifact")}
              </div>
            )}
        </div>
      </div>

      <div className="panel">
        {state === "loading" && <DataTableSkeleton />}
        {state === "error" && (
          <LoadError
            subject="data"
            message={dataReq.error}
            onRetry={dataReq.refetch}
            inset
          />
        )}
        {state === "empty" && (
          modelFilter
            ? (
              <EmptyState
                title={`No data from ${modelFilter}`}
                action={
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => handleModelChange("")}
                  >
                    Show all models
                  </button>
                }
              >
                This model hasn't written any data yet.
              </EmptyState>
            )
            : (
              <EmptyState title="No data yet">
                Models write data — resources, files, reports — when their
                methods run, e.g.{" "}
                <code>swamp model method run my-model create</code>.
              </EmptyState>
            )
        )}
        {state === "ready" && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {DATA_COLUMNS.map((c) => (
                      <th key={c.header}>{c.header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={`${item.name}-${item.modelName}-${page}-${i}`}>
                      <td style={{ fontWeight: 500 }}>
                        {(() => {
                          const to = dataRowLink(item);
                          return to
                            ? <RouteLink to={to}>{item.name}</RouteLink>
                            : item.name;
                        })()}
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--accent)",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          item.modelName && handleModelChange(item.modelName)}
                      >
                        {item.modelName ?? "—"}
                      </td>
                      <td
                        style={{
                          fontSize: "0.82rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {item.type ?? "—"}
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {item.contentType ?? "—"}
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {item.version ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--border)",
                  fontSize: "0.78rem",
                  color: "var(--text-3)",
                }}
              >
                <span>
                  Showing {page * PAGE_SIZE + 1}–
                  {Math.min((page + 1) * PAGE_SIZE, allItems.length)} of{" "}
                  {formatCount(allItems.length)}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                    style={{ opacity: page === 0 ? 0.4 : 1 }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(page + 1)}
                    style={{ opacity: page >= totalPages - 1 ? 0.4 : 1 }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
