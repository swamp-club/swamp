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

import { UserError } from "../domain/errors.ts";

/**
 * Returns the YAML piped to an edit command run with `--server`, or throws
 * when nothing was piped. An editor would open on the server host, not here,
 * so stdin is the only way to edit remotely.
 */
export function requireRemoteEditContent(
  content: string | null,
  command: string,
): string {
  if (content === null || content.trim() === "") {
    throw new UserError(
      `'${command}' with --server needs the new YAML piped on stdin, because the editor cannot run on the server. For example: cat edited.yaml | ${command} <name> --server <url>`,
    );
  }
  return content;
}
