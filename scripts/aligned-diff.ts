#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const CONTENT_THRESHOLD = "96%";

const [, , referencePathArg, candidatePathArg, outputPrefixArg] = process.argv;

if (!referencePathArg || !candidatePathArg || !outputPrefixArg) {
  console.error(
    "Usage: bun run scripts/aligned-diff.ts <reference.png> <candidate.png> <output-prefix>",
  );
  process.exit(1);
}

const referencePath = resolve(referencePathArg);
const candidatePath = resolve(candidatePathArg);
const outputPrefix = resolve(outputPrefixArg);

mkdirSync(dirname(outputPrefix), { recursive: true });

const referenceBounds = getNonWhiteBounds(referencePath);
const candidateBounds = getNonWhiteBounds(candidatePath);

const referenceCropPath = `${outputPrefix}-reference-crop.png`;
const candidateCropPath = `${outputPrefix}-candidate-crop.png`;
const candidateAlignedPath = `${outputPrefix}-candidate-aligned.png`;
const sideBySidePath = `${outputPrefix}-side.png`;
const diffPath = `${outputPrefix}-diff.png`;

cropImage(referencePath, referenceBounds, referenceCropPath);
cropImage(candidatePath, candidateBounds, candidateCropPath);
resizeImage(
  candidateCropPath,
  referenceBounds.width,
  referenceBounds.height,
  candidateAlignedPath,
);
appendImages(referenceCropPath, candidateAlignedPath, sideBySidePath);

const rmse = compareImages(referenceCropPath, candidateAlignedPath, diffPath);

console.log(JSON.stringify({
  referencePath,
  candidatePath,
  referenceBounds,
  candidateBounds,
  alignment: {
    mode: "content-bounds",
    threshold: CONTENT_THRESHOLD,
    scaleX: referenceBounds.width / candidateBounds.width,
    scaleY: referenceBounds.height / candidateBounds.height,
    targetTopLeft: [0, 0],
    targetBottomRight: [referenceBounds.width - 1, referenceBounds.height - 1],
  },
  alignedSize: {
    width: referenceBounds.width,
    height: referenceBounds.height,
  },
  rmse,
  outputs: {
    referenceCropPath,
    candidateCropPath,
    candidateAlignedPath,
    sideBySidePath,
    diffPath,
  },
}, null, 2));

function getNonWhiteBounds(imagePath: string): Bounds {
  const result = spawnSync(
    "magick",
    [
      imagePath,
      "-alpha",
      "off",
      "-colorspace",
      "gray",
      "-threshold",
      CONTENT_THRESHOLD,
      "-negate",
      "-define",
      "connected-components:verbose=true",
      "-connected-components",
      "4",
      "null:",
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to inspect ${imagePath}`);
  }

  const componentLines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+: \d+x\d+\+\d+\+\d+/.test(line));

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const line of componentLines) {
    const match = line.match(/^(\d+): (\d+)x(\d+)\+(\d+)\+(\d+)/);
    if (!match) {
      continue;
    }

    const id = Number(match[1]);
    if (id === 0) {
      continue;
    }

    const width = Number(match[2]);
    const height = Number(match[3]);
    const x = Number(match[4]);
    const y = Number(match[5]);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    throw new Error(`No non-white content detected in ${imagePath}`);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function cropImage(inputPath: string, bounds: Bounds, outputPath: string) {
  runOrThrow("magick", [
    inputPath,
    "-crop",
    `${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`,
    "+repage",
    outputPath,
  ]);
}

function resizeImage(
  inputPath: string,
  width: number,
  height: number,
  outputPath: string,
) {
  runOrThrow("magick", [
    inputPath,
    "-filter",
    "Lanczos",
    "-resize",
    `${width}x${height}!`,
    outputPath,
  ]);
}

function appendImages(
  leftPath: string,
  rightPath: string,
  outputPath: string,
) {
  runOrThrow("magick", [leftPath, rightPath, "+append", outputPath]);
}

function compareImages(
  referenceAlignedPath: string,
  candidateAlignedPath: string,
  diffPath: string,
) {
  const result = spawnSync(
    "magick",
    [
      "compare",
      "-metric",
      "RMSE",
      "-compose",
      "src",
      referenceAlignedPath,
      candidateAlignedPath,
      diffPath,
    ],
    { encoding: "utf8" },
  );

  const metricOutput = `${result.stdout}${result.stderr}`.trim();
  const match = metricOutput.match(/\(([\d.]+)\)/);
  if (!match) {
    throw new Error(
      `Unable to parse compare metric output: ${metricOutput || "<empty>"}`,
    );
  }

  return Number(match[1]);
}

function runOrThrow(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Command failed: ${command} ${args.join(" ")}`);
  }
}
