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

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FacetDef,
  parseFacetInput,
  type Suggestion,
  suggestionsFor,
} from "../lib/search_facets.ts";
import { formatCount } from "../lib/format.ts";

/** A facet the bar can filter by, with its current value. */
export interface SearchFacet extends FacetDef {
  selected: string | null;
  onSelect: (value: string | null) => void;
}

interface SearchBarProps {
  /** Free-text search (fuzzy over names). */
  query: string;
  onQuery: (query: string) => void;
  facets: readonly SearchFacet[];
  placeholder?: string;
  /** "12 of 141 workflows" while anything narrows the list. */
  shown?: number;
  total?: number;
  noun?: string;
  /** Clears the query and every facet. */
  onClear: () => void;
  /** Controls after the field, e.g. the View menu. */
  trailing?: ReactNode;
}

// Deno type-checks component tests without the DOM library; the few DOM
// calls go through structural types (see dom_types.ts).
interface ElLike {
  focus(): void;
  contains(node: unknown): boolean;
  querySelector(
    selector: string,
  ): { scrollIntoView(options: { block: "nearest" }): void } | null;
}
interface DocLike {
  addEventListener(type: string, fn: (e: KeyEventLike) => void): void;
  removeEventListener(type: string, fn: (e: KeyEventLike) => void): void;
}
interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
  preventDefault(): void;
}
const el = (node: unknown): ElLike | null => node as ElLike | null;
const doc = (): DocLike | undefined =>
  (globalThis as { document?: DocLike }).document;

function isTyping(target: unknown): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(
    t &&
      (t.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "")),
  );
}

/**
 * One search box that guides filtering. Focus it to see what you can
 * filter by; pick a facet (or type `prefix:`) to see its values; or just
 * type to search names, with matching facet values suggested alongside.
 * Applied filters sit in the box as removable chips. "/" focuses it from
 * anywhere; Backspace in an empty box removes the last chip.
 */
