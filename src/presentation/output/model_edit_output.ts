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
