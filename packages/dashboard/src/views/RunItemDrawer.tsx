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

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { RouteLink } from "../components/RouteLink";
import { copyText } from "../components/clipboard.ts";
import { DataDetail } from "./DataDetail";
import { type DrawerItem, drawerTitle } from "./run_item_param.ts";
import { viewForDetail } from "../routes.ts";

interface RunItemDrawerProps {
  item: DrawerItem;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * A report or data item opened from a run, shown in a drawer over the run
 * page so the reader keeps their place. The item renders exactly as on its
 * own page; "Open full page" goes there, and "Copy link" shares the run
 * page with the drawer open. Escape and Back close it (the page owns
 * those keys).
 */
export function RunItemDrawer({ item, onClose }: RunItemDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const title = drawerTitle(item);
  const kind = item.kind === "data" ? "Data" : "Report";

  // Focus moves into the drawer and back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    titleRef.current?.focus({ preventScroll: true });
    const body = document.querySelector<HTMLElement>(".main") ?? document.body;
    const overflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = overflow;
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  // A new item in the same drawer starts at its top.
  useEffect(() => {
    panelRef.current?.querySelector(".rid-body")?.scrollTo?.({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  }, [item]);

  const copy = () => {
    copyText(location.href)
      .then((ok) => {
        if (!mounted.current) return;
        setCopied(ok ? "ok" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {
        if (mounted.current) setCopied("failed");
      });
  };

  // Keep Tab inside the drawer while it is open.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = [
      ...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((el) => el.offsetParent !== null || el === titleRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="rid-root">
      <div className="rid-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="rid-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rid-title"
        onKeyDown={onKeyDown}
      >
        <header className="rid-head">
          <div className="rid-title-wrap">
            <span className="rid-kind">{kind}</span>
            <h2
              id="rid-title"
              className="rid-title"
              tabIndex={-1}
              ref={titleRef}
            >
              {title}
            </h2>
          </div>
          <div className="rid-actions">
            <RouteLink
              to={{ view: viewForDetail(item), detail: item }}
              className="btn-sm rid-action"
              title="Open this on its own page"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="M7 1.5h3.5V5M10.5 1.5 6 6M5 2.5H2.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Open full page
            </RouteLink>
            <button
              type="button"
              className="btn-sm rid-action"
              onClick={copy}
              title="Copy a link to the run with this open"
            >
              {copied === "ok" ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              className="rid-close"
              aria-label="Close"
              title="Close (Esc)"
              onClick={onClose}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path
                  d="M3 3l8 8M11 3l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <span className="rid-status" role="status" aria-live="polite">
            {copied === "failed" ? "Copy failed — copy the address bar" : ""}
          </span>
        </header>
        <div className="rid-body">
          <DataDetail
            key={JSON.stringify(item)}
            detail={item}
            onBack={onClose}
            embedded
          />
        </div>
      </div>
    </div>
  );
}
