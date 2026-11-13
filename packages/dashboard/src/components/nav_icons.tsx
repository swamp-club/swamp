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

import type { CSSProperties } from "react";

export const NAV_ICONS: Record<string, string> = {
  overview:
    '<rect x="1" y="1" width="7" height="7" rx="1.5"/><rect x="10" y="1" width="7" height="7" rx="1.5"/><rect x="1" y="10" width="7" height="7" rx="1.5"/><rect x="10" y="10" width="7" height="7" rx="1.5"/>',
  workflows:
    '<circle cx="4" cy="4" r="2.5"/><circle cx="14" cy="9" r="2.5"/><circle cx="4" cy="14" r="2.5"/><path d="M6.5 4H10a1 1 0 011 1v3.5M6.5 14H10a1 1 0 001-1V9.5"/>',
  executions: '<path d="M3 3v12h12"/><path d="M6 12l3-4 3 2 3-5"/>',
  models:
    '<rect x="2" y="3" width="14" height="12" rx="2"/><path d="M6 7h6M6 10h4"/>',
  schedules: '<circle cx="9" cy="9" r="7"/><path d="M9 5v4l2.5 2.5"/>',
  webhooks:
    '<path d="M9 2v3M9 13v3M2 9h3M13 9h3M4.2 4.2l2.1 2.1M11.7 11.7l2.1 2.1M4.2 13.8l2.1-2.1M11.7 6.3l2.1-2.1"/>',
  approvals:
    '<path d="M9 2l7 4v6l-7 4-7-4V6z"/><path d="M2 6l7 4m0 0l7-4m-7 4v8"/>',
  data:
    '<rect x="2" y="2" width="14" height="14" rx="2"/><path d="M2 6h14M6 6v10"/>',
  vaults:
    '<rect x="4" y="2" width="10" height="14" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M9 2v5M9 11v5M4 9h3M11 9h3"/>',
  activity: '<path d="M2 9h4l2-5 3 10 2-5h3"/><circle cx="15" cy="9" r="1.5"/>',
  extensions: '<path d="M3 5h12M3 9h12M3 13h8"/>',
  workers:
    '<rect x="1.5" y="1.5" width="9" height="9" rx="1.5"/><rect x="12" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="12" y="7.5" width="4.5" height="3" rx="1"/><rect x="1.5" y="12" width="4.5" height="4.5" rx="1"/><rect x="7.5" y="12" width="9" height="4.5" rx="1"/>',
  swampify:
    '<path d="M9 1.5l1.6 4.4 4.4 1.6-4.4 1.6L9 13.5 7.4 9.1 3 7.5l4.4-1.6z"/><path d="M14.5 12l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  "agent-sessions":
    '<path d="M3 3h12a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0115 13H8l-3.5 3v-3H3a1.5 1.5 0 01-1.5-1.5v-7A1.5 1.5 0 013 3z"/><path d="M5.5 6.5L7.5 8l-2 1.5M9.5 10h3"/>',
  system:
    '<path d="M9 2a7 7 0 110 14A7 7 0 019 2z"/><path d="M12 9a3 3 0 01-6 0 3 3 0 016 0z"/><path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4"/>',
};

/** A sidebar icon by view name, for anywhere else that shows the same item. */
export function NavIcon(
  { name, size = 18, className, style }: {
    name: string;
    size?: number;
    className?: string;
    style?: CSSProperties;
  },
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: NAV_ICONS[name] ?? "" }}
    />
  );
}
