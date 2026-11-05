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

import { UserError } from "../errors.ts";

export const WORKSPACE_UNTRUSTED_CODE = "workspace_untrusted";

/** An untrusted workspace loads no extension code, so its types can't be read. */
export class WorkspaceUntrustedTypeError extends UserError {
  override readonly code = WORKSPACE_UNTRUSTED_CODE;

  constructor(type: string) {
    super(
      `This workspace is not trusted, so the extension type ${type} isn't loaded. Trust the workspace to read it.`,
    );
    this.name = "WorkspaceUntrustedTypeError";
  }
}
