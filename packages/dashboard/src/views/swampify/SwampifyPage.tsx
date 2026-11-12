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
import { useMemo, useState } from "react";
import { candidateSetSummaryOf } from "../../client/swampify.ts";
import type {
  ComparisonRecord,
  SwampifyState,
} from "../../client/useSwampify.ts";
import type { SwampifyRow } from "../../client/swampify.ts";
import { LoadError } from "../../components/LoadError.tsx";
import type { SwampifyCandidateSet } from "../../lib/agent_sessions/swampify.ts";
import {
  consideredById,
  formatDay,
  offerView,
  optionByCandidate,
  setFullness,
} from "../../lib/swampify_view.ts";
import { formatAbsoluteTime, pluralize } from "../../lib/format.ts";
import { CandidatesTable } from "./SwampifyCandidates.tsx";
import { OptionCards } from "./SwampifyOptions.tsx";
import { OptionReview } from "./SwampifyReview.tsx";
import { SkipNotice } from "./SwampifyParts.tsx";

function SetMeta({ set }: { set: SwampifyCandidateSet }) {
  const { scope, window } = set;
  return (
    <p className="sw-meta">
      <span
        title={`${formatAbsoluteTime(window.since)} to ${
          formatAbsoluteTime(window.until)
        }`}
      >
        Sessions from {formatDay(window.since)} to {formatDay(window.until)}
      </span>
      <span>{scope.harnesses.join(", ")}</span>
      <span title={scope.all ? undefined : scope.include.join("\n")}>
        {scope.all
          ? "every repo"
          : pluralize(scope.include.length, "included path")}
      </span>
      {scope.exclude.length > 0 && (
        <span title={scope.exclude.join("\n")}>
          {pluralize(scope.exclude.length, "excluded path")}
        </span>
      )}
      <span title={formatAbsoluteTime(set.generatedAt)}>
        assessed {formatDay(set.generatedAt)}
      </span>
    </p>
  );
}

export interface SwampifyPageProps {
  readonly state: SwampifyState;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  /** Tests render an option's review or open rows from the start. */
  readonly initialOptionId?: string;
  readonly initialOpen?: string;
}

/**
 * The latest assessment with the offer made from it, and each option's review
 * with the brief that hands it to the user's agent.
 */
export function SwampifyPage(props: SwampifyPageProps) {
  const { state } = props;
  const [optionId, setOptionId] = useState<string | null>(
    props.initialOptionId ?? null,
  );
  const [open, setOpen] = useState<string | null>(props.initialOpen ?? null);
  const setRow = state.setRow.value;
  const setReading = state.set.value;
  const set = setReading?.kind === "record" ? setReading.record : null;
  const offerReading = state.offer.value;
  const offer = offerReading?.kind === "record" ? offerReading.record : null;
  const view = useMemo(
    () => offer ? offerView(offer, set, setRow?.tags.generatedAt) : null,
    [offer, set, setRow],
  );
  const options = useMemo(() => optionByCandidate(offer), [offer]);
  const considered = useMemo(() => consideredById(offer), [offer]);

  const selected = view?.options.find((o) => o.option.id === optionId);
  if (selected && view && state.offerRow.value) {
    return (
      <OptionReview
        option={selected}
        offer={view}
        behavior={state.offerRow.value.modelName}
        comparison={state.comparisons.value.get(selected.option.id)}
        records={props.records}
        onLoadComparison={props.onLoadComparison}
        onBack={() => setOptionId(null)}
      />
    );
  }

  const summary = setRow ? candidateSetSummaryOf(setRow) : undefined;
  const fullness = set ? setFullness(set, summary) : null;
  const errors: ReadonlyArray<readonly [string, string | null, () => void]> = [
    ["Swampify candidates", state.setRow.error, state.setRow.refetch],
    ["the assessment", state.set.error, state.set.refetch],
    ["the offer", state.offerRow.error, state.offerRow.refetch],
    ["the offer", state.offer.error, state.offer.refetch],
    ["comparisons", state.comparisons.error, state.comparisons.refetch],
  ];

  return (
    <div className="sw-page">
      <div className="page-header sw-header">
        <div>
          <h1 className="sw-title">
            Swampify
            <span
              className="sw-preview-chip"
              title="A preview: what it shows may change"
            >
              Preview
            </span>
          </h1>
          <p className="sw-subtitle">
            Turn prompts and tool calls into Swamp powered automation
          </p>
        </div>
        {set && <SetMeta set={set} />}
      </div>

      {errors.map(([subject, error, retry], i) =>
        error && (
          <LoadError
            key={i}
            subject={subject}
            message={error}
            onRetry={retry}
          />
        )
      )}
      {setRow === undefined && !state.setRow.error && (
        <div className="sw-card sw-note">
          {state.setRow.loading
            ? "Loading the assessment…"
            : "No assessment yet. Ask your agent to swampify your past sessions, or choose Swampify in swamp start."}
        </div>
      )}
      {state.set.loading && setReading === null && setRow !== undefined && (
        <div className="sw-card sw-note">Loading the assessment…</div>
      )}
      {setReading?.kind === "skipped" && (
        <SkipNotice item="candidate set" skipped={setReading} />
      )}
      {offerReading?.kind === "skipped" && (
        <SkipNotice item="offer" skipped={offerReading} />
      )}
      {state.comparisonsLimited && (
        <div className="sw-card sw-note">
          More comparisons exist than this page reads; some options may show
          none.
        </div>
      )}

      {view && (
        <OptionCards
          view={view}
          comparisons={state.comparisons.value}
          onOpen={setOptionId}
        />
      )}
      {!view && set && set.candidates.length > 0 &&
        offerReading?.kind !== "skipped" && !state.offer.loading && (
        <div className="sw-card sw-note">
          <strong>Your agent hasn't made its offer yet</strong>
          <span>
            It reads a few example sessions for the top candidates, merges the
            ones that are the same chore, and offers three to five. The
            candidates it found are below.
          </span>
        </div>
      )}

      {fullness === "empty" && (
        <div className="sw-card sw-note">
          Nothing repeated often enough in this window to offer.
        </div>
      )}
      {fullness === "thin" && (
        <div className="sw-card sw-note">
          A thin assessment: only{" "}
          {pluralize(set?.candidates.length ?? 0, "chore")}{" "}
          repeated often enough to list.
        </div>
      )}
      {set && set.candidates.length > 0 && (
        <CandidatesTable
          candidates={set.candidates}
          open={open}
          onToggle={(id) => setOpen((current) => current === id ? null : id)}
          options={options}
          considered={considered}
          offered={view !== null}
          onReview={setOptionId}
        />
      )}
    </div>
  );
}
