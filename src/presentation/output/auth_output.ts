// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export interface AuthSuccessData {
  action: "login" | "signup";
  email: string;
  name: string;
  userId: string;
}

export interface AuthLogoutData {
  email: string;
}

export interface AuthWhoamiData {
  loggedIn: boolean;
  email?: string;
  name?: string;
  userId?: string;
}

export interface AuthErrorData {
  error: string;
}

export function renderAuthSuccess(data: AuthSuccessData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "ok", ...data }, null, 2));
  } else {
    const logger = getSwampLogger(["auth"]);
    if (data.action === "signup") {
      logger.info("Account created. Logged in as {name} ({email})", {
        name: data.name,
        email: data.email,
      });
    } else {
      logger.info("Logged in as {name} ({email})", {
        name: data.name,
        email: data.email,
      });
    }
  }
}

export function renderAuthLogout(data: AuthLogoutData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "ok", action: "logout", ...data }, null, 2));
  } else {
    const logger = getSwampLogger(["auth"]);
    logger.info("Logged out ({email})", { email: data.email });
  }
}

export function renderAuthWhoami(data: AuthWhoamiData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["auth"]);
    if (data.loggedIn) {
      logger.info("Logged in as {name} ({email})", {
        name: data.name,
        email: data.email,
      });
    } else {
      logger.info("Not logged in");
    }
  }
}

export function renderAuthError(data: AuthErrorData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "error", ...data }, null, 2));
  } else {
    const logger = getSwampLogger(["auth"]);
    logger.error("{error}", { error: data.error });
  }
}
