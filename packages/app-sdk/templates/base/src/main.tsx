import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SwampAppProvider } from "@swamp-club/app-sdk/react";
import { Toaster, TooltipProvider } from "@swamp-club/ui";
import { App } from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SwampAppProvider
      fallback={<p className="p-6 text-muted-foreground">Connecting…</p>}
    >
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </SwampAppProvider>
  </StrictMode>,
);
