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
import { useState } from "react";
import type { SwampifyRow } from "../../client/swampify.ts";
import type { ComparisonRecord } from "../../client/useSwampify.ts";
import { comparisonSummaryOf } from "../../client/swampify.ts";
import {
  formatBreakEven,
  formatShortDay,
  type OfferView,
  type OptionView,
} from "../../lib/swampify_view.ts";
import { ComparisonBody } from "./SwampifyComparison.tsx";
import { optionStatus } from "./SwampifyOptions.tsx";

/** Options built, or measured against swamp, from the offer. */
export function builtOptions(
  view: OfferView | null,
  comparisons: ReadonlyMap<string, SwampifyRow>,
): OptionView[] {
  if (!view) return [];
  return view.options.filter((o) =>
    optionStatus(o, view) === "Built" || comparisons.has(o.option.id)
  );
}

function BuiltRow(
  { option, view, comparison, records, onLoadComparison, initialOpen }: {
    option: OptionView;
    view: OfferView;
    comparison: SwampifyRow | undefined;
    records: ReadonlyMap<string, ComparisonRecord>;
    onLoadComparison: (row: SwampifyRow) => void;
    initialOpen: boolean;
  },
) {
  const [open, setOpen] = useState(initialOpen);
  const state = view.offer.state;
  const built = state.kind === "built" && option.picked ? state : null;
  const summary = comparison ? comparisonSummaryOf(comparison) : undefined;
  const target = built?.target ?? summary?.target;
  const id = `sw-built-${option.option.id}`;
  return (
    <li className={`sw-built-row${open ? " sw-row-open" : ""}`}>
      <button
        type="button"
        className="sw-built-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open && comparison) onLoadComparison(comparison);
          setOpen(!open);
        }}
      >
        <span className="sw-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="sw-built-name">{option.option.name}</span>
        <span className="sw-muted sw-small">
          {target && (
            <>
              {target.kind} <code>{target.name}</code>
            </>
          )}
          {built && ` · built ${formatShortDay(built.builtAt)}`}
        </span>
        <span className="sw-built-result sw-small">
          {summary
            ? (
              <>
                Run{" "}
                <span className={summary.outcome === "failed" ? "sw-fail" : ""}>
                  {summary.outcome}
                </span>{" "}
                · {formatBreakEven(summary.breakEven)}
              </>
            )
            : <span className="sw-muted">Not compared yet</span>}
        </span>
      </button>
      {open && (
        <div id={id} className="sw-built-body">
          {comparison
            ? (
              <ComparisonBody
                row={comparison}
                records={records}
                onLoad={onLoadComparison}
              />
            )
            : (
              <span className="sw-muted">
                No comparison yet: your agent writes one after the first runs.
              </span>
            )}
        </div>
      )}
    </li>
  );
}

/** What has been built from the offer; a row opens to its comparison. */
export function BuiltPane(
  { view, options, comparisons, records, onLoadComparison, initialOpen }: {
    view: OfferView | null;
    options: readonly OptionView[];
    comparisons: ReadonlyMap<string, SwampifyRow>;
    records: ReadonlyMap<string, ComparisonRecord>;
    onLoadComparison: (row: SwampifyRow) => void;
    /** Tests open a row from the start. */
    initialOpen?: string;
  },
) {
  if (!view || options.length === 0) {
    return (
      <div className="sw-card sw-note">
        <strong>Nothing built yet</strong>
        <span>
          When your agent builds one of the top candidates, it shows here with
          how its runs compare to doing the chore by hand.
        </span>
      </div>
    );
  }
  return (
    <section className="sw-card sw-built-card" aria-label="Built">
      <ul className="sw-built-list">
        {options.map((option) => (
          <BuiltRow
            key={option.option.id}
            option={option}
            view={view}
            comparison={comparisons.get(option.option.id)}
            records={records}
            onLoadComparison={onLoadComparison}
            initialOpen={initialOpen === option.option.id}
          />
        ))}
      </ul>
    </section>
  );
}
