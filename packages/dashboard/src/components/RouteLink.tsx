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
import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import { navigateTo } from "../hooks/useRouter.ts";

interface RouteLinkProps {
  to: RouteState;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * A real link to a dashboard route. A plain left click navigates in-app;
 * middle and modified clicks, and "Copy link address", are left to the
 * browser so any item can be opened in a new tab or shared.
 */
export function RouteLink(
  { to, children, className, style, title }: RouteLinkProps,
) {
  return (
    <a
      href={buildPath(to)}
      className={className}
      style={style}
      title={title}
      onClick={(e) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        navigateTo(to);
      }}
    >
      {children}
    </a>
  );
}
