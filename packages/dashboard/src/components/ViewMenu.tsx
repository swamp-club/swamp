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

import { useEffect, useId, useRef, useState } from "react";

export interface ViewChoice {
  kind: "choice";
  label: string;
  value: string;
  /** The value that counts as "not customised" (no dot on the button). */
  defaultValue: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

export interface ViewToggle {
  kind: "toggle";
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export type ViewSection = ViewChoice | ViewToggle;

interface ElLike {
  focus(): void;
  contains(node: unknown): boolean;
}
interface DocLike {
  addEventListener(type: string, fn: (e: { target: unknown }) => void): void;
  removeEventListener(
    type: string,
    fn: (e: { target: unknown }) => void,
  ): void;
}
const el = (node: unknown): ElLike | null => node as ElLike | null;

/**
 * One "View" button holding how a list is shown (sort, grouping, extra
 * rows) so the page header carries a single search box instead of a row
 * of selects. A dot marks a customised view.
 */
export function ViewMenu({ sections }: { sections: readonly ViewSection[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const d = (globalThis as { document?: DocLike }).document;
    if (!d) return;
    const onDown = (e: { target: unknown }) => {
      if (!el(rootRef.current)?.contains(e.target)) setOpen(false);
    };
    d.addEventListener("pointerdown", onDown);
    return () => d.removeEventListener("pointerdown", onDown);
  }, [open]);

  const customised = sections.some((s) =>
    s.kind === "choice" ? s.value !== s.defaultValue : s.checked
  );
  const summary = sections
    .filter((s): s is ViewChoice => s.kind === "choice")
    .filter((s) => s.value !== s.defaultValue)
    .map((s) => s.options.find((o) => o.value === s.value)?.label)
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`view-menu${open ? " is-open" : ""}`}
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          el(buttonRef.current)?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="view-menu-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 4h7M12 4h2M2 12h2M7 12h7M9 2.5v3M5 10.5v3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <span>View</span>
        {summary && <span className="view-menu-summary">{summary}</span>}
        {customised && (
          <span className="view-menu-dot" aria-label="customised" />
        )}
      </button>
      {open && (
        <div
          id={`${id}-panel`}
          className="view-menu-panel"
          role="dialog"
          aria-label="View options"
        >
          {sections.map((s) =>
            s.kind === "choice"
              ? (
                <fieldset key={s.label} className="view-menu-section">
                  <legend>{s.label}</legend>
                  {s.options.map((o) => (
                    <label key={o.value} className="view-menu-option">
                      <input
                        type="radio"
                        name={`${id}-${s.label}`}
                        checked={s.value === o.value}
                        onChange={() =>
                          s.onChange(o.value)}
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </fieldset>
              )
              : (
                <label
                  key={s.label}
                  className="view-menu-option view-menu-toggle"
                >
                  <input
                    type="checkbox"
                    checked={s.checked}
                    onChange={(e) =>
                      s.onChange(
                        (e.target as unknown as { checked: boolean }).checked,
                      )}
                  />
                  <span>{s.label}</span>
                </label>
              )
          )}
        </div>
      )}
    </div>
  );
}
