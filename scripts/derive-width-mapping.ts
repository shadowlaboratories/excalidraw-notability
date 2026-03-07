#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadSceneFromFile } from "./lib/load-scene";

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = [number, number];

type ImportedPayload = {
  readonly source: "notability-spatial-hash";
  readonly scaleFactor: number;
  readonly rawControlPoints: readonly number[];
  readonly rawCurveWidth: number;
  readonly rawFractionalWidths: readonly number[];
  readonly rawForces: readonly number[];
};

type Sample = {
  readonly elementId: string;
  readonly rawCurveWidth: number;
  readonly fractionalWidth: number;
  readonly force: number;
  readonly measuredWidthDoc: number;
};

type FitResult = {
  readonly model: string;
  readonly gamma: number;
  readonly calibration: number;
  readonly rmse: number;
};

const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  a3: { width: 297, height: 420 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
};

const DEFAULT_THRESHOLD = "96%";
const DEFAULT_PADDING_DOC = 12;
const SAMPLE_STEP_PX = 0.25;
const MAX_NORMAL_DISTANCE_PX = 64;
const CENTER_SEARCH_DISTANCE_PX = 6;

const args = parseArgs(process.argv.slice(2));
const scene = await loadSceneFromFile(args.scenePath);
const pageSizePx = identifyImage(args.maskPath);
const pageSizeDoc = getPageSizeDoc(scene);
const scaleX = pageSizePx.width / pageSizeDoc.width;
const scaleY = pageSizePx.height / pageSizeDoc.height;
const subsetBoundsDoc = getSceneBounds(scene);
const cropBoundsPx = {
  x: Math.max(0, Math.floor((subsetBoundsDoc.x - args.paddingDoc) * scaleX)),
  y: Math.max(0, Math.floor((subsetBoundsDoc.y - args.paddingDoc) * scaleY)),
  width: Math.min(
    pageSizePx.width,
    Math.ceil((subsetBoundsDoc.width + args.paddingDoc * 2) * scaleX),
  ),
  height: Math.min(
    pageSizePx.height,
    Math.ceil((subsetBoundsDoc.height + args.paddingDoc * 2) * scaleY),
  ),
};
const mask = readBinaryMask(args.maskPath, cropBoundsPx, args.threshold);
const samples = collectSamples(scene, mask, cropBoundsPx, scaleX, scaleY);

if (samples.length === 0) {
  throw new Error("Unable to collect any usable width samples");
}

const fractionalPowerFit = fitPowerModel(
  samples,
  "fractionalWidth",
  (sample, gamma) => Math.pow(Math.max(sample.fractionalWidth, 1e-6), gamma),
);
const forcePowerFit = fitPowerModel(
  samples,
  "force",
  (sample, gamma) => Math.pow(Math.max(sample.force, 1e-6), gamma),
);
const fractionalLinearFit = fitLinearModel(samples, "fractionalWidth");
const forceLinearFit = fitLinearModel(samples, "force");

console.log(
  JSON.stringify(
    {
      scenePath: args.scenePath,
      maskPath: args.maskPath,
      threshold: args.threshold,
      paddingDoc: args.paddingDoc,
      pageSizeDoc,
      pageSizePx,
      scale: {
        x: scaleX,
        y: scaleY,
      },
      offsetPx: {
        x: args.offsetXPx,
        y: args.offsetYPx,
      },
      subsetBoundsDoc,
      cropBoundsPx,
      sampleCount: samples.length,
      rawCurveWidths: summarizeNumberSet(samples.map((sample) => sample.rawCurveWidth)),
      fractionalWidths: summarizeNumberSet(
        samples.map((sample) => sample.fractionalWidth),
      ),
      forces: summarizeNumberSet(samples.map((sample) => sample.force)),
      measuredWidthsDoc: summarizeNumberSet(
        samples.map((sample) => sample.measuredWidthDoc),
      ),
      fits: {
        fractionalPowerFit,
        forcePowerFit,
        fractionalLinearFit,
        forceLinearFit,
      },
    },
    null,
    2,
  ),
);

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let threshold = DEFAULT_THRESHOLD;
  let paddingDoc = DEFAULT_PADDING_DOC;
  let offsetXPx = 0;
  let offsetYPx = 0;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--threshold") {
      threshold = argv[index + 1] ?? DEFAULT_THRESHOLD;
      index++;
      continue;
    }

    if (arg === "--padding-doc") {
      paddingDoc = Number(argv[index + 1] ?? DEFAULT_PADDING_DOC);
      index++;
      continue;
    }

    if (arg === "--offset-x-px") {
      offsetXPx = Number(argv[index + 1] ?? 0);
      index++;
      continue;
    }

    if (arg === "--offset-y-px") {
      offsetYPx = Number(argv[index + 1] ?? 0);
      index++;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new Error(
      "Usage: bun run scripts/derive-width-mapping.ts <scene> <mask.png> [--threshold 96%] [--padding-doc 12]",
    );
  }

  return {
    scenePath: resolve(positional[0]),
    maskPath: resolve(positional[1]),
    threshold,
    paddingDoc,
    offsetXPx,
    offsetYPx,
  };
}

