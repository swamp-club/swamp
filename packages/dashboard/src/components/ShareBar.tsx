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

import { useEffect, useRef, useState } from "react";
import { absoluteUrl, type RouteState } from "../routes.ts";
import { copyText } from "./clipboard.ts";

interface ShareBarProps {
  /** The page as shown; for a "latest" page this follows new versions. */
  link: RouteState;
  /** The same item pinned to the version on screen, when that differs. */
  permalink?: RouteState;
}

type Copied = "link" | "permalink" | "failed" | null;

/**
 * Copy buttons for sharing the page. "Copy permalink" pins the version
 * being read, so a link pasted into an incident thread keeps showing what
 * the author saw after newer versions are written.
 */
export function ShareBar({ link, permalink }: ShareBarProps) {
  const [copied, setCopied] = useState<Copied>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = async (which: "link" | "permalink", state: RouteState) => {
    const ok = await copyText(absoluteUrl(state, location.origin));
    // The page may have been left while the clipboard write was pending.
    if (!mounted.current) return;
    setCopied(ok ? which : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };

  const onCopy = (which: "link" | "permalink", state: RouteState) => {
    copy(which, state).catch(() => {
      if (mounted.current) setCopied("failed");
    });
  };

  return (
    <div className="share-bar">
      <button
        type="button"
        className="btn-sm"
        onClick={() => onCopy("link", link)}
      >
        {copied === "link" ? "Copied" : "Copy link"}
      </button>
      {permalink && (
        <button
          type="button"
          className="btn-sm"
          title="Link to this exact version"
          onClick={() => onCopy("permalink", permalink)}
        >
          {copied === "permalink" ? "Copied" : "Copy permalink"}
        </button>
      )}
      <span className="share-status" role="status" aria-live="polite">
        {copied === "failed" ? "Copy failed — copy the address bar" : ""}
      </span>
    </div>
  );
}
