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

import { useSyncExternalStore } from "react";
import {
  brandName,
  currentCustomTheme,
  currentThemePicker,
  type CustomTheme,
  subscribeCustomTheme,
  type ThemePicker,
} from "./custom_theme.ts";

export function useCustomTheme(): CustomTheme | null {
  return useSyncExternalStore(
    subscribeCustomTheme,
    currentCustomTheme,
    currentCustomTheme,
  );
}

export function useBrandName(): string {
  return useSyncExternalStore(subscribeCustomTheme, brandName, brandName);
}

export function useThemePicker(): ThemePicker {
  return useSyncExternalStore(
    subscribeCustomTheme,
    currentThemePicker,
    currentThemePicker,
  );
}
