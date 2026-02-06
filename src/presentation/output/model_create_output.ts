import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface ModelCreateData {
  id: string;
  type: string;
  name: string;
  path: string;
}

export function renderModelCreate(
  data: ModelCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["model", "create"]);
    logger.info("Created model definition: {name} ({type})", {
      name: data.name,
      type: data.type,
    });
    logger.info("Path: {path}", { path: data.path });
  }
}
