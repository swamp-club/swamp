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

// the value is the item's own full-page path without the /dashboard/ prefix, so
// it reuses the route grammar instead of inventing a second one

import { buildPath, type DetailView, parseRoute } from "../routes.ts";

export const ITEM_PARAM = "item";

export type DrawerItem = Extract<
  NonNullable<DetailView>,
  { kind: "data" | "report" | "runReport" }
>;

const PREFIX = "/dashboard/";

export function itemParamFor(item: DrawerItem): string {
  const path = buildPath({ view: "models", detail: item });
  return path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
}

export function parseItemParam(raw: string | null): DrawerItem | null {
  if (!raw) return null;
  const { detail } = parseRoute(`${PREFIX}${raw.replace(/^\/+/, "")}`);
  if (
    detail?.kind === "data" || detail?.kind === "report" ||
    detail?.kind === "runReport"
  ) {
    return detail;
  }
  return null;
}

export function withItemParam(href: string, item: DrawerItem | null): string {
  const url = new URL(href);
  if (item) url.searchParams.set(ITEM_PARAM, itemParamFor(item));
  else url.searchParams.delete(ITEM_PARAM);
  return url.toString();
}

export function drawerTitle(item: DrawerItem): string {
  switch (item.kind) {
    case "data":
      return item.version !== undefined
        ? `${item.dataName} v${item.version}`
        : item.dataName;
    case "report":
      return item.variant
        ? `${item.reportName} · ${item.variant}`
        : item.reportName;
    case "runReport":
      return item.reportName;
  }
}
