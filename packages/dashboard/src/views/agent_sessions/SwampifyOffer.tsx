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
import type { SwampifyRow } from "../../client/swampify.ts";
import type { ComparisonRecord } from "../../client/useSwampify.ts";
import type { SwampifyOffer } from "../../lib/agent_sessions/swampify.ts";
import {
  KIND_LABEL,
  type OfferView,
  type OptionCandidate,
} from "../../lib/swampify_view.ts";
import { formatAbsoluteTime, formatShortDateTime } from "../../lib/format.ts";
import { ComparisonBlock } from "./SwampifyComparison.tsx";

const HARNESS_LABEL: Readonly<
  Record<SwampifyOffer["reading"]["harness"], string>
> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function stateText(state: SwampifyOffer["state"]): string {
  switch (state.kind) {
    case "offered":
      return "Offered: waiting for a pick";
    case "picked":
      return "Picked: not built yet";
    case "built":
      return "Built";
    case "declined":
      return "Declined: nothing was picked";
  }
}

function CandidateLine({ entry }: { entry: OptionCandidate }) {
  if (entry.state === "found") {
    return (
      <li>
        <span className="as-muted">#{entry.candidate.rank}</span>{" "}
        {entry.candidate.label}{" "}
        <span className="as-muted">({KIND_LABEL[entry.candidate.kind]})</span>
      </li>
    );
  }
  return (
    <li className="as-muted">
      {entry.state === "missing"
        ? "A candidate no longer in the current assessment"
        : "A candidate that cannot be shown: the assessment did not load"}
    </li>
  );
}

export interface OfferSectionProps {
  readonly view: OfferView;
  readonly owner: string;
  readonly comparisons: ReadonlyMap<string, SwampifyRow>;
  readonly openComparisons: ReadonlySet<string>;
  readonly onToggleComparison: (optionId: string) => void;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
}

/** The offer the user's agent made: its state, what read the sessions, and each option. */
export function OfferSection(
  {
    view,
    owner,
    comparisons,
    openComparisons,
    onToggleComparison,
    records,
    onLoadComparison,
  }: OfferSectionProps,
) {
  const { offer } = view;
  const state = offer.state;
  return (
    <section className="as-sw-offer" aria-label="Offer">
      <div className="as-sw-offer-head">
        <h3>Offer</h3>
        <span className={`as-sw-state as-sw-state-${state.kind}`}>
          {stateText(state)}
        </span>
        <span
          className="as-muted"
          title={formatAbsoluteTime(offer.updatedAt)}
        >
          updated {formatShortDateTime(offer.updatedAt)} by behavior{" "}
          <code>{owner}</code>
        </span>
      </div>
      <p className="as-muted as-sw-reading">
        {HARNESS_LABEL[offer.reading.harness]} read the example sessions with
        {" "}
        <code>{offer.reading.model}</code>: {offer.reading.candidates}{" "}
        candidates, {offer.reading.sessions} sessions.
      </p>
      {view.earlier && (
        <div className="as-notice as-sw-earlier" role="status">
          Built from an earlier assessment (generated{" "}
          {formatAbsoluteTime(offer.candidateSet.generatedAt)}). Its candidates
          are matched against the current one.
        </div>
      )}
      <ol className="as-sw-options">
        {view.options.map(({ option, candidates, picked }) => (
          <li
            key={option.id}
            className="as-sw-option"
            data-picked={picked ? "true" : undefined}
            data-wide={openComparisons.has(option.id) ? "true" : undefined}
          >
            <div className="as-sw-option-head">
              <h4>{option.name}</h4>
              {picked && <span className="as-sw-picked">Picked</span>}
            </div>
            <p>{option.why}</p>
            <p className="as-muted">
              Becomes a {option.becomes}
              {option.registryType && (
                <>
                  {" "}using <code>{option.registryType}</code>
                </>
              )}
              {picked && state.kind === "built" && (
                <>
                  ; built as {state.target.kind}{" "}
                  <code>{state.target.name}</code>
                </>
              )}
            </p>
            {option.outline && (
              <ol className="as-sw-outline">
                {option.outline.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            )}
            <div className="as-muted as-sw-sub">Stands for</div>
            <ul className="as-sw-option-candidates">
              {candidates.map((entry, i) => (
                <CandidateLine key={i} entry={entry} />
              ))}
            </ul>
            <ComparisonBlock
              row={comparisons.get(option.id)}
              open={openComparisons.has(option.id)}
              onToggle={() => onToggleComparison(option.id)}
              records={records}
              onLoad={onLoadComparison}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
