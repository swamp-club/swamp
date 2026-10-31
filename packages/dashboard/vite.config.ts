// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/dashboard/",
  // lib/agent_sessions/record.ts imports the agent session record from core,
  // outside this package. Its bare zod import resolves to this package's
  // copy, and the dev server may read that one core directory.
  resolve: {
    alias: {
      zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
  },
  server: {
    fs: {
      allow: [
        ".",
        fileURLToPath(
          new URL("../../src/domain/agent_sessions", import.meta.url),
        ),
      ],
    },
    proxy: {
      "/api": "http://localhost:9090",
      "/auth": "http://localhost:9090",
    },
  },
});
