import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readConfigFile } from "./config-file.js";

// Spawn scripts listed in config.startupScripts if not already running.
// Failures are intentionally silent so the server always starts normally.
try {
  const config = readConfigFile();
  for (const { script, pidFile } of config?.startupScripts ?? []) {
    if (!existsSync(script)) continue;
    if (pidFile && existsSync(pidFile)) {
      const pid = readFileSync(pidFile, "utf-8").trim();
      if (pid && existsSync(`/proc/${pid}`)) continue;
    }
    const child = spawn("bash", [script], { detached: true, stdio: "ignore" });
    child.unref();
  }
} catch {
  // never block server startup
}