export function SearchBar(
  {
    query,
    onQuery,
    facets,
    placeholder = "Search or filter…",
    shown,
    total,
    noun = "items",
    onClear,
    trailing,
  }: SearchBarProps,
) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // What's in the box. Plain text is the query; `key:` text is a facet
  // being picked and doesn't search names.
  const [draft, setDraft] = useState(query);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Follow outside changes to the query (Clear filters, Back/Forward).
  useEffect(() => {
    if (parseFacetInput(draft, facets) === null && draft !== query) {
      setDraft(query);
    }
    // Only when the query changes from outside, not on every keystroke.
  }, [query]);

  const applied = useMemo(
    () => new Set(facets.filter((f) => f.selected !== null).map((f) => f.key)),
    [facets],
  );
  const suggestions = useMemo(
    () => suggestionsFor(draft, facets, applied),
    [draft, facets, applied],
  );
  const parsed = parseFacetInput(draft, facets);

  useEffect(() => {
    const d = doc();
    if (!d) return;
    const onKey = (e: KeyEventLike) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      el(inputRef.current)?.focus();
    };
    d.addEventListener("keydown", onKey);
    return () => d.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const d = doc();
    if (!d) return;
    const onDown = (e: KeyEventLike) => {
      if (!el(rootRef.current)?.contains(e.target)) setOpen(false);
    };
    d.addEventListener("pointerdown", onDown);
    return () => d.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    el(listRef.current)
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const setText = (text: string) => {
    setDraft(text);
    setActive(0);
    setOpen(true);
    // `key:` text is picking a filter, not searching names: drop the name
    // search its first letters started.
    if (parseFacetInput(text, facets) === null) onQuery(text);
    else if (query) onQuery("");
  };

  const pick = (s: Suggestion | undefined) => {
    if (!s) return;
    if (s.kind === "facet") {
      setDraft(`${s.facet.key}:`);
      setActive(0);
      setOpen(true);
      // Whatever was typed was only finding the facet.
      if (query) onQuery("");
    } else if (s.kind === "value") {
      const facet = facets.find((f) => f.key === s.facet.key);
      facet?.onSelect(s.value.value);
      setDraft("");
      if (query) onQuery("");
      setActive(0);
      setOpen(true);
    } else {
      setOpen(false);
    }
    el(inputRef.current)?.focus();
  };

  const removeLast = () => {
    const last = [...facets].reverse().find((f) => f.selected !== null);
    last?.onSelect(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = suggestions.length;
      if (n === 0) return;
      setActive((a) =>
        e.key === "ArrowDown" ? Math.min(n - 1, a + 1) : Math.max(0, a - 1)
      );
    } else if (e.key === "Enter") {
      if (open && suggestions[active]) {
        e.preventDefault();
        pick(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      // Close the menu, then clear the text; never leave the page.
      if (open || draft) e.stopPropagation();
      if (open) setOpen(false);
      else if (draft) setText("");
    } else if (e.key === "Backspace" && draft === "") {
      removeLast();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const chips = facets.filter((f) => f.selected !== null);
  const anyActive = chips.length > 0 || query.trim() !== "";
  const activeId = open && suggestions[active]
    ? `${id}-s-${active}`
    : undefined;

  return (
    <div className="qbar" role="search" ref={rootRef}>
      <div
        className={`qbar-field${open ? " is-open" : ""}`}
        onMouseDown={(e) => {
          // Clicking the field's padding focuses the input.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            el(inputRef.current)?.focus();
          }
        }}
      >
        <svg
          className="qbar-icon"
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
        {chips.map((f) => {
          const v = f.values.find((x) => x.value === f.selected);
          return (
            <span className="qchip" key={f.key}>
              <span className="qchip-key">{f.label}</span>
              <span className="qchip-val">{v?.label ?? f.selected}</span>
              <button
                type="button"
                className="qchip-x"
                aria-label={`Remove ${f.label}: ${v?.label ?? f.selected}`}
                onClick={() => {
                  f.onSelect(null);
                  el(inputRef.current)?.focus();
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 2.5l5 5M7.5 2.5l-5 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          className="qbar-input"
          value={draft}
          placeholder={chips.length ? "Add a filter or search…" : placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(e) =>
            setText((e.target as unknown as { value: string }).value)}
          onKeyDown={onKeyDown}
        />
        {anyActive
          ? (
            <button
              type="button"
              className="qbar-clear"
              aria-label="Clear search and filters"
              onClick={() => {
                setDraft("");
                onClear();
                el(inputRef.current)?.focus();
              }}
            >
              Clear
            </button>
          )
          : <kbd aria-hidden="true">/</kbd>}
      </div>

      {open && (
        <div className="qbar-menu">
          <div className="qbar-menu-head">
            {parsed
              ? `${parsed.facet.label} · ${parsed.facet.description}`
              : draft.trim()
              ? "Suggestions"
              : "Filter by"}
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="qbar-list">
            {suggestions.map((s, i) => (
              <li
                key={suggestionKey(s)}
                id={`${id}-s-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={`qbar-opt${i === active ? " is-active" : ""}`}
                onPointerMove={() => i !== active && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                <SuggestionRow s={s} facets={facets} />
              </li>
            ))}
            {suggestions.length === 0 && (
              <li className="qbar-empty" role="presentation">
                {parsed
                  ? `No ${parsed.facet.label.toLowerCase()} matches`
                  : "Nothing to suggest"}
              </li>
            )}
          </ul>
          <div className="qbar-menu-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> choose
            </span>
            <span>
              <kbd>↵</kbd> apply
            </span>
            <span>
              <kbd>⌫</kbd> remove last filter
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
        </div>
      )}

      {trailing}

      {anyActive && shown !== undefined && total !== undefined && (
        <span className="qbar-count" aria-live="polite">
          {formatCount(shown)} of {formatCount(total)} {noun}
        </span>
      )}
    </div>
  );
}

function suggestionKey(s: Suggestion): string {
  return s.kind === "text"
    ? "text"
    : s.kind === "facet"
    ? `f:${s.facet.key}`
    : `v:${s.facet.key}:${s.value.value}`;
}

function SuggestionRow(
  { s, facets }: { s: Suggestion; facets: readonly SearchFacet[] },
) {
  if (s.kind === "text") {
    return (
      <>
        <span className="qbar-opt-key">Search</span>
        <span className="qbar-opt-main">names for “{s.text}”</span>
      </>
    );
  }
  if (s.kind === "facet") {
    return (
      <>
        <span className="qbar-opt-key">{s.facet.key}:</span>
        <span className="qbar-opt-main">{s.facet.description}</span>
        <span className="qbar-opt-hint">
          {formatCount(s.facet.values.length)}
        </span>
      </>
    );
  }
  const current = facets.find((f) => f.key === s.facet.key)?.selected;
  return (
    <>
      <span className="qbar-opt-key">{s.facet.key}:</span>
      <span
        className={`qbar-opt-main${
          current === s.value.value ? " is-current" : ""
        }`}
      >
        {s.value.label}
      </span>
      {s.value.hint && <span className="qbar-opt-hint">{s.value.hint}</span>}
    </>
  );
}
