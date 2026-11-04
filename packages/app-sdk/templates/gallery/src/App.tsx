import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@swamp-club/ui";
import { RunOutcomes } from "./charts/RunOutcomes.tsx";
import { UsageRanking } from "./examples/UsageRanking.tsx";
import { DataTimeSeries } from "./examples/DataTimeSeries.tsx";
import { HealthTiles } from "./examples/HealthTiles.tsx";
import { WorkerTreemap } from "./examples/WorkerTreemap.tsx";
import { WorkflowDag } from "./examples/WorkflowDag.tsx";
import { RunWorkflow } from "./examples/RunWorkflow.tsx";

function Example(
  { title, source, children }: {
    title: string;
    source: string;
    children: ReactNode;
  },
) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{source}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function App() {
  return (
    <main className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      <Example title="Run outcomes" source="workflow.run.summary">
        <RunOutcomes />
      </Example>
      <Example title="Behavior usage" source="model.usage.summary">
        <UsageRanking />
      </Example>
      <Example title="Data over time" source="data.query">
        <DataTimeSeries />
      </Example>
      <Example title="Health" source="health subscription">
        <HealthTiles />
      </Example>
      <Example title="Workers" source="worker.list">
        <WorkerTreemap />
      </Example>
      <Example title="Workflow DAG" source="workflow.search, workflow.get">
        <WorkflowDag />
      </Example>
      <Example title="Start a run" source="workflow.run">
        <RunWorkflow />
      </Example>
    </main>
  );
}
