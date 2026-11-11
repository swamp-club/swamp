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
import type { SwampifyRow } from "../../client/swampify.ts";
import type { ComparisonRecord } from "../../client/useSwampify.ts";
import type {
  SwampifyCandidate,
  SwampifyOfferOption,
  SwampifyRange,
} from "../../lib/agent_sessions/swampify.ts";
import {
  CONSIDERED_LABEL,
  formatDuration,
  formatRate,
  formatSpread,
  formatTokens,
  KIND_LABEL,
  type SwampifyConsidered,
} from "../../lib/swampify_view.ts";
import { formatAbsoluteTime, formatCount } from "../../lib/format.ts";
import { InvocationIcon } from "./SessionsTable.tsx";
import { ComparisonBlock } from "./SwampifyComparison.tsx";
import { SessionRef } from "./SwampifyParts.tsx";

/** The key a candidate's own comparison toggle uses, apart from the offer's. */
export function candidateComparisonKey(candidateId: string): string {
  return `candidate:${candidateId}`;
}

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function RangeRow(
  { label, range, format }: {
    label: string;
    range: SwampifyRange;
    format: (n: number) => string;
  },
) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="as-num">{format(range.min)}</td>
      <td className="as-num">{format(range.median)}</td>
      <td className="as-num">{format(range.max)}</td>
    </tr>
  );
}

export interface CandidatesProps {
  readonly candidates: readonly SwampifyCandidate[];
  readonly open: ReadonlySet<string>;
  readonly onToggle: (candidateId: string) => void;
  readonly options: ReadonlyMap<string, SwampifyOfferOption>;
  readonly considered: ReadonlyMap<string, SwampifyConsidered>;
  readonly labels: ReadonlyMap<string, string>;
  readonly comparisons: ReadonlyMap<string, SwampifyRow>;
  readonly openComparisons: ReadonlySet<string>;
  readonly onToggleComparison: (key: string) => void;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  readonly loadedSessions: ReadonlySet<string>;
  readonly onOpenSession: (name: string) => void;
}

function Placement(
  { option, considered, labels }: {
    option: SwampifyOfferOption | undefined;
    considered: SwampifyConsidered | undefined;
    labels: ReadonlyMap<string, string>;
  },
) {
  if (option) {
    return (
      <div className="as-muted as-sw-sub">In the offer: {option.name}</div>
    );
  }
  if (!considered) return null;
  return (
    <div className="as-muted as-sw-sub">
      Left out: {CONSIDERED_LABEL[considered.reason]}
      {considered.into !== undefined && (
        <>
          {` into ${
            labels.get(considered.into) ?? "a candidate not in this set"
          }`}
        </>
      )}
    </div>
  );
}

