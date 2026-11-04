import { useRequest, useSwamp } from "@swamp-club/app-sdk/react";
import { Badge } from "@swamp-club/ui";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@swamp-club/ui";
import { RunOutcomes } from "./charts/RunOutcomes.tsx";

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </CardHeader>
    </Card>
  );
}

export function App() {
  const { app, connected } = useSwamp();
  const { data } = useRequest("workflow.run.summary", {
    since: "14d",
  });
  const totals = data?.data.totals;
  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{app.title}</h1>
        <Badge>{connected ? "Connected" : "Reconnecting"}</Badge>
      </header>
      <section className="grid grid-cols-3 gap-3">
        <Tile label="Runs, 14 days" value={totals?.runs ?? "–"} />
        <Tile label="Succeeded" value={totals?.succeeded ?? "–"} />
        <Tile label="Failed" value={totals?.failed ?? "–"} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Run outcomes</CardTitle>
        </CardHeader>
        <CardContent>
          <RunOutcomes />
        </CardContent>
      </Card>
    </main>
  );
}
