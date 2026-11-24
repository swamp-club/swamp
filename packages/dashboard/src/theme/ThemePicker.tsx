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

import { Select } from "../components/Select.tsx";
import { chooseTheme } from "./custom_theme.ts";
import { useThemePicker } from "./useCustomTheme.ts";

/** Switches between the repo's themes and swamp's own look; hidden when there is nothing to pick. */
export function ThemePicker(
  { placement = "sidebar" }: { placement?: "sidebar" | "header" } = {},
) {
  const { options, value } = useThemePicker();
  if (options.length === 0) return null;
  return (
    <div className={`theme-picker theme-picker--${placement}`}>
      <Select
        value={value}
        onChange={chooseTheme}
        options={options}
        ariaLabel="Dashboard theme"
        className="theme-picker-select"
      />
    </div>
  );
}
