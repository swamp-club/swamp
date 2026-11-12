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
import type { ReactNode } from "react";
import {
  comparisonSummaryOf,
  type SwampifyRow,
} from "../../client/swampify.ts";
import {
  comparisonKey,
  type ComparisonRecord,
} from "../../client/useSwampify.ts";
import type {
  SwampifyComparison,
  SwampifyCostRange,
  SwampifyRange,
} from "../../lib/agent_sessions/swampify.ts";
import {
  formatBreakEven,
  formatDay,
  formatDuration,
  formatSpread,
  formatTokens,
  formatUsd,
} from "../../lib/swampify_view.ts";
import { formatCount } from "../../lib/format.ts";
import { SkipNotice } from "./SwampifyParts.tsx";

export interface ComparisonProps {
  /** The option's comparison row, or undefined when none is listed. */
  readonly row: SwampifyRow | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoad: (row: SwampifyRow) => void;
}

/**
 * One option's comparison: a line from its summary tag, and the body once
 * opened. An option with no comparison the viewer can read says it is not
 * compared.
 */
export function ComparisonBlock(
  { row, open, onToggle, records, onLoad }: ComparisonProps,
) {
  if (row === undefined) {
    return <div className="sw-muted sw-compare">Not compared yet.</div>;
  }
  const summary = comparisonSummaryOf(row);
  return (
    <div className="sw-compare">
      <div className="sw-compare-head">
        <span>
          {summary
            ? (
              <>
                Compared: {summary.target.kind}{" "}
                <code>{summary.target.name}</code>, run{" "}
                <span
                  className={summary.outcome === "failed" ? "sw-fail" : ""}
                >
                  {summary.outcome}
                </span>
                {" · "}
                {formatBreakEven(summary.breakEven)}
              </>
            )
            : "Compared"}
        </span>
        <button
          type="button"
          className="sw-link"
          aria-expanded={open}
          onClick={() => {
            if (!open) onLoad(row);
            onToggle();
          }}
        >
          {open ? "Hide comparison" : "Show comparison"}
        </button>
      </div>
      {open && <ComparisonBody row={row} records={records} onLoad={onLoad} />}
    </div>
  );
}

/** A comparison's body: loading, an error with a retry, a skip, or figures. */
export function ComparisonBody(
  { row, records, onLoad }: {
    row: SwampifyRow;
    records: ReadonlyMap<string, ComparisonRecord>;
    onLoad: (row: SwampifyRow) => void;
  },
) {
  const record = records.get(comparisonKey(row));
  return (
    record === undefined || record.state === "loading"
      ? <div className="sw-muted">Loading the comparison…</div>
      : record.state === "error"
      ? (
        <div className="sw-fail">
          Could not load the comparison: {record.error}{" "}
          <button
            type="button"
            className="sw-link"
            onClick={() => onLoad(row)}
          >
            Retry
          </button>
        </div>
      )
      : record.reading.kind === "skipped"
      ? <SkipNotice item="comparison" skipped={record.reading} />
      : <ComparisonDetail comparison={record.reading.record} />
  );
}

function Cell({ range, format }: {
  range: SwampifyRange | undefined;
  format: (n: number) => string;
}) {
  if (range === undefined) return <td className="sw-num sw-muted">—</td>;
  return (
    <td className="sw-num">
      {format(range.median)}
      <div className="sw-muted sw-spread">{formatSpread(range, format)}</div>
    </td>
  );
}

const METRICS: ReadonlyArray<
  readonly [
    string,
    (c: SwampifyCostRange) => SwampifyRange,
    (n: number) => string,
  ]
> = [
  ["Input tokens", (c) => c.tokens.input, formatTokens],
  ["Output tokens", (c) => c.tokens.output, formatTokens],
  ["Cache read tokens", (c) => c.tokens.cacheRead, formatTokens],
  ["Cache write tokens", (c) => c.tokens.cacheWrite, formatTokens],
  ["Tool calls", (c) => c.toolCalls, formatTokens],
  ["Active time", (c) => c.activeMs, formatDuration],
];

function tokenLine(t: SwampifyComparison["build"]["tokens"]): string {
  return `in ${formatTokens(t.input)} · out ${
    formatTokens(t.output)
  } · cache read ${formatTokens(t.cacheRead)} · cache write ${
    formatTokens(t.cacheWrite)
  }`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A comparison's figures as stored: medians, with each range beneath. */
export function ComparisonDetail(
  { comparison }: { comparison: SwampifyComparison },
) {
  const { history, forward, build, swampRun, estimatedUsd } = comparison;
  const columns: ReadonlyArray<
    readonly [string, number, SwampifyCostRange | undefined]
  > = [
    [
      "Past runs: the chore's calls",
      history.occurrences,
      history.perOccurrence?.chore,
    ],
    [
      "Past runs: whole turns",
      history.occurrences,
      history.perOccurrence?.wholeTurns,
    ],
    ["Since: still raw", forward.raw.occurrences, forward.raw.perOccurrence],
    [
      "Since: through swamp",
      forward.swamp.occurrences,
      forward.swamp.perOccurrence,
    ],
  ];
  return (
    <div className="sw-compare-body">
      <table className="data-table sw-compare-table">
        <caption className="sw-muted">
          Per run, median with the range beneath. "Since" counts runs after{" "}
          {formatDay(forward.since)}.
        </caption>
        <thead>
          <tr>
            <th scope="col">Per run</th>
            {columns.map(([label, runs]) => (
              <th key={label} scope="col" className="sw-num">
                {label}
                <div className="sw-muted">{formatCount(runs)} runs</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map(([label, pick, format]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {columns.map(([column, , cost]) => (
                <Cell
                  key={column}
                  range={cost ? pick(cost) : undefined}
                  format={format}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="sw-dl">
        <Row label="Target">
          {comparison.target.kind} <code>{comparison.target.name}</code>
        </Row>
        <Row label="Build cost">
          {tokenLine(build.tokens)}, {formatDuration(build.activeMs)} active
        </Row>
        <Row label="Swamp run">
          <span className={swampRun.outcome === "failed" ? "sw-fail" : ""}>
            {swampRun.outcome}
          </span>{" "}
          in {formatDuration(swampRun.wallMs)}; model tokens{" "}
          {tokenLine(swampRun.tokens)}
        </Row>
        <Row label="Break-even">{formatBreakEven(comparison.breakEven)}</Row>
        {estimatedUsd && (
          <Row label="Estimated cost">
            {[
              estimatedUsd.build !== undefined &&
              `build ${formatUsd(estimatedUsd.build)}`,
              estimatedUsd.historyPerOccurrence &&
              `past run ${
                formatSpread(estimatedUsd.historyPerOccurrence.chore, formatUsd)
              } (chore) to ${
                formatSpread(
                  estimatedUsd.historyPerOccurrence.wholeTurns,
                  formatUsd,
                )
              } (whole turns)`,
              estimatedUsd.swampRun !== undefined &&
              `swamp run ${formatUsd(estimatedUsd.swampRun)}`,
            ].filter(Boolean).join("; ")}{" "}
            <span className="sw-muted">
              (an estimate from the writer's prices)
            </span>
          </Row>
        )}
      </dl>
    </div>
  );
}
