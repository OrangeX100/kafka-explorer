import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production builds land in dist/ (embedded into the Go binary via go:embed).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5187, strictPort: true },
});
