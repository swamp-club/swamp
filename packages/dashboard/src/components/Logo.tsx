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
  currentCustomTheme,
  safeImage,
  subscribeCustomTheme,
} from "../theme/custom_theme.ts";

const customLogo = () => safeImage(currentCustomTheme()?.logo);

/** @jsxRuntime automatic */
/** @jsxImportSource react */
export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const logo = useSyncExternalStore(
    subscribeCustomTheme,
    customLogo,
    customLogo,
  );
  if (logo !== undefined) {
    return (
      <img
        src={logo}
        alt=""
        className={`custom-logo custom-logo--${size}`}
      />
    );
  }

  return (
    <span className={`brand-logo brand-logo--${size}`}>
      <span className="brand-logo-s">S</span>
      <span className="brand-logo-c">C</span>
    </span>
  );
}
