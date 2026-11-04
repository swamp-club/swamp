import { useState } from "react";
import { useSwamp } from "@swamp-club/app-sdk/react";
import { Button } from "@swamp-club/ui";

/** Needs the workflow under `run:` in app.yaml; the local dashboard refuses runs, so the button is off there. */
export function RunWorkflow() {
  const { app, client } = useSwamp();
  const [events, setEvents] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const workflow = app.run[0];

  if (workflow === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        List a workflow under run: in app.yaml to start it from here.
      </p>
    );
  }
  if (app.local) {
    return (
      <p className="text-sm text-muted-foreground">
        Runs need swamp serve.
      </p>
    );
  }

  const start = async () => {
    setRunning(true);
    setEvents([]);
    try {
      for await (
        const event of client.workflowRunStream({ workflowIdOrName: workflow })
      ) {
        setEvents((seen) => [...seen, event.kind]);
      }
    } catch (error) {
      setEvents((seen) => [...seen, String(error)]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" disabled={running} onClick={() => void start()}>
        Run {workflow}
      </Button>
      <p className="text-xs text-muted-foreground" data-testid="run-events">
        {events.join(" → ")}
      </p>
    </div>
  );
}
