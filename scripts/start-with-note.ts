#!/usr/bin/env bun
/**
 * Start Excalidraw dev server with a pre-loaded scene file.
 *
 * Usage:
 *   bun run start:note <file>
 *
 * Supported formats:
 *   .note                  — Notability archive (converted on the fly)
 *   .excalidraw.md / .md  — Obsidian Excalidraw markdown (compressed or raw JSON)
 *   .excalidraw            — Raw Excalidraw JSON
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { loadSceneFromFile, addFractionalIndices } from "./lib/load-scene";

const PORT = 3456;
const PRELOAD_FILENAME = "_preload.excalidraw";

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const inputPath = process.argv[2];

if (!inputPath) {
  console.error(
    "Usage: bun run start:note <file.note | file.excalidraw.md | file.excalidraw>",
  );
  process.exit(1);
}

const absPath = resolve(inputPath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load and prepare scene
// ---------------------------------------------------------------------------

console.log(`Loading: ${absPath}`);
const scene = await loadSceneFromFile(absPath);
addFractionalIndices(scene);

console.log(
  `Scene: ${scene.elements?.length ?? 0} elements, ${Object.keys(scene.files ?? {}).length} files`,
);

// ---------------------------------------------------------------------------
// Write preload file to public directory
// ---------------------------------------------------------------------------

const publicDir = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../public",
);
const preloadPath = resolve(publicDir, PRELOAD_FILENAME);

if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

writeFileSync(preloadPath, JSON.stringify(scene));
console.log(`Wrote preload: ${preloadPath}`);

// ---------------------------------------------------------------------------
// Start vite dev server
// ---------------------------------------------------------------------------

const url = `http://localhost:${PORT}#url=/${PRELOAD_FILENAME}`;
console.log(`\nStarting dev server...\nOpen: ${url}\n`);

const viteProcess = spawn(
  "bun",
  ["--bun", "vite", "--host", "--port", String(PORT)],
  {
    cwd: resolve(
      dirname(new URL(import.meta.url).pathname),
      "../excalidraw-app",
    ),
    stdio: "inherit",
    env: { ...process.env },
  },
);

viteProcess.on("exit", (code) => {
  process.exit(code ?? 0);
});

// Forward signals
process.on("SIGINT", () => viteProcess.kill("SIGINT"));
process.on("SIGTERM", () => viteProcess.kill("SIGTERM"));
