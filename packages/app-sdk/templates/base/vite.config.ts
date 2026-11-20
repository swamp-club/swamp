import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// swamp writes .swamp-platform on app init, dev and build
import { swampApp } from "./.swamp-platform/app-sdk/vite.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), swampApp()],
});
