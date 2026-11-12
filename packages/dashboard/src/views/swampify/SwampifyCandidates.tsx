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
import { Fragment, type ReactNode } from "react";
import type {
  SwampifyCandidate,
  SwampifyOfferOption,
} from "../../lib/agent_sessions/swampify.ts";
import {
  formatDay,
  formatDuration,
  formatRate,
  formatSpread,
  formatTokens,
  KIND_LABEL,
} from "../../lib/swampify_view.ts";
import { formatCount, pluralize } from "../../lib/format.ts";
import { ReviewIcon } from "./SwampifyParts.tsx";

export interface CandidatesProps {
  readonly candidates: readonly SwampifyCandidate[];
  readonly open: string | null;
  readonly onToggle: (candidateId: string) => void;
  /** The option each candidate is in; before an offer, none. */
  readonly options: ReadonlyMap<string, SwampifyOfferOption>;
  readonly onReview: (optionId: string) => void;
  /** Where the candidates came from, under the heading. */
  readonly about?: ReactNode;
}

function CandidateDetail(
  { c, option, onReview }: {
    c: SwampifyCandidate;
    option: SwampifyOfferOption | undefined;
    onReview: (optionId: string) => void;
  },
) {
  const cost = c.perOccurrence;
  return (
    <div className="sw-detail">
      {option && (
        <div className="sw-detail-action">
          <span className="sw-muted">
            Part of <strong>{option.name}</strong>
          </span>
          <button
            type="button"
            className="sw-icon-btn"
            aria-label={`Review and build ${option.name}`}
            title="Review and build"
            onClick={() => onReview(option.id)}
          >
            <ReviewIcon />
          </button>
        </div>
      )}
      <div className="sw-detail-col">
        <div className="sw-sub">What it looks like</div>
        {c.steps && (
          <ol className="sw-steps">
            {c.steps.map((step, i) => (
              <li key={i}>
                <code>{step}</code>
              </li>
            ))}
          </ol>
        )}
        {c.program !== undefined && (
          <div>
            Runs <code>{c.program}</code> directly
          </div>
        )}
        {c.excerpts.length === 0
          ? <div className="sw-muted">No excerpts kept.</div>
          : c.excerpts.map((e, i) => (
            <pre key={i} className="sw-excerpt">
              {e.text}{e.truncated ? " …" : ""}
            </pre>
          ))}
      </div>
      <div className="sw-detail-col">
        <div className="sw-sub">Per run, min to max</div>
        <div>
          Weighted tokens: {formatSpread(cost.weightedTokens, formatTokens)}
        </div>
        <div>Tool calls: {formatSpread(cost.toolCalls, formatTokens)}</div>
        <div>Active time: {formatSpread(cost.activeMs, formatDuration)}</div>
        <div className="sw-sub">Seen in</div>
        <div>
          {pluralize(c.directories, "folder")}, first{" "}
          {formatDay(c.firstSeen)}, last {formatDay(c.lastSeen)}
        </div>
      </div>
    </div>
  );
}

/**
 * Candidates by rank. A row opens to its evidence and the button to its
 * option's review.
 */
export function CandidatesTable(props: CandidatesProps) {
  return (
    <section className="sw-card sw-candidates" aria-labelledby="sw-cand-h">
      <div className="sw-pad sw-cand-head">
        <div className="sw-section-head">
          <h2 id="sw-cand-h">
            Candidates{" "}
            <span className="sw-muted">
              ·{" "}
              {formatCount(props.candidates.length)}, ranked by what they cost
              you
            </span>
          </h2>
          <span className="sw-muted sw-small">
            Medians per run · open a row for its evidence
          </span>
        </div>
        {props.about}
      </div>
      <div className="sw-scroll">
        <table className="sw-table">
          <colgroup>
            <col style={{ width: 44 }} />
            <col />
            <col style={{ width: 130 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 70 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Candidate</th>
              <th scope="col">Kind</th>
              <th scope="col" className="sw-num">Runs</th>
              <th scope="col" className="sw-num">Sessions</th>
              <th scope="col" className="sw-num">Tokens</th>
              <th scope="col" className="sw-num">Failed</th>
            </tr>
          </thead>
          <tbody>
            {props.candidates.map((c) => {
              const isOpen = props.open === c.id;
              const option = props.options.get(c.id);
              return (
                <Fragment key={c.id}>
                  <tr
                    className={`sw-row${isOpen ? " sw-row-open" : ""}`}
                    onClick={() => props.onToggle(c.id)}
                  >
                    <td className="sw-muted">{c.rank}</td>
                    <td>
                      <button
                        type="button"
                        className="sw-row-toggle"
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onToggle(c.id);
                        }}
                      >
                        {c.label}
                      </button>
                    </td>
                    <td className="sw-small">{KIND_LABEL[c.kind]}</td>
                    <td className="sw-num">{formatCount(c.occurrences)}</td>
                    <td className="sw-num">{formatCount(c.sessions)}</td>
                    <td className="sw-num">
                      {formatTokens(c.perOccurrence.weightedTokens.median)}
                    </td>
                    <td
                      className={`sw-num${c.failureRate > 0 ? " sw-fail" : ""}`}
                    >
                      {formatRate(c.failureRate)}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="sw-detail-row">
                      <td colSpan={7}>
                        <CandidateDetail
                          c={c}
                          option={option}
                          onReview={props.onReview}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
