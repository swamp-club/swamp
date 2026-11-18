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

export const PREVIEW_CHIP_TITLE = "A preview: what it shows may change";

/** The word, not its colour, is what says it is a preview. */
export function PreviewChip({ className }: { className?: string }) {
  return (
    <span
      className={className ? `preview-chip ${className}` : "preview-chip"}
      title={PREVIEW_CHIP_TITLE}
    >
      Preview
    </span>
  );
}
