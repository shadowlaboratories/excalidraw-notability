#!/usr/bin/env bun
/**
 * Render an Excalidraw scene to per-page PNGs matching Notability's resolution.
 *
 * Usage:
 *   bun run render <input-file> [output-dir]
 *
 * Output: <output-dir>/Page1.png, Page2.png, …
 * Default output-dir: same directory as the input file.
 *
 * Supported input formats:
 *   .note                  — Notability archive (converted on the fly)
 *   .excalidraw.md / .md  — Obsidian Excalidraw markdown (compressed or raw JSON)
 *   .excalidraw            — Raw Excalidraw JSON
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import puppeteer from "puppeteer";
import { loadSceneFromFile, addFractionalIndices } from "./lib/load-scene";

const RENDER_PORT = 3457; // Dedicated port so we don't conflict with dev server
const PRELOAD_FILENAME = "_preload.excalidraw";
const BASE_URL = `http://localhost:${RENDER_PORT}`;
const PAGE_PIXEL_WIDTH = 1995;
const PAGE_PIXEL_HEIGHT = 2500;
const SCENE_LOAD_TIMEOUT_MS = 120_000;

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  a3: { width: 297, height: 420 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
};

function getNotabilityPageConfig(scene: any) {
  const metadata = scene?.notability;
  const pageWidthDoc =
    typeof metadata?.pageWidth === "number" ? metadata.pageWidth : 574;
  const paperSize =
    typeof metadata?.paperSize === "string"
      ? metadata.paperSize.toLowerCase()
      : null;
  const paperOrientation =
    typeof metadata?.paperOrientation === "string"
      ? metadata.paperOrientation.toLowerCase()
      : "portrait";
  const paper = paperSize ? PAPER_SIZES[paperSize] : null;

  if (!paper) {
    return {
      pageWidthDoc,
      pagePixelWidth: PAGE_PIXEL_WIDTH,
      pagePixelHeight: PAGE_PIXEL_HEIGHT,
    };
  }

  const aspectRatio =
    paperOrientation === "landscape"
      ? paper.width / paper.height
      : paper.height / paper.width;

  return {
    pageWidthDoc,
    pageHeightDoc: pageWidthDoc * aspectRatio,
    pagePixelWidth: PAGE_PIXEL_WIDTH,
    pagePixelHeight: PAGE_PIXEL_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const inputPath = process.argv[2];
let outputDir = process.argv[3];

if (!inputPath) {
  console.error(
    "Usage: bun run render <file.note | file.excalidraw.md | file.excalidraw> [output-dir]",
  );
  process.exit(1);
}

const absInputPath = resolve(inputPath);
if (!existsSync(absInputPath)) {
  console.error(`File not found: ${absInputPath}`);
  process.exit(1);
}

if (!outputDir) {
  outputDir = dirname(absInputPath);
}
const absOutputDir = resolve(outputDir);

// ---------------------------------------------------------------------------
// Load and prepare scene
// ---------------------------------------------------------------------------

console.log(`Loading: ${absInputPath}`);
const scene = await loadSceneFromFile(absInputPath);
addFractionalIndices(scene);
const pageConfig = getNotabilityPageConfig(scene);

const elementCount = scene.elements?.length ?? 0;
const fileCount = Object.keys(scene.files ?? {}).length;
const imageElementCount = scene.elements?.filter(
  (element: any) => element.type === "image",
).length ?? 0;
console.log(`Scene: ${elementCount} elements, ${fileCount} files`);
if ("pageHeightDoc" in pageConfig) {
  console.log(
    `Pages: ${pageConfig.pageWidthDoc.toFixed(2)} x ${pageConfig.pageHeightDoc.toFixed(2)} doc units`,
  );
}

// ---------------------------------------------------------------------------
// Write preload file to public directory
// ---------------------------------------------------------------------------

const scriptDir = dirname(new URL(import.meta.url).pathname);
const publicDir = resolve(scriptDir, "../public");
const preloadPath = resolve(publicDir, PRELOAD_FILENAME);

if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

writeFileSync(preloadPath, JSON.stringify(scene));

// ---------------------------------------------------------------------------
// Start dev server (always fresh, always killed at end)
// ---------------------------------------------------------------------------

let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  console.log(`Starting render server on :${RENDER_PORT}...`);
  server = spawn(
    "bun",
    ["--bun", "vite", "--host", "--port", String(RENDER_PORT)],
    {
      cwd: resolve(scriptDir, "../excalidraw-app"),
      stdio: "pipe",
      env: { ...process.env },
      detached: true, // Create process group so we can kill all children
    },
  );

  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(BASE_URL);
      if (resp.ok) {
        console.log("Server ready");
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server failed to start within ${maxWait / 1000}s`);
}

function stopServer(): void {
  if (server && server.pid) {
    // Kill the entire process group (negative PID) to ensure child processes are cleaned up
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
    server = null;
  }
}

// ---------------------------------------------------------------------------
// Render to per-page PNGs via headless Chrome
// ---------------------------------------------------------------------------

async function render(): Promise<void> {
  await startServer();

  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Clear localStorage to avoid "replace content" dialog
    await page.goto(BASE_URL, { waitUntil: "networkidle2" });
    await page.evaluate(() => localStorage.clear());

    // Navigate with the preload hash
    const sceneUrl = `${BASE_URL}#url=/${PRELOAD_FILENAME}`;
    console.log(`Loading scene: ${sceneUrl}`);
    await page.goto(sceneUrl, { waitUntil: "networkidle2" });

    // Wait for the scene to load
    console.log("Waiting for scene to render...");
    await page.waitForFunction(
      (
        expectedCount: number,
        expectedImageCount: number,
      ) => {
        const api = (window as any).excalidrawAPI;
        if (!api) return false;
        const elements = api.getSceneElements();
        if (!elements || elements.length < expectedCount) {
          return false;
        }

        const imageElements = elements.filter((element: any) => element.type === "image");
        return imageElements.length >= expectedImageCount;
      },
      { timeout: SCENE_LOAD_TIMEOUT_MS },
      elementCount,
      imageElementCount,
    );

    // Small delay for canvas to finish painting
    await new Promise((r) => setTimeout(r, 1000));

    // Export per-page PNGs at Notability resolution
    console.log("Exporting pages...");
    const pages = await page.evaluate(async (config) => {
      const exportFn = (window as any).exportToPages;
      if (!exportFn) {
        throw new Error("window.exportToPages not available");
      }
      return (await exportFn(config)) as number[][];
    }, pageConfig);

    // Write page PNGs
    if (!existsSync(absOutputDir)) {
      mkdirSync(absOutputDir, { recursive: true });
    }

    for (let i = 0; i < pages.length; i++) {
      const pagePath = resolve(absOutputDir, `Page${i + 1}.png`);
      const buffer = Buffer.from(pages[i]);
      writeFileSync(pagePath, buffer);
      console.log(
        `  Page${i + 1}.png (${(buffer.length / 1024).toFixed(0)} KB)`,
      );
    }

    console.log(`\nWrote ${pages.length} pages to: ${absOutputDir}`);
  } finally {
    await browser.close();
    stopServer();
  }
}

render().catch((err) => {
  console.error("Render failed:", err.message);
  stopServer();
  process.exit(1);
});
