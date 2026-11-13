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
  formatShortDay,
  harnessName,
  offerView,
  optionByCandidate,
  setFullness,
  type SwampifyLauncher,
} from "../../lib/swampify_view.ts";
import { formatAbsoluteTime, pluralize } from "../../lib/format.ts";
import { CandidatesTable } from "./SwampifyCandidates.tsx";
import { OptionCards } from "./SwampifyOptions.tsx";
import { OptionReview } from "./SwampifyReview.tsx";
import { SkipNotice } from "./SwampifyParts.tsx";
import { builtOptions, BuiltPane } from "./SwampifyBuilt.tsx";

const LIST = new Intl.ListFormat("en-US", { type: "conjunction" });

function Paths({ paths }: { paths: readonly string[] }) {
  return (
    <span className="sw-has-tip" title={paths.join("\n")}>
      {pluralize(paths.length, "path")}
    </span>
  );
}

/** Where the candidates came from, as one sentence. */
function Assessed({ set }: { set: SwampifyCandidateSet }) {
  const { scope, window } = set;
  return (
    <p className="sw-assessed">
      Assessed{" "}
      <time title={formatAbsoluteTime(set.generatedAt)}>
        {formatShortDay(set.generatedAt)}
      </time>{" "}
      from {LIST.format(scope.harnesses.map(harnessName))} sessions between{" "}
      <time title={formatAbsoluteTime(window.since)}>
        {formatShortDay(window.since)}
      </time>{" "}
      and{" "}
      <time title={formatAbsoluteTime(window.until)}>
        {formatShortDay(window.until)}
      </time>, in {scope.all ? "every repo" : <Paths paths={scope.include} />}
      {scope.exclude.length > 0 && (
        <>
          {" "}except <Paths paths={scope.exclude} />
        </>
      )}.
    </p>
  );
}

type Tab = "candidates" | "built";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["candidates", "Candidates"],
  ["built", "Built"],
];

export interface SwampifyPageProps {
  readonly state: SwampifyState;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  /** The option whose review the address shows, or none for the list. */
  readonly optionId: string | null;
  readonly onOpenOption: (optionId: string | null) => void;
  /** The local dashboard's launch; absent under serve, which only copies. */
  readonly launch?: SwampifyLauncher;
  /** Tests open a row from the start. */
  readonly initialOpen?: string;
  readonly initialTab?: Tab;
}

/**
 * The latest assessment with the offer made from it, and each option's review
 * with the brief that hands it to the user's agent.
 */
export function SwampifyPage(props: SwampifyPageProps) {
  const { state } = props;
  const { optionId, onOpenOption } = props;
  const [open, setOpen] = useState<string | null>(props.initialOpen ?? null);
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "candidates");
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
  const comparisons = state.comparisons.value;
  const built = useMemo(() => builtOptions(view, comparisons), [
    view,
    comparisons,
  ]);

  const selected = view?.options.find((o) => o.option.id === optionId);
  if (selected && view && state.offerRow.value) {
    return (
      <OptionReview
        option={selected}
        offer={view}
        behavior={state.offerRow.value.modelName}
        comparison={comparisons.get(selected.option.id)}
        records={props.records}
        onLoadComparison={props.onLoadComparison}
        onBack={() => onOpenOption(null)}
        launch={props.launch}
      />
    );
  }

  const toBuild = view ? view.options.filter((o) => !built.includes(o)) : [];
  // Once there is an offer, only the candidates it can build are listed.
  const listed = set
    ? view ? set.candidates.filter((c) => options.has(c.id)) : set.candidates
    : [];
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
      <div className="sw-tablist" role="tablist" aria-label="Swampify view">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`sw-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`sw-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            className={`sw-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const next = key === "candidates" ? "built" : "candidates";
              setTab(next);
              document.getElementById(`sw-tab-${next}`)?.focus();
            }}
          >
            {label}
            {key === "candidates" && toBuild.length > 0 && (
              <span className="sw-tab-count sw-tab-count-todo">
                {toBuild.length}
                <span className="sw-sr-only">to build</span>
              </span>
            )}
            {key === "built" && built.length > 0 && (
              <span className="sw-tab-count">
                {built.length}
                <span className="sw-sr-only">built</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "candidates"
        ? (
          <div
            id="sw-panel-candidates"
            role="tabpanel"
            aria-labelledby="sw-tab-candidates"
            className="sw-panel"
          >
            {setRow === undefined && !state.setRow.error && (
              <div className="sw-card sw-note">
                {state.setRow.loading
                  ? "Loading the assessment…"
                  : "No assessment yet. Ask your agent to swampify your past sessions."}
              </div>
            )}
            {state.set.loading && setReading === null && setRow !== undefined &&
              <div className="sw-card sw-note">Loading the assessment…</div>}
            {setReading?.kind === "skipped" && (
              <SkipNotice item="candidate set" skipped={setReading} />
            )}
            {offerReading?.kind === "skipped" && (
              <SkipNotice item="offer" skipped={offerReading} />
            )}

            {view && (
              <OptionCards
                view={view}
                options={toBuild}
                onOpen={onOpenOption}
              />
            )}
            {!view && set && set.candidates.length > 0 &&
              offerReading?.kind !== "skipped" && !state.offer.loading && (
              <div className="sw-card sw-note">
                <strong>Your agent hasn't made its offer yet</strong>
                <span>
                  It reads a few example sessions for the top candidates, merges
                  the ones that are the same chore, and offers three to five.
                  The candidates it found are below.
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
            {set && listed.length > 0 && (
              <CandidatesTable
                candidates={listed}
                open={open}
                onToggle={(id) =>
                  setOpen((current) => current === id ? null : id)}
                options={options}
                onReview={onOpenOption}
                about={<Assessed set={set} />}
              />
            )}
          </div>
        )
        : (
          <div
            id="sw-panel-built"
            role="tabpanel"
            aria-labelledby="sw-tab-built"
            className="sw-panel"
          >
            {state.comparisonsLimited && (
              <div className="sw-card sw-note">
                More comparisons exist than this page reads; some options may
                show none.
              </div>
            )}
            <BuiltPane
              view={view}
              options={built}
              comparisons={comparisons}
              records={props.records}
              onLoadComparison={props.onLoadComparison}
            />
          </div>
        )}
    </div>
  );
}
