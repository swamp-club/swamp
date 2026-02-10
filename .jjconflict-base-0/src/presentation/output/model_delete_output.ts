import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

/**
 * Data structure for the model delete output.
 */
export interface ModelDeleteData {
  id: string;
  name: string;
  type: string;
  inputPath: string;
  resourcePath?: string;
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
}

/**
 * JSON output structure for model delete.
 */
export interface ModelDeleteJsonOutput {
  deleted: {
    id: string;
    name: string;
    type: string;
    inputPath: string;
    resourcePath?: string;
  };
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
}

/**
 * Renders the model delete output in either log or JSON mode.
 */
export function renderModelDelete(
  data: ModelDeleteData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const output: ModelDeleteJsonOutput = {
      deleted: {
        id: data.id,
        name: data.name,
        type: data.type,
        inputPath: data.inputPath,
      },
      resourceDeleted: data.resourceDeleted,
      outputsDeleted: data.outputsDeleted,
      evaluatedInputDeleted: data.evaluatedInputDeleted,
      dataDeleted: data.dataDeleted,
    };
    if (data.resourcePath) {
      output.deleted.resourcePath = data.resourcePath;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    const logger = getSwampLogger(["model", "delete"]);
    logger.info("Deleted model: {name} ({type})", {
      name: data.name,
      type: data.type,
    });
  }
}

/**
 * Renders a cancellation message.
 */
export function renderModelDeleteCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["model", "delete"]);
    logger.warn("Deletion cancelled.");
  }
}
