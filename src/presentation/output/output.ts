export type OutputMode = "log" | "json";

export interface VersionData {
  version: string;
}

export function renderVersion(data: VersionData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`swamp ${data.version}`);
  }
}
