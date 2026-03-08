/**
 * Shared logic for loading Excalidraw scene files.
 * Supports .note, .excalidraw.md (compressed or raw), and .excalidraw (raw JSON).
 */

import { readFileSync } from "node:fs";
import LZString from "lz-string";
import { convertNoteToScene } from "../../../notability-to-excalidraw/src/index";

function extractSceneFromMarkdown(content: string): string {
  // Try compressed-json block first
  const compressedMatch = content.match(/```compressed-json\n([\s\S]*?)\n```/);
  if (compressedMatch) {
    const compressed = compressedMatch[1].replace(/\n/g, "");
    const json = LZString.decompressFromBase64(compressed);
    if (!json) {
      throw new Error("Failed to decompress LZ-String data");
    }
    return json;
  }

  // Try raw JSON block
  const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    return jsonMatch[1];
  }

  throw new Error(
    "No ```json``` or ```compressed-json``` block found in markdown",
  );
}

/**
 * Load a renderable scene from a file path.
 * `.note` inputs are converted on the fly so the renderer always sees the
 * latest raw Notability payload instead of a stale exported scene file.
 */
export async function loadSceneFromFile(filePath: string): Promise<any> {
  if (filePath.endsWith(".note")) {
    return convertNoteToScene(filePath, {
      compress: false,
    });
  }

  const content = readFileSync(filePath, "utf-8");

  if (filePath.endsWith(".md")) {
    return JSON.parse(extractSceneFromMarkdown(content));
  }

  // .excalidraw or other — treat as raw JSON
  return JSON.parse(content);
}

/**
 * Add fractional index fields to elements (required by Excalidraw for ordering).
 */
export function addFractionalIndices(scene: any): void {
  if (Array.isArray(scene.elements)) {
    scene.elements.forEach((el: any, i: number) => {
      if (!el.index) {
        el.index = "a" + String(i).padStart(6, "0");
      }
    });
  }
}
