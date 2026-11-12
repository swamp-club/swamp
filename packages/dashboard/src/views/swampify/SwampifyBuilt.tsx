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
import {
  formatShortDay,
  type OfferView,
  type OptionView,
} from "../../lib/swampify_view.ts";
import { ComparisonBlock } from "./SwampifyComparison.tsx";
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

function BuiltCard(
  { option, view, comparison, records, onLoadComparison, onOpen }: {
    option: OptionView;
    view: OfferView;
    comparison: SwampifyRow | undefined;
    records: ReadonlyMap<string, ComparisonRecord>;
    onLoadComparison: (row: SwampifyRow) => void;
    onOpen: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const state = view.offer.state;
  const built = state.kind === "built" && option.picked ? state : null;
  return (
    <section
      className="sw-card sw-pad sw-built"
      aria-labelledby={`sw-built-${option.option.id}`}
    >
      <div className="sw-section-head">
        <h2 id={`sw-built-${option.option.id}`}>{option.option.name}</h2>
        <button type="button" className="sw-link sw-small" onClick={onOpen}>
          Open its review
        </button>
      </div>
      {built && (
        <p className="sw-muted sw-small">
          Built as the {built.target.kind} <code>{built.target.name}</code> on
          {" "}
          {formatShortDay(built.builtAt)}
        </p>
      )}
      <ComparisonBlock
        row={comparison}
        open={open}
        onToggle={() => setOpen(!open)}
        records={records}
        onLoad={onLoadComparison}
      />
    </section>
  );
}

/** What has been built from the offer, and how it measures against before. */
export function BuiltPane(
  { view, options, comparisons, records, onLoadComparison, onOpen }: {
    view: OfferView | null;
    options: readonly OptionView[];
    comparisons: ReadonlyMap<string, SwampifyRow>;
    records: ReadonlyMap<string, ComparisonRecord>;
    onLoadComparison: (row: SwampifyRow) => void;
    onOpen: (optionId: string) => void;
  },
) {
  if (!view || options.length === 0) {
    return (
      <div className="sw-card sw-note">
        <strong>Nothing built yet</strong>
        <span>
          When your agent builds one of its suggestions, it shows here with how
          its runs compare to doing the chore by hand.
        </span>
      </div>
    );
  }
  return (
    <div className="sw-built-list">
      {options.map((option) => (
        <BuiltCard
          key={option.option.id}
          option={option}
          view={view}
          comparison={comparisons.get(option.option.id)}
          records={records}
          onLoadComparison={onLoadComparison}
          onOpen={() => onOpen(option.option.id)}
        />
      ))}
    </div>
  );
}