/** Ranked candidates, one row each; a row opens to its ranges and evidence. */
export function CandidatesTable(props: CandidatesProps) {
  const { candidates, open, onToggle } = props;
  return (
    <div className="as-sw-table-wrap">
      <table className="data-table as-table as-sw-candidates">
        <colgroup>
          <col className="as-sw-c-narrow" />
          <col />
          <col className="as-sw-c-narrow" />
          <col className="as-sw-c-num" />
          <col className="as-sw-c-num" />
          <col className="as-sw-c-narrow" />
          <col className="as-sw-c-seen" />
          <col className="as-sw-c-num" />
          <col className="as-sw-c-num" />
          <col className="as-sw-c-num" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="as-num">#</th>
            <th scope="col">Candidate</th>
            <th scope="col" className="as-type-col">Type</th>
            <th scope="col" className="as-num">Runs</th>
            <th scope="col" className="as-num">Sessions</th>
            <th scope="col" className="as-num">Dirs</th>
            <th scope="col">Seen</th>
            <th
              scope="col"
              className="as-num"
              title="Median weighted tokens per run"
            >
              Tokens
            </th>
            <th
              scope="col"
              className="as-num"
              title="Median tool calls per run"
            >
              Calls
            </th>
            <th
              scope="col"
              className="as-num"
              title="Share of runs with a failed call"
            >
              Failed
            </th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            const isOpen = open.has(c.id);
            const w = c.perOccurrence.weightedTokens;
            const calls = c.perOccurrence.toolCalls;
            return (
              <Fragment key={c.id}>
                <tr className="as-row" aria-selected={isOpen}>
                  <td className="as-num">{c.rank}</td>
                  <td>
                    <button
                      type="button"
                      className="as-link-button as-sw-label"
                      aria-expanded={isOpen}
                      onClick={() => onToggle(c.id)}
                    >
                      {c.label}
                    </button>
                    <div className="as-muted as-sw-sub">
                      {KIND_LABEL[c.kind]}
                    </div>
                    <Placement
                      option={props.options.get(c.id)}
                      considered={props.considered.get(c.id)}
                      labels={props.labels}
                    />
                  </td>
                  <td className="as-type-col">
                    <InvocationIcon invocation={c.invocation} />
                  </td>
                  <td className="as-num">{formatCount(c.occurrences)}</td>
                  <td className="as-num">{formatCount(c.sessions)}</td>
                  <td className="as-num">{formatCount(c.directories)}</td>
                  <td
                    className="as-nowrap"
                    title={`${formatAbsoluteTime(c.firstSeen)} to ${
                      formatAbsoluteTime(c.lastSeen)
                    }`}
                  >
                    {day(c.firstSeen)}
                    <div className="as-muted">to {day(c.lastSeen)}</div>
                  </td>
                  <td className="as-num" title={formatSpread(w, formatTokens)}>
                    {formatTokens(w.median)}
                  </td>
                  <td
                    className="as-num"
                    title={formatSpread(calls, formatTokens)}
                  >
                    {formatTokens(calls.median)}
                  </td>
                  <td
                    className={`as-num${c.failureRate > 0 ? " as-failed" : ""}`}
                  >
                    {formatRate(c.failureRate)}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="as-sw-detail-row">
                    <td colSpan={10}>
                      <CandidateDetail {...props} candidate={c} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CandidateDetail(
  props: CandidatesProps & { candidate: SwampifyCandidate },
) {
  const c = props.candidate;
  const cost = c.perOccurrence;
  const option = props.options.get(c.id);
  const key = candidateComparisonKey(c.id);
  return (
    <div className="as-sw-detail">
      <table className="as-sw-ranges">
        <caption className="as-muted">Per run</caption>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="as-num">Min</th>
            <th scope="col" className="as-num">Median</th>
            <th scope="col" className="as-num">Max</th>
          </tr>
        </thead>
        <tbody>
          <RangeRow
            label="Weighted tokens"
            range={cost.weightedTokens}
            format={formatTokens}
          />
          <RangeRow
            label="Input tokens"
            range={cost.tokens.input}
            format={formatTokens}
          />
          <RangeRow
            label="Output tokens"
            range={cost.tokens.output}
            format={formatTokens}
          />
          <RangeRow
            label="Cache read tokens"
            range={cost.tokens.cacheRead}
            format={formatTokens}
          />
          <RangeRow
            label="Cache write tokens"
            range={cost.tokens.cacheWrite}
            format={formatTokens}
          />
          <RangeRow
            label="Tool calls"
            range={cost.toolCalls}
            format={formatTokens}
          />
          <RangeRow
            label="Active time"
            range={cost.activeMs}
            format={formatDuration}
          />
        </tbody>
      </table>
      <div className="as-sw-evidence">
        {c.steps && (
          <>
            <div className="as-sw-sub">Steps</div>
            <ol className="as-sw-outline">
              {c.steps.map((step, i) => (
                <li key={i}>
                  <code>{step}</code>
                </li>
              ))}
            </ol>
          </>
        )}
        {c.program !== undefined && (
          <div>
            <span className="as-sw-sub">Program</span> <code>{c.program}</code>
          </div>
        )}
        <div className="as-sw-sub">Excerpts</div>
        {c.excerpts.length === 0
          ? <div className="as-muted">No excerpts kept.</div>
          : (
            <ul className="as-sw-excerpts">
              {c.excerpts.map((e, i) => (
                <li key={i}>
                  <span className="as-muted">
                    {e.source === "prompt" ? "Prompt" : "Call"}
                  </span>
                  <pre className="as-sw-excerpt">{e.text}</pre>
                  {e.truncated && (
                    <span className="as-muted">
                      (cut to fit)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        <div className="as-sw-sub">
          Seen in {formatCount(c.sessions)} sessions
          {c.sessionRefs.length < c.sessions &&
            `, the latest ${c.sessionRefs.length} listed`}
        </div>
        <ul className="as-sw-refs">
          {c.sessionRefs.map((ref) => (
            <li key={`${ref.harness}/${ref.sessionId}`}>
              <SessionRef
                sessionRef={ref}
                loaded={props.loadedSessions}
                onOpen={props.onOpenSession}
              />
            </li>
          ))}
        </ul>
        {option
          ? (
            <>
              <div className="as-sw-sub">Comparison for “{option.name}”</div>
              <ComparisonBlock
                row={props.comparisons.get(option.id)}
                open={props.openComparisons.has(key)}
                onToggle={() => props.onToggleComparison(key)}
                records={props.records}
                onLoad={props.onLoadComparison}
              />
            </>
          )
          : (
            <div className="as-muted">
              Not compared: no offer option holds it.
            </div>
          )}
      </div>
    </div>
  );
}
