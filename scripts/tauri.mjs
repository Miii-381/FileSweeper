import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const [command, ...argumentsForTauri] = process.argv.slice(2);
const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));

function runTauri(argumentsToPass) {
  const child = spawn(process.execPath, [tauriCli, ...argumentsToPass], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.once("exit", (code) => process.exit(code ?? 1));
}

if (command !== "dev") {
  runTauri(process.argv.slice(2));
} else {
  const viteServer = await createServer({
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: false,
    },
  });
  await viteServer.listen();
  viteServer.printUrls();

  const address = viteServer.httpServer?.address();
  if (!address || typeof address === "string") {
    await viteServer.close();
    throw new Error("Vite did not expose a TCP port.");
  }

  const devUrl = `http://127.0.0.1:${address.port}`;
  const configOverride = JSON.stringify({
    build: {
      beforeDevCommand: null,
      devUrl,
    },
  });
  const tauri = spawn(process.execPath, [tauriCli, "dev", "--config", configOverride, ...argumentsForTauri], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  let closing = false;
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    tauri.kill();
    await viteServer.close();
    process.exit(exitCode);
  };

  tauri.once("error", (error) => {
    console.error(error);
    void close(1);
  });
  tauri.once("exit", (code) => void close(code ?? 1));
  process.once("SIGINT", () => void close(130));
  process.once("SIGTERM", () => void close(143));
}
