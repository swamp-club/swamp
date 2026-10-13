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
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  filterOptions,
  isNavKey,
  moveActive,
  SEARCH_THRESHOLD,
  typeaheadMatch,
} from "../lib/select_logic.ts";

// Deno type-checks component tests without the DOM library, so the few
// DOM calls go through these structural types (see dom_types.ts).
interface ElLike {
  focus(options?: { preventScroll?: boolean }): void;
  getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    height: number;
    width: number;
  };
  contains(node: unknown): boolean;
  querySelector(
    selector: string,
  ): { scrollIntoView(options: { block: "nearest" }): void } | null;
  readonly parentElement: ElLike | null;
}

interface DocLike {
  addEventListener(
    type: "pointerdown",
    fn: (e: { target: unknown }) => void,
  ): void;
  removeEventListener(
    type: "pointerdown",
    fn: (e: { target: unknown }) => void,
  ): void;
}

const el = (node: unknown): ElLike | null => node as ElLike | null;

function viewport(): { width: number; height: number } {
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  return { width: g.innerWidth ?? 0, height: g.innerHeight ?? 0 };
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Muted right-aligned text, e.g. a count. */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  /** Accessible name when there is no visible label to point at. */
  ariaLabel?: string;
  /** Id of a visible label element. */
  labelledBy?: string;
  /** Search box in the menu: "auto" shows one for long lists. */
  searchable?: boolean | "auto";
  /** Placeholder for the trigger when the value matches no option. */
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * The dashboard's dropdown: a themed listbox in place of the browser's
 * native menu. Follows the ARIA select-only combobox pattern: arrow keys,
 * Home/End, PageUp/PageDown, type-to-select, Enter/Space to choose,
 * Escape to close (without leaving the page), and a search box for long
 * lists. The menu flips above the trigger when there's no room below.
 */
export function Select<T extends string>(
  {
    value,
    onChange,
    options,
    ariaLabel,
    labelledBy,
    searchable = "auto",
    placeholder = "Select…",
    className,
    disabled,
  }: SelectProps<T>,
) {
  const id = useId();
  const listId = `${id}-list`;
  const triggerId = `${id}-trigger`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeBuffer = useRef({ text: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<{ up: boolean; end: boolean }>(
    { up: false, end: false },
  );

  const withSearch = searchable === true ||
    (searchable === "auto" && options.length > SEARCH_THRESHOLD);
  const shown = useMemo(
    () => (withSearch && query ? filterOptions(options, query) : [...options]),
    [options, query, withSearch],
  );
  const selected = options.find((o) => o.value === value);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }, [disabled, options, value]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) el(triggerRef.current)?.focus();
  }, []);

  const choose = useCallback((index: number) => {
    const option = shown[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  }, [shown, value, onChange, close]);

  // Focus the search box or the list when the menu opens.
  useEffect(() => {
    if (!open) return;
    el(withSearch ? searchRef.current : listRef.current)?.focus({
      preventScroll: true,
    });
  }, [open, withSearch]);

  // Flip above / align right when the menu would leave the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = el(listRef.current)?.parentElement;
    const trigger = el(triggerRef.current);
    if (!menu || !trigger) return;
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const { width: vw, height: vh } = viewport();
    setPlacement({
      up: t.bottom + m.height + 8 > vh && t.top - m.height - 8 > 0,
      end: t.left + m.width > vw - 8,
    });
  }, [open]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    el(listRef.current)
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Close on a pointer press outside.
  useEffect(() => {
    if (!open) return;
    const doc = (globalThis as { document?: DocLike }).document;
    if (!doc) return;
    const onDown = (e: { target: unknown }) => {
      if (!el(rootRef.current)?.contains(e.target)) close(false);
    };
    doc.addEventListener("pointerdown", onDown);
    return () => doc.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const typeahead = (char: string) => {
    const now = Date.now();
    const buf = typeBuffer.current;
    buf.text = now - buf.at > 700 ? char : buf.text + char;
    buf.at = now;
    return typeaheadMatch(shown, buf.text, active);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openMenu();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing on a closed select picks the matching option, like native.
      const i = typeaheadMatch(
        options,
        e.key,
        options.findIndex((o) => o.value === value),
      );
      if (i >= 0 && options[i].value !== value) onChange(options[i].value);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLElement>) => {
    const key = e.key;
    if (isNavKey(key)) {
      e.preventDefault();
      setActive((cur) => moveActive(shown, cur, key));
      return;
    }
    if (e.key === "Enter" || (e.key === " " && !withSearch)) {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key === "Escape") {
      // Close the menu only; the page's Escape (leave detail) must not run.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (
      !withSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey &&
      !e.altKey
    ) {
      const i = typeahead(e.key);
      if (i >= 0) setActive(i);
    }
  };

  const activeId = active >= 0 && shown[active]
    ? `${id}-opt-${active}`
    : undefined;

  return (
    <div
      ref={rootRef}
      className={`sel${open ? " is-open" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="sel-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className={`sel-value${selected ? "" : " is-placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg
          className="sel-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className={`sel-menu${placement.up ? " is-up" : ""}${
            placement.end ? " is-end" : ""
          }`}
        >
          {withSearch && (
            <div className="sel-search">
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder="Filter…"
                aria-label="Filter options"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                onChange={(e) => {
                  setQuery((e.target as unknown as { value: string }).value);
                  // The best match is first; keep it active as the list narrows.
                  setActive(0);
                }}
                onKeyDown={onMenuKey}
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : ariaLabel}
            aria-activedescendant={withSearch ? undefined : activeId}
            onKeyDown={withSearch ? undefined : onMenuKey}
            className="sel-list"
          >
            {shown.map((o, i) => {
              const isSelected = o.value === value;
              return (
                <li
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled || undefined}
                  className={`sel-option${i === active ? " is-active" : ""}${
                    isSelected ? " is-selected" : ""
                  }`}
                  onPointerMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <svg
                    className="sel-check"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    {isSelected && (
                      <path
                        d="M2.5 6.2 5 8.5 9.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                  <span className="sel-label">{o.label}</span>
                  {o.hint && <span className="sel-hint">{o.hint}</span>}
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="sel-empty" role="presentation">No matches</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
