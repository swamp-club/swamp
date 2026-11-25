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

/** The server refuses these too; the page writes the stylesheet, so it checks again. */
export function safeThemeCss(css: string): boolean {
  // an escape can spell url( or @import past every check below
  if (css.includes("\\")) return false;
  if (/@(import|namespace)/i.test(css)) return false;
  if (
    /(?<![\w-])(-webkit-image-set|image-set|image|cross-fade|src|element)\s*\(/i
      .test(css)
  ) {
    return false;
  }
  if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(css)) {
    return false;
  }
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")\s]*)/gi)) {
    if (!/^data:/i.test(m[2])) return false;
  }
  return true;
}
