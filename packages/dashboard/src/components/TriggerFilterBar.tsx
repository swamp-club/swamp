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

import { type ReactNode, useEffect, useRef } from "react";
import { FilterSelect } from "./FilterBar.tsx";
import { formatCount } from "../lib/format.ts";

interface TriggerFilterBarProps {
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  /** Prefix choices; the select hides when empty. */
  prefixes?: ReadonlyArray<{ prefix: string; count: number }>;
  prefix?: string | null;
  onPrefix?: (prefix: string | null) => void;
  /** A segmented control (e.g. All / Active / Paused). */
  segments?: ReadonlyArray<{ value: string; label: string }>;
  segment?: string;
  onSegment?: (value: string) => void;
  shown: number;
  total: number;
  noun: string;
  active: boolean;
  onClear: () => void;
  children?: ReactNode;
}

/**
 * Search (with the "/" shortcut), an optional prefix select and segmented
 * state filter, styled like the workflow pages' filter bar.
 */
export function TriggerFilterBar(
  {
    query,
    onQuery,
    placeholder,
    prefixes = [],
    prefix = null,
    onPrefix,
    segments,
    segment,
    onSegment,
    shown,
    total,
    noun,
    active,
    onClear,
    children,
  }: TriggerFilterBarProps,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="filter-bar trig-filter" role="search">
      <div className="filter-search">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3.5 3.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
        />
        {!query && <kbd aria-hidden="true">/</kbd>}
      </div>

      {segments && onSegment && (
        <div className="time-range" role="group" aria-label="State">
          {segments.map((s) => (
            <button
              type="button"
              key={s.value}
              className={segment === s.value ? "active" : ""}
              aria-pressed={segment === s.value}
              onClick={() => onSegment(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {onPrefix && prefixes.length > 0 && (
        <FilterSelect
          label="Prefix"
          value={prefix ?? ""}
          onChange={(v) => onPrefix(v || null)}
          options={[
            { value: "", label: "All prefixes" },
            ...prefixes.map((p) => ({
              value: p.prefix,
              label: p.prefix,
              hint: formatCount(p.count),
            })),
          ]}
        />
      )}

      {children}

      <div className="filter-summary">
        {active && (
          <span aria-live="polite">
            {formatCount(shown)} of {formatCount(total)} {noun}
          </span>
        )}
        {active && (
          <button type="button" className="filter-clear" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
