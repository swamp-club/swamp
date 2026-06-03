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

import { UserError } from "../../domain/errors.ts";

/**
 * Open a URL in the user's default browser.
 * Falls back to a helpful error message if the browser cannot be opened.
 */
export async function openBrowser(url: string): Promise<void> {
  const os = Deno.build.os;

  let cmd: string[];
  if (os === "darwin") {
    cmd = ["open", url];
  } else if (os === "windows") {
    cmd = ["cmd", "/c", "start", url];
  } else {
    // Linux and other Unix-like systems
    cmd = ["xdg-open", url];
  }

  try {
    const command = new Deno.Command(cmd[0], { args: cmd.slice(1) });
    const { success } = await command.output();
    if (!success) {
      throw new Error("non-zero exit code");
    }
  } catch {
    throw new UserError(
      `Could not open a browser. Please open this URL manually:\n  ${url}`,
    );
  }
}