function identifyImage(imagePath: string) {
  const result = spawnSync(
    "magick",
    ["identify", "-format", "%w %h", imagePath],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to identify ${imagePath}`);
  }

  const [widthText, heightText] = result.stdout.trim().split(/\s+/);
  const width = Number(widthText);
  const height = Number(heightText);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Unable to parse image size for ${imagePath}`);
  }

  return { width, height };
}

function getPageSizeDoc(scene: any) {
  const metadata = scene?.notability;
  const pageWidth =
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
      width: pageWidth,
      height: pageWidth * (11 / 8.5),
    };
  }

  const aspectRatio =
    paperOrientation === "landscape"
      ? paper.width / paper.height
      : paper.height / paper.width;

  return {
    width: pageWidth,
    height: pageWidth * aspectRatio,
  };
}

function getSceneBounds(scene: any): Bounds {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    if (
      typeof element?.x !== "number" ||
      typeof element?.y !== "number" ||
      typeof element?.width !== "number" ||
      typeof element?.height !== "number"
    ) {
      continue;
    }

    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + element.width);
    maxY = Math.max(maxY, element.y + element.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    throw new Error("Unable to derive scene bounds");
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function readBinaryMask(imagePath: string, cropBounds: Bounds, threshold: string) {
  const result = spawnSync(
    "magick",
    [
      imagePath,
      "-crop",
      `${cropBounds.width}x${cropBounds.height}+${cropBounds.x}+${cropBounds.y}`,
      "+repage",
      "-alpha",
      "off",
      "-colorspace",
      "gray",
      "-threshold",
      threshold,
      "-negate",
      "txt:-",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to rasterize mask from ${imagePath}`);
  }

  const occupied = Array.from({ length: cropBounds.height }, () =>
    new Uint8Array(cropBounds.width),
  );

  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^(\d+),(\d+):.*gray\((\d+)\)/);
    if (!match) {
      continue;
    }

    const x = Number(match[1]);
    const y = Number(match[2]);
    const gray = Number(match[3]);

    if (
      x >= 0 &&
      y >= 0 &&
      y < occupied.length &&
      x < occupied[y]!.length &&
      gray > 0
    ) {
      occupied[y]![x] = 1;
    }
  }

  return occupied;
}

function collectSamples(
  scene: any,
  mask: Uint8Array[],
  cropBoundsPx: Bounds,
  scaleX: number,
  scaleY: number,
): Sample[] {
  const samples: Sample[] = [];
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];

  for (const element of elements) {
    const payload = element?.customData?.notabilityStroke as ImportedPayload | undefined;
    if (!payload || payload.source !== "notability-spatial-hash") {
      continue;
    }
    if (!Array.isArray(payload.rawControlPoints) || payload.rawControlPoints.length < 8) {
      continue;
    }

    const controlPoints = getAbsoluteControlPoints(payload);
    const segmentCount = Math.floor((controlPoints.length - 1) / 3);
    const attributeCount = segmentCount + 1;

    for (let attributeIndex = 0; attributeIndex < attributeCount; attributeIndex++) {
      const point = controlPoints[attributeIndex * 3];
      if (!point) {
        continue;
      }
      const tangent = tangentAtAttribute(controlPoints, attributeIndex);
      if (!tangent) {
        continue;
      }

      const measuredWidthDoc = measureWidthAtPoint(
        mask,
        cropBoundsPx,
        point,
        tangent,
        scaleX,
        scaleY,
        args.offsetXPx,
        args.offsetYPx,
      );
      if (!measuredWidthDoc) {
        continue;
      }

      const fractionalWidth = Math.abs(payload.rawFractionalWidths[attributeIndex] ?? 1);
      const force = Math.abs(payload.rawForces[attributeIndex] ?? 1);

      if (!(payload.rawCurveWidth > 0) || !(fractionalWidth > 0) || !(force > 0)) {
        continue;
      }

      samples.push({
        elementId: element.id,
        rawCurveWidth: Math.abs(payload.rawCurveWidth),
        fractionalWidth,
        force,
        measuredWidthDoc,
      });
    }
  }

  return samples;
}

function getAbsoluteControlPoints(payload: ImportedPayload): Point[] {
  const controlPoints: Point[] = [];
  const scaleFactor =
    typeof payload.scaleFactor === "number" && Number.isFinite(payload.scaleFactor)
      ? payload.scaleFactor
      : 1;

  for (let index = 0; index + 1 < payload.rawControlPoints.length; index += 2) {
    controlPoints.push([
      payload.rawControlPoints[index]! * scaleFactor,
      payload.rawControlPoints[index + 1]! * scaleFactor,
    ]);
  }

  return controlPoints;
}

function tangentAtAttribute(controlPoints: Point[], attributeIndex: number) {
  const segmentCount = Math.floor((controlPoints.length - 1) / 3);

  if (attributeIndex === 0) {
    return cubicDerivativeAt(
      controlPoints[0]!,
      controlPoints[1]!,
      controlPoints[2]!,
      controlPoints[3]!,
      0,
    );
  }

  if (attributeIndex === segmentCount) {
    const baseIndex = (segmentCount - 1) * 3;
    return cubicDerivativeAt(
      controlPoints[baseIndex]!,
      controlPoints[baseIndex + 1]!,
      controlPoints[baseIndex + 2]!,
      controlPoints[baseIndex + 3]!,
      1,
    );
  }

  const previousBaseIndex = (attributeIndex - 1) * 3;
  const nextBaseIndex = attributeIndex * 3;
  const previousDerivative = cubicDerivativeAt(
    controlPoints[previousBaseIndex]!,
    controlPoints[previousBaseIndex + 1]!,
    controlPoints[previousBaseIndex + 2]!,
    controlPoints[previousBaseIndex + 3]!,
    1,
  );
  const nextDerivative = cubicDerivativeAt(
    controlPoints[nextBaseIndex]!,
    controlPoints[nextBaseIndex + 1]!,
    controlPoints[nextBaseIndex + 2]!,
    controlPoints[nextBaseIndex + 3]!,
    0,
  );

  return [previousDerivative[0] + nextDerivative[0], previousDerivative[1] + nextDerivative[1]];
}

function cubicDerivativeAt(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const mt = 1 - t;

  return [
    3 * mt * mt * (p1[0] - p0[0]) +
      6 * mt * t * (p2[0] - p1[0]) +
      3 * t * t * (p3[0] - p2[0]),
    3 * mt * mt * (p1[1] - p0[1]) +
      6 * mt * t * (p2[1] - p1[1]) +
      3 * t * t * (p3[1] - p2[1]),
  ];
}

function measureWidthAtPoint(
  mask: Uint8Array[],
  cropBoundsPx: Bounds,
  pointDoc: Point,
  tangentDoc: Point,
  scaleX: number,
  scaleY: number,
  offsetXPx: number,
  offsetYPx: number,
) {
  const tangentLength = Math.hypot(tangentDoc[0], tangentDoc[1]);
  if (!(tangentLength > 1e-6)) {
    return null;
  }

  const normalDoc: Point = [
    -tangentDoc[1] / tangentLength,
    tangentDoc[0] / tangentLength,
  ];
  const normalScale = Math.hypot(normalDoc[0] * scaleX, normalDoc[1] * scaleY);
  if (!(normalScale > 1e-6)) {
    return null;
  }

  const centerPx: Point = [
    pointDoc[0] * scaleX + offsetXPx - cropBoundsPx.x,
    pointDoc[1] * scaleY + offsetYPx - cropBoundsPx.y,
  ];
  const normalPx: Point = [
    (normalDoc[0] * scaleX) / normalScale,
    (normalDoc[1] * scaleY) / normalScale,
  ];

  const sampleCount = Math.floor((MAX_NORMAL_DISTANCE_PX * 2) / SAMPLE_STEP_PX) + 1;
  const occupancies: boolean[] = [];
  const offsets: number[] = [];

  for (let index = 0; index < sampleCount; index++) {
    const offset = -MAX_NORMAL_DISTANCE_PX + index * SAMPLE_STEP_PX;
    offsets.push(offset);
    const sampleX = Math.round(centerPx[0] + normalPx[0] * offset);
    const sampleY = Math.round(centerPx[1] + normalPx[1] * offset);
    occupancies.push(isOccupied(mask, sampleX, sampleY));
  }

  let centerIndex = Math.round((0 + MAX_NORMAL_DISTANCE_PX) / SAMPLE_STEP_PX);
  if (!occupancies[centerIndex]) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < occupancies.length; index++) {
      if (!occupancies[index]) {
        continue;
      }
      const distance = Math.abs(offsets[index]!);
      if (distance <= CENTER_SEARCH_DISTANCE_PX && distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    if (nearestIndex === -1) {
      return null;
    }
    centerIndex = nearestIndex;
  }

  let leftIndex = centerIndex;
  while (leftIndex > 0 && occupancies[leftIndex - 1]) {
    leftIndex--;
  }

  let rightIndex = centerIndex;
  while (rightIndex + 1 < occupancies.length && occupancies[rightIndex + 1]) {
    rightIndex++;
  }

  const spanPx = offsets[rightIndex]! - offsets[leftIndex]!;
  if (!(spanPx > 0)) {
    return null;
  }

  return spanPx / normalScale;
}

function isOccupied(mask: Uint8Array[], x: number, y: number) {
  return y >= 0 && y < mask.length && x >= 0 && x < mask[y]!.length && mask[y]![x] === 1;
}

function fitPowerModel(
  samples: readonly Sample[],
  label: string,
  factorAtGamma: (sample: Sample, gamma: number) => number,
): FitResult {
  let best: FitResult | null = null;

  for (let gamma = 0.4; gamma <= 1.6; gamma += 0.05) {
    const basis = samples.map((sample) => sample.rawCurveWidth * factorAtGamma(sample, gamma));
    const calibration = leastSquaresScale(basis, samples.map((sample) => sample.measuredWidthDoc));
    const rmse = rootMeanSquareError(
      basis.map((value) => value * calibration),
      samples.map((sample) => sample.measuredWidthDoc),
    );
    const fit = {
      model: `${label}^gamma`,
      gamma: Number(gamma.toFixed(3)),
      calibration,
      rmse,
    };

    if (!best || fit.rmse < best.rmse) {
      best = fit;
    }
  }

  if (!best) {
    throw new Error(`Unable to fit ${label} power model`);
  }

  return best;
}

function fitLinearModel(
  samples: readonly Sample[],
  label: "fractionalWidth" | "force",
) {
  let s00 = 0;
  let s01 = 0;
  let s11 = 0;
  let t0 = 0;
  let t1 = 0;

  for (const sample of samples) {
    const curveWidth = sample.rawCurveWidth;
    const factor = sample[label];
    const measured = sample.measuredWidthDoc;
    const x0 = curveWidth;
    const x1 = curveWidth * factor;
    s00 += x0 * x0;
    s01 += x0 * x1;
    s11 += x1 * x1;
    t0 += x0 * measured;
    t1 += x1 * measured;
  }

  const determinant = s00 * s11 - s01 * s01;
  if (Math.abs(determinant) < 1e-9) {
    return null;
  }

  const b = (s11 * t0 - s01 * t1) / determinant;
  const a = (s00 * t1 - s01 * t0) / determinant;
  const predictions = samples.map(
    (sample) => sample.rawCurveWidth * (a * sample[label] + b),
  );

  return {
    model: `${label} * a + b`,
    a,
    b,
    rmse: rootMeanSquareError(
      predictions,
      samples.map((sample) => sample.measuredWidthDoc),
    ),
  };
}

function leastSquaresScale(basis: readonly number[], targets: readonly number[]) {
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < basis.length; index++) {
    numerator += basis[index]! * targets[index]!;
    denominator += basis[index]! * basis[index]!;
  }

  return denominator > 0 ? numerator / denominator : 0;
}

function rootMeanSquareError(predictions: readonly number[], targets: readonly number[]) {
  let sum = 0;
  for (let index = 0; index < predictions.length; index++) {
    const error = predictions[index]! - targets[index]!;
    sum += error * error;
  }
  return Math.sqrt(sum / Math.max(1, predictions.length));
}

function summarizeNumberSet(values: readonly number[]) {
  const sortedValues = [...values].sort((left, right) => left - right);
  return {
    count: sortedValues.length,
    min: sortedValues[0],
    median: percentile(sortedValues, 0.5),
    max: sortedValues[sortedValues.length - 1],
  };
}

function percentile(sortedValues: readonly number[], ratio: number) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[index]!;
}
