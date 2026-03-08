#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadSceneFromFile, addFractionalIndices } from "./lib/load-scene";

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Args = {
  inputPath: string;
  outputPath: string;
  ids: string[];
  bounds: Bounds | null;
  requireContained: boolean;
};

const args = parseArgs(process.argv.slice(2));
const scene = await loadSceneFromFile(args.inputPath);
addFractionalIndices(scene);

const elements = Array.isArray(scene.elements) ? scene.elements : [];
const selectedElements = elements.filter((element: any) =>
  shouldIncludeElement(element, args.ids, args.bounds, args.requireContained),
);

const subsetScene = {
  ...scene,
  elements: selectedElements,
};

mkdirSync(dirname(args.outputPath), { recursive: true });
writeFileSync(args.outputPath, JSON.stringify(subsetScene, null, 2));

console.log(
  JSON.stringify(
    {
      inputPath: args.inputPath,
      outputPath: args.outputPath,
      selectedCount: selectedElements.length,
      ids: args.ids,
      bounds: args.bounds,
      requireContained: args.requireContained,
    },
    null,
    2,
  ),
);

function parseArgs(argv: string[]): Args {
  const ids: string[] = [];
  let bounds: Bounds | null = null;
  let requireContained = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--id") {
      const id = argv[index + 1];
      if (!id) {
        throw new Error("Missing value for --id");
      }
      ids.push(id);
      index++;
      continue;
    }

    if (arg === "--bounds") {
      const x = Number(argv[index + 1]);
      const y = Number(argv[index + 2]);
      const width = Number(argv[index + 3]);
      const height = Number(argv[index + 4]);
      if (![x, y, width, height].every(Number.isFinite)) {
        throw new Error("Expected numeric values after --bounds");
      }
      bounds = { x, y, width, height };
      index += 4;
      continue;
    }

    if (arg === "--contained") {
      requireContained = true;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new Error(
      "Usage: bun scripts/extract-scene-subset.ts <input> <output> [--id <element-id> ...] [--bounds <x> <y> <width> <height>] [--contained]",
    );
  }

  if (ids.length === 0 && bounds === null) {
    throw new Error("Specify at least one --id or --bounds filter");
  }

  return {
    inputPath: resolve(positional[0]),
    outputPath: resolve(positional[1]),
    ids,
    bounds,
    requireContained,
  };
}

function shouldIncludeElement(
  element: any,
  ids: readonly string[],
  bounds: Bounds | null,
  requireContained: boolean,
) {
  if (ids.includes(element.id)) {
    return true;
  }

  if (!bounds) {
    return false;
  }

  const elementBounds = getElementBounds(element);
  if (!elementBounds) {
    return false;
  }

  if (requireContained) {
    return (
      elementBounds.x >= bounds.x &&
      elementBounds.y >= bounds.y &&
      elementBounds.x + elementBounds.width <= bounds.x + bounds.width &&
      elementBounds.y + elementBounds.height <= bounds.y + bounds.height
    );
  }

  return !(
    elementBounds.x + elementBounds.width < bounds.x ||
    elementBounds.y + elementBounds.height < bounds.y ||
    elementBounds.x > bounds.x + bounds.width ||
    elementBounds.y > bounds.y + bounds.height
  );
}

function getElementBounds(element: any): Bounds | null {
  if (
    typeof element?.x !== "number" ||
    typeof element?.y !== "number" ||
    typeof element?.width !== "number" ||
    typeof element?.height !== "number"
  ) {
    return null;
  }

  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
}
