import { useHealth } from "@swamp-club/app-sdk/react";

interface Health {
  activeRuns?: unknown[];
  metrics?: { throughputPerMinute?: number; failures?: number };
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

/** Needs `health:read`. Every app shares the dashboard's one stream. */
export function HealthTiles() {
  const health = useHealth<Health>();
  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="Active runs" value={health?.activeRuns?.length ?? "–"} />
      <Tile
        label="Runs per minute"
        value={health?.metrics?.throughputPerMinute?.toFixed(1) ?? "–"}
      />
      <Tile label="Failures" value={health?.metrics?.failures ?? "–"} />
    </div>
  );
}
