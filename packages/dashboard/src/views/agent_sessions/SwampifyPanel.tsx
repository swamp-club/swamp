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
import {
  candidateSetSummaryOf,
  type SwampifyRow,
} from "../../client/swampify.ts";
import {
  type ComparisonRecord,
  type SwampifyState,
  useComparisonRecords,
  useSwampify,
} from "../../client/useSwampify.ts";
import { LoadError } from "../../components/LoadError.tsx";
import type {
  SwampifyCandidateSet,
  SwampifyCandidateSetSummary,
} from "../../lib/agent_sessions/swampify.ts";
import {
  consideredById,
  formatDay,
  offerView,
  optionByCandidate,
  setFullness,
} from "../../lib/swampify_view.ts";
import {
  formatAbsoluteTime,
  formatShortDateTime,
  pluralize,
} from "../../lib/format.ts";
import { CandidatesTable } from "./SwampifyCandidates.tsx";
import { OfferSection } from "./SwampifyOffer.tsx";
import { SkipNotice } from "./SwampifyParts.tsx";

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function SetHeader(
  { set, row }: { set: SwampifyCandidateSet; row: SwampifyRow },
) {
  const { scope, window } = set;
  return (
    <div className="as-sw-set-head">
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
        assessed {formatShortDateTime(set.generatedAt)} by behavior{" "}
        <code>{row.modelName}</code>
      </span>
    </div>
  );
}

export interface SwampifyViewProps {
  readonly state: SwampifyState;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  readonly loadedSessions: ReadonlySet<string>;
  readonly onOpenSession: (name: string) => void;
  /** Rows and comparisons open from the start; tests render them closed otherwise. */
  readonly initialOpen?: readonly string[];
  readonly initialOpenComparisons?: readonly string[];
}

/**
 * The Swampify panel as data: the shown candidate set, the offer made from
 * it, and comparisons by option. Renders nothing until a candidate set is
 * listed.
 */
export function SwampifyView(props: SwampifyViewProps) {
  const { state } = props;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(props.initialOpen),
  );
  const [openComparisons, setOpenComparisons] = useState<ReadonlySet<string>>(
    () => new Set(props.initialOpenComparisons),
  );
  const setRow = state.setRow.value;
  const setReading = state.set.value;
  const set = setReading?.kind === "record" ? setReading.record : null;
  const offerReading = state.offer.value;
  const offer = offerReading?.kind === "record" ? offerReading.record : null;
  const summary: SwampifyCandidateSetSummary | undefined = setRow
    ? candidateSetSummaryOf(setRow)
    : undefined;
  const view = useMemo(
    () => offer ? offerView(offer, set, setRow?.tags.generatedAt) : null,
    [offer, set, setRow],
  );
  const options = useMemo(() => optionByCandidate(offer), [offer]);
  const considered = useMemo(() => consideredById(offer), [offer]);
  const labels = useMemo(
    () => new Map(set?.candidates.map((c) => [c.id, c.label]) ?? []),
    [set],
  );

  if (state.setRow.error) {
    return (
      <section className="panel as-swampify" aria-label="Swampify">
        <LoadError
          subject="Swampify candidates"
          message={state.setRow.error}
          onRetry={state.setRow.refetch}
          inset
        />
      </section>
    );
  }
  if (setRow === undefined) return null;

  const comparisonProps = {
    comparisons: state.comparisons.value,
    openComparisons,
    onToggleComparison: (key: string) =>
      setOpenComparisons((current) => toggled(current, key)),
    records: props.records,
    onLoadComparison: props.onLoadComparison,
  };
  const fullness = set ? setFullness(set, summary) : null;

  return (
    <section className="panel as-swampify" aria-label="Swampify">
      <div className="as-sw-head">
        <h2>Swampify: chores worth automating</h2>
        <p className="as-muted">
          From the latest assessment of past sessions. It covers every repo the
          assessment read: the repo and session filters above apply to sessions
          only.
        </p>
        {set && <SetHeader set={set} row={setRow} />}
      </div>

      {state.set.loading && setReading === null && (
        <div className="as-notice">Loading the assessment…</div>
      )}
      {state.set.error && (
        <LoadError
          subject="the assessment"
          message={state.set.error}
          onRetry={state.set.refetch}
          inset
        />
      )}
      {setReading?.kind === "skipped" && (
        <SkipNotice item="candidate set" skipped={setReading} />
      )}

      {state.offerRow.error && (
        <LoadError
          subject="the offer"
          message={state.offerRow.error}
          onRetry={state.offerRow.refetch}
          inset
        />
      )}
      {state.offer.error && (
        <LoadError
          subject="the offer"
          message={state.offer.error}
          onRetry={state.offer.refetch}
          inset
        />
      )}
      {offerReading?.kind === "skipped" && (
        <SkipNotice item="offer" skipped={offerReading} />
      )}
      {state.comparisons.error && (
        <LoadError
          subject="comparisons"
          message={state.comparisons.error}
          onRetry={state.comparisons.refetch}
          inset
        />
      )}
      {state.comparisonsLimited && (
        <div className="as-notice">
          More comparisons exist than this page reads; some options may show
          none.
        </div>
      )}
      {view && state.offerRow.value && (
        <OfferSection
          view={view}
          owner={state.offerRow.value.modelName}
          {...comparisonProps}
        />
      )}

      {fullness === "empty" && (
        <div className="as-notice">
          Nothing repeated often enough in this window to offer.
        </div>
      )}
      {fullness === "thin" && (
        <div className="as-notice">
          A thin assessment: only{" "}
          {pluralize(set?.candidates.length ?? 0, "chore")}{" "}
          repeated often enough to list.
        </div>
      )}
      {set && set.candidates.length > 0 && (
        <CandidatesTable
          candidates={set.candidates}
          open={open}
          onToggle={(id) => setOpen((current) => toggled(current, id))}
          options={options}
          considered={considered}
          labels={labels}
          loadedSessions={props.loadedSessions}
          onOpenSession={props.onOpenSession}
          {...comparisonProps}
        />
      )}
    </section>
  );
}

/** The panel wired to serve: reads its items and comparison bodies itself. */
export function SwampifyPanel(
  { loadedSessions, onOpenSession }: {
    loadedSessions: ReadonlySet<string>;
    onOpenSession: (name: string) => void;
  },
) {
  const state = useSwampify();
  const { records, load } = useComparisonRecords();
  return (
    <SwampifyView
      state={state}
      records={records}
      onLoadComparison={(row) => void load(row)}
      loadedSessions={loadedSessions}
      onOpenSession={onOpenSession}
    />
  );
}
