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
import type { SwampifyCandidate } from "../../lib/agent_sessions/swampify.ts";
import {
  formatRate,
  formatTokens,
  type OfferView,
  type OptionView,
} from "../../lib/swampify_view.ts";
import { formatCount, pluralize } from "../../lib/format.ts";

const READER: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The option's candidates the shown set holds, best ranked first. */
export function foundCandidates(option: OptionView): SwampifyCandidate[] {
  return option.candidates.flatMap((c) =>
    c.state === "found" ? [c.candidate] : []
  ).sort((a, b) => a.rank - b.rank);
}

export function optionStatus(
  option: OptionView,
  offer: OfferView,
): "Picked" | "Built" | null {
  if (!option.picked) return null;
  return offer.offer.state.kind === "built" ? "Built" : "Picked";
}

function OptionCard(
  { option, offer, compared, onOpen }: {
    option: OptionView;
    offer: OfferView;
    compared: boolean;
    onOpen: () => void;
  },
) {
  const lead = foundCandidates(option)[0];
  const status = optionStatus(option, offer);
  const count = option.option.candidateIds.length;
  return (
    <button type="button" className="sw-option" onClick={onOpen}>
      <span className="sw-option-head">
        <span className="sw-option-name">{option.option.name}</span>
        {status && <span className="sw-status">{status}</span>}
      </span>
      <span className="sw-option-why">{option.option.why}</span>
      {lead
        ? (
          <span
            className="sw-figures"
            title="Figures for its top-ranked candidate, as assess stored them"
          >
            <span>
              <strong>{formatCount(lead.occurrences)}</strong>
              <small>runs in {pluralize(lead.sessions, "session")}</small>
            </span>
            <span>
              <strong>
                {formatTokens(lead.perOccurrence.weightedTokens.median)}
              </strong>
              <small>tokens per run</small>
            </span>
            <span>
              <strong>{formatRate(lead.failureRate)}</strong>
              <small>of runs fail</small>
            </span>
          </span>
        )
        : (
          <span className="sw-muted">
            Its candidates are not in the shown assessment.
          </span>
        )}
      <span className="sw-muted">
        {`Becomes a ${option.option.becomes}${
          option.option.registryType
            ? ` using ${option.option.registryType}`
            : ""
        } · from ${pluralize(count, "candidate")}`}
      </span>
      <span className="sw-cta">
        {status === "Built" && compared
          ? "See the comparison →"
          : "Review and build →"}
      </span>
    </button>
  );
}

/** The offer as cards, one per option, ahead of the candidates. */
export function OptionCards(
  { view, comparisons, onOpen }: {
    view: OfferView;
    comparisons: ReadonlyMap<string, SwampifyRow>;
    onOpen: (optionId: string) => void;
  },
) {
  const { offer } = view;
  const reader = READER[offer.reading.harness] ?? offer.reading.harness;
  return (
    <section className="sw-offer" aria-labelledby="sw-offer-h">
      <div className="sw-section-head">
        <h2 id="sw-offer-h">Your agent suggests</h2>
        <span className="sw-muted">
          {reader} ({offer.reading.model}) read{" "}
          {pluralize(offer.reading.sessions, "example session")} for{" "}
          {pluralize(offer.reading.candidates, "candidate")} and offered{" "}
          {pluralize(offer.options.length, "option")}.
          {offer.state.kind === "offered" && " Pick one to build."}
        </span>
      </div>
      {view.earlier && (
        <div className="sw-card sw-note sw-warn">
          This offer was made from an earlier assessment; some of its candidates
          may have changed or gone.
        </div>
      )}
      {offer.state.kind === "declined" && (
        <div className="sw-card sw-note">
          You declined this offer. You can still build one of its options.
        </div>
      )}
      <div className="sw-options">
        {view.options.map((option) => (
          <OptionCard
            key={option.option.id}
            option={option}
            offer={view}
            compared={comparisons.has(option.option.id)}
            onOpen={() => onOpen(option.option.id)}
          />
        ))}
      </div>
    </section>
  );
}
