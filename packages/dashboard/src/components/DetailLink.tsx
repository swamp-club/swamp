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

import type { CSSProperties, ReactNode } from "react";
import {
  buildPath,
  type DetailView,
  isPlainLeftClick,
  routeForDetail,
} from "../routes.ts";
import { navigateTo } from "../hooks/useRouter";

interface DetailLinkProps {
  to: NonNullable<DetailView>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * A real link to a dashboard detail view: the href is the shareable URL, a
 * plain click navigates in place, and modified or middle clicks are left to
 * the browser so the view opens in a new tab.
 */
export function DetailLink(
  { to, children, className, style, title }: DetailLinkProps,
) {
  const state = routeForDetail(to);
  return (
    <a
      href={buildPath(state)}
      className={className ? `detail-link ${className}` : "detail-link"}
      style={style}
      title={title}
      onClick={(e) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        navigateTo(state);
      }}
    >
      {children}
    </a>
  );
}
