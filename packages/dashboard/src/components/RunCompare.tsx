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

import { Fragment } from "react";
import { RouteLink } from "./RouteLink.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { Skeleton } from "./Skeleton.tsx";
import type { CompareRow, TriggerRun } from "../lib/triggers.ts";
import { runRoute } from "./TriggerTables.tsx";

/**
 * Two runs side by side: status, timing, trigger, inputs and every step's
 * outcome. Rows whose values differ are highlighted; durations show the
 * change from A to B instead.
 */
export function RunCompare(
  { a, b, rows, stepsLoading, onClear }: {
    a: TriggerRun;
    b: TriggerRun;
    rows: CompareRow[];
    stepsLoading: boolean;
    onClear: () => void;
  },
) {
  const differing = rows.filter((r) => r.differs).length;
  const sections = ["Run", "Inputs", "Steps"] as const;
  return (
    <section className="run-compare" aria-label="Run comparison">
      <div className="run-compare-head">
        <div>
          <strong>Comparing two runs</strong>
          <span className="trig-muted">
            {differing === 0
              ? " · no differences in status, inputs or steps"
              : ` · ${differing} ${
                differing === 1 ? "difference" : "differences"
              } highlighted`}
          </span>
        </div>
        <button type="button" className="trig-btn" onClick={onClear}>
          Clear selection
        </button>
      </div>
      <div className="table-wrap">
        <table className="data-table run-compare-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Field</span>
              </th>
              {[a, b].map((run, i) => (
                <th scope="col" key={run.runId}>
                  {i === 0 ? "A" : "B"} ·{" "}
                  <RouteLink
                    to={runRoute(run.workflowName, run.runId)}
                    className="mono"
                    title={run.runId}
                  >
                    {run.runId.slice(0, 8)}
                  </RouteLink>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              const sectionRows = rows.filter((r) => r.section === section);
              if (section === "Steps" && stepsLoading) {
                return (
                  <Fragment key={section}>
                    <tr className="run-compare-section">
                      <th colSpan={3} scope="colgroup">Steps</th>
                    </tr>
                    <tr>
                      <td colSpan={3}>
                        <Skeleton width="60%" height={10} />
                      </td>
                    </tr>
                  </Fragment>
                );
              }
              if (sectionRows.length === 0) return null;
              return (
                <Fragment key={section}>
                  <tr className="run-compare-section">
                    <th colSpan={3} scope="colgroup">{section}</th>
                  </tr>
                  {sectionRows.map((row) => (
                    <tr
                      key={`${section}:${row.label}`}
                      className={row.differs ? "is-different" : undefined}
                    >
                      <th scope="row">
                        {row.differs && (
                          <span className="visually-hidden">Differs:</span>
                        )}
                        {row.label}
                      </th>
                      <td>
                        {row.kind === "status"
                          ? <StatusPill status={row.a} />
                          : <span className="run-compare-val">{row.a}</span>}
                      </td>
                      <td>
                        {row.kind === "status"
                          ? <StatusPill status={row.b} />
                          : <span className="run-compare-val">{row.b}</span>}
                        {row.delta && (
                          <span
                            className={`run-compare-delta ${
                              row.delta.startsWith("+") ? "slower" : "faster"
                            }`}
                          >
                            {row.delta}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
