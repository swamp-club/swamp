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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

/**
 * Data structure for model edit output.
 */
export interface ModelEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  type: string;
  editType: "input" | "resource" | "definition";
}

/**
 * Renders model edit output in either log or JSON mode.
 */
export function renderModelEdit(data: ModelEditData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["model", "edit"]);
    if (data.status === "opened") {
      logger.info(
        "Opening {editType} file in {editor}: {name} ({type}) at {path}",
        {
          editType: data.editType,
          editor: data.editor,
          name: data.name,
          type: data.type,
          path: data.path,
        },
      );
    } else {
      logger.info(
        "Updated {editType} from stdin: {name} ({type}) at {path}",
        {
          editType: data.editType,
          name: data.name,
          type: data.type,
          path: data.path,
        },
      );
    }
  }
}
