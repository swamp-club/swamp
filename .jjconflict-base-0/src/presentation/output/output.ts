import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export type OutputMode = "log" | "json";

export interface VersionData {
  version: string;
}

export function renderVersion(data: VersionData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["version"]);
    logger.info("swamp {version}", { version: data.version });
  }
}
