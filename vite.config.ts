import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    // Let a standalone `npm run dev` use the next available port.
    // `npm run tauri dev` keeps Tauri in sync through scripts/tauri.mjs.
    strictPort: false,
    host: "127.0.0.1",
    watch: {
      // Cargo locks generated executables while compiling; they must not enter Vite's watcher.
      ignored: ["**/src-tauri/**"],
    },
  },
});
