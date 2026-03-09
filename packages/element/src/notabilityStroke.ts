/**
 * Notability-style stroke renderer.
 *
 * Imported Notability strokes use the raw cubic control points and attribute
 * samples preserved in element.customData. Fresh strokes can also opt into a
 * live Notability-style fitter by storing richer pointer samples in
 * element.customData.
 */

import type { ExcalidrawFreeDrawElement, PenVariant } from "./types";

type ImportedNotabilityStrokeData = {
  readonly version: 1;
  readonly source: "notability-spatial-hash";
  readonly curveIndex: number;
  readonly referencedByShape: boolean;
  readonly scaleFactor: number;
  readonly strokeWidthScale: number;
  readonly rawControlPoints: readonly number[];
  readonly rawForces: readonly number[];
  readonly rawFractionalWidths: readonly number[];
  readonly rawAltitudeAngles: readonly number[];
  readonly rawAzimuthUnitVectors: readonly number[];
  readonly rawCurveWidth: number;
  readonly rawCurveStyle: number | null;
  readonly rawCurveOptions: string | null;
  readonly curveUuid: string | null;
  readonly bezierPathData: unknown | null;
  readonly rawColor:
    | { readonly a: number; readonly r: number; readonly g: number; readonly b: number }
    | null;
  readonly defaultStrokeWidth: number;
  readonly defaultStrokeColor: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
};

export type LiveNotabilityStrokeSample = {
  readonly timestamp: number;
  readonly force: number;
  readonly azimuthX: number;
  readonly azimuthY: number;
  readonly altitude: number;
  readonly predicted?: boolean;
  readonly estimatedPropsExpectingUpdates?: number;
  readonly expectedUpdatesTimedOut?: boolean;
};

export type LiveNotabilityStrokeData = {
  readonly version: 1;
  readonly source: "excalidraw-live-input";
  readonly zoomAtCreation: number;
  readonly samples: readonly LiveNotabilityStrokeSample[];
};

// ---------------------------------------------------------------------------
// Pen configuration
// ---------------------------------------------------------------------------

export interface PenConfig {
  readonly minSize: number;
  readonly maxSize: number;
  readonly thinning: number; // 0-1: how much pressure affects width
  readonly smoothing: number; // Catmull-Rom tension (0 = tight, 1 = loose)
  readonly opacity: number; // 0-100
  readonly taperStart: number; // taper distance in pixels
  readonly taperEnd: number;
  readonly roundCaps: boolean;
  readonly compositeOp: GlobalCompositeOperation;
  readonly textureNoise: number; // 0 = none, >0 = pencil jitter amount
  readonly linearWidth: boolean; // if true: width = pressure * baseWidth (no clamp/thinning)
}

export const PEN_CONFIGS: Record<PenVariant, PenConfig> = {
  pen: {
    minSize: 1,
    maxSize: 4,
    thinning: 0.6,
    smoothing: 0.5,
    opacity: 100,
    taperStart: 0,
    taperEnd: 0,
    roundCaps: true,
    compositeOp: "source-over",
    textureNoise: 0,
    linearWidth: true,
  },
  pencil: {
    minSize: 0.5,
    maxSize: 2,
    thinning: 0.3,
    smoothing: 0.4,
    opacity: 70,
    taperStart: 4,
    taperEnd: 4,
    roundCaps: true,
    compositeOp: "source-over",
    textureNoise: 0.8,
    linearWidth: false,
  },
  marker: {
    minSize: 6,
    maxSize: 16,
    thinning: 0.1,
    smoothing: 0.6,
    opacity: 90,
    taperStart: 0,
    taperEnd: 0,
    roundCaps: false,
    compositeOp: "source-over",
    textureNoise: 0,
    linearWidth: false,
  },
  highlighter: {
    minSize: 16,
    maxSize: 30,
    thinning: 0,
    smoothing: 0.5,
    opacity: 30,
    taperStart: 0,
    taperEnd: 0,
    roundCaps: false,
    compositeOp: "multiply",
    textureNoise: 0,
    linearWidth: false,
  },
};

// ---------------------------------------------------------------------------
// NotabilityStrokeShape — the cached shape returned by generateNotabilityStroke
// ---------------------------------------------------------------------------

export type NotabilityStrokeShape = {
  readonly type: "notability_stroke";
  readonly outlinePoints: readonly [number, number][];
  readonly pathData?: string;
  readonly sampledContours?: readonly (readonly [number, number][])[];
  readonly compositeOp: GlobalCompositeOperation;
  readonly penOpacity: number;
  readonly roundCaps: boolean;
  readonly capStart: { center: [number, number]; radius: number };
  readonly capEnd: { center: [number, number]; radius: number };
};

const IMPORTED_NOTABILITY_CURVE_POINT_DIVISION_COUNT = 3;
const MIN_STROKE_POINT_DISTANCE = 0.35;
const DEFAULT_LIVE_FORCE = 0.5;
const DEFAULT_LIVE_ALTITUDE = Math.PI / 2;

type PointerSampleLike = {
  pressure?: number;
  timeStamp?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  tiltX?: number;
  tiltY?: number;
};

function importedBaseWidthCalibration(payload: ImportedNotabilityStrokeData) {
  return 1;
}

function importedWidthFactor(
  payload: ImportedNotabilityStrokeData,
  widthFactor: number,
) {
  return Math.abs(widthFactor);
}

function getImportedNotabilityStrokeData(
  element: ExcalidrawFreeDrawElement,
): ImportedNotabilityStrokeData | null {
  const payload = element.customData?.notabilityStroke;
  if (
    payload &&
    typeof payload === "object" &&
    (payload as ImportedNotabilityStrokeData).source ===
      "notability-spatial-hash" &&
    Array.isArray((payload as ImportedNotabilityStrokeData).rawControlPoints)
  ) {
    return payload as ImportedNotabilityStrokeData;
  }

  return null;
}

export function getLiveNotabilityStrokeData(
  element: ExcalidrawFreeDrawElement,
): LiveNotabilityStrokeData | null {
  const payload = element.customData?.liveNotabilityStroke;
  if (
    payload &&
    typeof payload === "object" &&
    (payload as LiveNotabilityStrokeData).source === "excalidraw-live-input" &&
    Array.isArray((payload as LiveNotabilityStrokeData).samples)
  ) {
    return payload as LiveNotabilityStrokeData;
  }

  return null;
}

export function hasImportedNotabilityStrokeData(
  element: ExcalidrawFreeDrawElement,
): boolean {
  return getImportedNotabilityStrokeData(element) !== null;
}

export function hasLiveNotabilityStrokeData(
  element: ExcalidrawFreeDrawElement,
): boolean {
  return getLiveNotabilityStrokeData(element) !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveLiveAltitudeAngle(event: PointerSampleLike) {
  if (isFiniteNumber(event.altitudeAngle)) {
    return event.altitudeAngle;
  }

  const tiltX = isFiniteNumber(event.tiltX) ? event.tiltX : 0;
  const tiltY = isFiniteNumber(event.tiltY) ? event.tiltY : 0;
  const tiltMagnitude = Math.min(90, Math.hypot(tiltX, tiltY));
  return Math.max(0, DEFAULT_LIVE_ALTITUDE - (tiltMagnitude * Math.PI) / 180);
}

function resolveLiveAzimuthVector(
  event: PointerSampleLike,
): [number, number] {
  if (isFiniteNumber(event.azimuthAngle)) {
    return [Math.cos(event.azimuthAngle), Math.sin(event.azimuthAngle)];
  }

  const tiltX = isFiniteNumber(event.tiltX) ? event.tiltX : 0;
  const tiltY = isFiniteNumber(event.tiltY) ? event.tiltY : 0;
  const length = Math.hypot(tiltX, tiltY);
  if (length > 1e-6) {
    return [tiltX / length, tiltY / length];
  }

  return [1, 0];
}

export function createLiveNotabilitySample(
  event: PointerSampleLike,
): LiveNotabilityStrokeSample {
  const force =
    isFiniteNumber(event.pressure) && event.pressure > 0
      ? event.pressure
      : DEFAULT_LIVE_FORCE;
  const [azimuthX, azimuthY] = resolveLiveAzimuthVector(event);

  return {
    timestamp: isFiniteNumber(event.timeStamp) ? event.timeStamp : Date.now(),
    force,
    azimuthX,
    azimuthY,
    altitude: resolveLiveAltitudeAngle(event),
    predicted: false,
    estimatedPropsExpectingUpdates: 0,
    expectedUpdatesTimedOut: false,
  };
}

export function createLiveNotabilityStrokeData(
  zoomAtCreation: number,
  sample: LiveNotabilityStrokeSample,
): LiveNotabilityStrokeData {
  return {
    version: 1,
    source: "excalidraw-live-input",
    zoomAtCreation:
      isFiniteNumber(zoomAtCreation) && zoomAtCreation > 0
        ? zoomAtCreation
        : 1,
    samples: [sample],
  };
}

export function appendLiveNotabilitySample(
  payload: LiveNotabilityStrokeData | null | undefined,
  sample: LiveNotabilityStrokeSample,
): LiveNotabilityStrokeData {
  return {
    version: 1,
    source: "excalidraw-live-input",
    zoomAtCreation:
      payload && payload.source === "excalidraw-live-input" &&
      isFiniteNumber(payload.zoomAtCreation) &&
      payload.zoomAtCreation > 0
        ? payload.zoomAtCreation
        : 1,
    samples:
      payload && payload.source === "excalidraw-live-input"
        ? [...payload.samples, sample]
        : [sample],
  };
}

// ---------------------------------------------------------------------------
// Seeded PRNG for deterministic pencil noise (from element.seed)
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Catmull-Rom spline interpolation
// ---------------------------------------------------------------------------

function catmullRomPoint(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
  alpha: number = 0.5,
): [number, number] {
  // Standard Catmull-Rom matrix formulation
  const t2 = t * t;
  const t3 = t2 * t;
  const s = (1 - alpha) / 2;

  const x =
    (2 * p1[0]) +
    (-p0[0] + p2[0]) * s * 2 * t +
    (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * s * t2 +
    (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * s * t3;

  const y =
    (2 * p1[1]) +
    (-p0[1] + p2[1]) * s * 2 * t +
    (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s * t2 +
    (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s * t3;

  return [x / 2, y / 2];
}

/**
 * Interpolate raw input points with Catmull-Rom spline.
 * Returns a denser array of smooth points with interpolated pressure values.
 */
function interpolateStroke(
  points: [number, number][],
  pressures: number[],
  segmentsPerSpan: number,
  tension: number,
): { points: [number, number][]; pressures: number[] } {
  const n = points.length;
  if (n === 0) {
    return { points: [], pressures: [] };
  }
  if (n === 1) {
    return { points: [[...points[0]]], pressures: [pressures[0]] };
  }
  if (n === 2) {
    // Simple linear interpolation for 2-point strokes
    const result: [number, number][] = [];
    const resPressures: number[] = [];
    for (let i = 0; i <= segmentsPerSpan; i++) {
      const t = i / segmentsPerSpan;
      result.push([
        points[0][0] + (points[1][0] - points[0][0]) * t,
        points[0][1] + (points[1][1] - points[0][1]) * t,
      ]);
      resPressures.push(pressures[0] + (pressures[1] - pressures[0]) * t);
    }
    return { points: result, pressures: resPressures };
  }

  const result: [number, number][] = [];
  const resPressures: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    // Catmull-Rom needs 4 control points: p0, p1, p2, p3
    // Mirror at boundaries
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[Math.min(n - 1, i + 1)];
    const p3 = points[Math.min(n - 1, i + 2)];

    const pr1 = pressures[i];
    const pr2 = pressures[Math.min(n - 1, i + 1)];

    const segs = i === n - 2 ? segmentsPerSpan : segmentsPerSpan; // include last point on final segment
    for (let j = 0; j < segs; j++) {
      const t = j / segs;
      const pt = catmullRomPoint(p0, p1, p2, p3, t, tension);
      result.push(pt);
      // Linear interpolation for pressure
      resPressures.push(pr1 + (pr2 - pr1) * t);
    }
  }

  // Always include the very last point
  result.push([...points[n - 1]]);
  resPressures.push(pressures[n - 1]);

  return { points: result, pressures: resPressures };
}

// ---------------------------------------------------------------------------
// Width computation from pressure
// ---------------------------------------------------------------------------

function computeWidths(
  pressures: number[],
  config: PenConfig,
  baseStrokeWidth: number,
): number[] {
  return pressures.map((pressure) => {
    // Clamp pressure to 0-1
    const p = Math.max(0, Math.min(1, pressure));
    // Blend between constant width (no thinning) and pressure-modulated width
    const pressureFactor = 1 - config.thinning + config.thinning * p;
    const sizeRange = config.minSize + (config.maxSize - config.minSize) * p;
    const width = baseStrokeWidth * pressureFactor * (sizeRange / config.maxSize);
    return Math.max(0.5, width);
  });
}

// ---------------------------------------------------------------------------
// Arc-length utilities
// ---------------------------------------------------------------------------

function computeArcLengths(points: [number, number][]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  return lengths;
}

// ---------------------------------------------------------------------------
// Outline polygon generation
// ---------------------------------------------------------------------------

function generateOutlinePolygon(
  centerline: [number, number][],
  widths: number[],
  config: PenConfig,
  seed: number,
): [number, number][] {
  const n = centerline.length;
  if (n < 2) {
    return [];
  }

  const left: [number, number][] = [];
  const right: [number, number][] = [];

  const arcLengths = computeArcLengths(centerline);
  const totalLength = arcLengths[n - 1];
  const rng = config.textureNoise > 0 ? seededRandom(seed) : null;

  for (let i = 0; i < n; i++) {
    // Compute tangent direction using neighbors
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(n - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    // Perpendicular unit vector (left-pointing)
    const nx = -dy / len;
    const ny = dx / len;

    let w = widths[i];

    // Apply tapering
    const distFromStart = arcLengths[i];
    const distFromEnd = totalLength - distFromStart;
    if (config.taperStart > 0 && distFromStart < config.taperStart) {
      w *= distFromStart / config.taperStart;
    }
    if (config.taperEnd > 0 && distFromEnd < config.taperEnd) {
      w *= distFromEnd / config.taperEnd;
    }

    // Apply texture noise (seeded for determinism)
    if (rng && config.textureNoise > 0) {
      const noise = (rng() - 0.5) * 2 * config.textureNoise;
      w = Math.max(0.2, w + noise);
    }

    const halfW = w / 2;
    left.push([
      centerline[i][0] + nx * halfW,
      centerline[i][1] + ny * halfW,
    ]);
    right.push([
      centerline[i][0] - nx * halfW,
      centerline[i][1] - ny * halfW,
    ]);
  }

  // Build closed polygon: left forward, then right reversed
  return [...left, ...right.reverse()];
}

function cubicPointAt(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
): [number, number] {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;

  return [
    mt2 * mt * p0[0] +
      3 * mt2 * t * p1[0] +
      3 * mt * t2 * p2[0] +
      t2 * t * p3[0],
    mt2 * mt * p0[1] +
      3 * mt2 * t * p1[1] +
      3 * mt * t2 * p2[1] +
      t2 * t * p3[1],
  ];
}

function cubicDerivativeAt(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
): [number, number] {
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

type ImportedStrokeLocation = {
  elementIndex: number;
  t: number;
};

type ImportedStrokeSegment = {
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
};

type ImportedStrokeComponent = {
  segments: ImportedStrokeSegment[];
  radii: number[];
};

type ImportedStrokeRange = {
  start: ImportedStrokeLocation;
  end: ImportedStrokeLocation;
};

type ImportedStrokeIteratorConfiguration = {
  minimumElementLength: number;
  minimumSubdivisionStepSize: number;
  maximumAllowedCurveError: number;
  maximumCurveApproximateAsLineDistance: number;
  minimumInternalArcLength: number;
};

type ImportedStrokeElementCache = {
  startPhi: number;
  endPhi: number;
  startAngle: number;
  endAngle: number;
};

type ImportedStrokeIterator = {
  configuration: ImportedStrokeIteratorConfiguration;
  reversed: boolean;
  component: ImportedStrokeComponent;
  numberOfElements: number;
  currentLocation: ImportedStrokeLocation;
  elementCache: ImportedStrokeElementCache[];
};

type CubicCurve = {
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
};

type NativeNotabilityControlPoint = {
  location: [number, number];
  timestamp: number;
  force: number;
  altitude: number;
  azimuthX: number;
  azimuthY: number;
  predicted: boolean;
  estimatedPropsExpectingUpdates: number;
  expectedUpdatesTimedOut: boolean;
};

type NativeCurveItem = {
  curve: CubicCurve;
  windowStart: number;
  windowEnd: number;
  t0: number;
  t1: number;
};

type NativePathAttribute = {
  widthScale: number;
  force: number;
  altitude: number;
  azimuthX: number;
  azimuthY: number;
};

type NativeAttributedCurve = {
  curve: CubicCurve;
  startIndex: number;
  endIndex: number;
  startAttribute: NativePathAttribute;
  endAttribute: NativePathAttribute;
};

const NATIVE_FIT_EPSILON = 1e-9;
const NATIVE_MIN_EFFECTIVE_SIZE = 2.6;
const NATIVE_MAX_EFFECTIVE_SIZE = 18;
const NATIVE_EFFECTIVE_SIZE_RANGE = 15.4;
const NATIVE_FORCE_TO_WIDTH_SCALE = 0.67;
const NATIVE_FORCE_BASELINE = 0.7;
const NATIVE_FORCE_SPLIT_THRESHOLD = 0.25;
const NATIVE_ALTITUDE_SPLIT_THRESHOLD = (5 * Math.PI) / 180;
const NATIVE_AZIMUTH_SPLIT_THRESHOLD = 0.01;
const NATIVE_WIDTH_SCREEN_SPLIT_THRESHOLD = 0.5;
const NATIVE_FIT_CONTEXT_RADIUS = 5;
const NATIVE_MAX_FIT_SAMPLES = 200;

type SvgPathElement =
  | {
      type: "move";
      point: [number, number];
    }
  | {
      type: "line";
      point: [number, number];
    }
  | {
      type: "cubic";
      control1: [number, number];
      control2: [number, number];
      end: [number, number];
    }
  | {
      type: "close";
    };

class SvgPathBuilder {
  private commands: string[] = [];
  private elements: SvgPathElement[] = [];
  public currentPoint: [number, number] | null = null;

  beginSubpath() {
    this.currentPoint = null;
  }

  moveTo(x: number, y: number) {
    this.commands.push(`M ${formatSvgNumber(x)} ${formatSvgNumber(y)}`);
    this.elements.push({ type: "move", point: [x, y] });
    this.currentPoint = [x, y];
  }

  lineTo(x: number, y: number) {
    this.commands.push(`L ${formatSvgNumber(x)} ${formatSvgNumber(y)}`);
    this.elements.push({ type: "line", point: [x, y] });
    this.currentPoint = [x, y];
  }

  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ) {
    this.commands.push(
      `C ${formatSvgNumber(x1)} ${formatSvgNumber(y1)} ${formatSvgNumber(x2)} ${formatSvgNumber(y2)} ${formatSvgNumber(x3)} ${formatSvgNumber(y3)}`,
    );
    this.elements.push({
      type: "cubic",
      control1: [x1, y1],
      control2: [x2, y2],
      end: [x3, y3],
    });
    this.currentPoint = [x3, y3];
  }

  closePath() {
    this.commands.push("Z");
    this.elements.push({ type: "close" });
    this.currentPoint = null;
  }

  toString(minimumElementLength: number = 0) {
    return serializePathElements(this.toElements(minimumElementLength));
  }

  toElements(minimumElementLength: number = 0) {
    const serializedElements =
      minimumElementLength > 0
        ? filterShortPathElements(this.elements, minimumElementLength)
        : this.elements;
    return [...serializedElements];
  }
}

function formatSvgNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

function serializePathElements(elements: readonly SvgPathElement[]) {
  return elements
    .map((element) => {
      switch (element.type) {
        case "move":
          return `M ${formatSvgNumber(element.point[0])} ${formatSvgNumber(element.point[1])}`;
        case "line":
          return `L ${formatSvgNumber(element.point[0])} ${formatSvgNumber(element.point[1])}`;
        case "cubic":
          return `C ${formatSvgNumber(element.control1[0])} ${formatSvgNumber(element.control1[1])} ${formatSvgNumber(element.control2[0])} ${formatSvgNumber(element.control2[1])} ${formatSvgNumber(element.end[0])} ${formatSvgNumber(element.end[1])}`;
        case "close":
          return "Z";
      }
    })
    .join(" ");
}

function sampleCubicCurve(
  curve: CubicCurve,
  divisions: number,
): [number, number][] {
  const sampledPoints: [number, number][] = [];

  for (let index = 1; index <= divisions; index++) {
    sampledPoints.push(cubicCurvePointAt(curve, index / divisions));
  }

  return sampledPoints;
}

function filterStrokeContourPoints(points: readonly [number, number][]) {
  const filteredPoints: [number, number][] = [];
  let previousX: number | undefined;
  let previousY: number | undefined;

  for (const point of points) {
    if (
      previousX !== undefined &&
      Math.abs(point[0] - previousX) < MIN_STROKE_POINT_DISTANCE &&
      previousY !== undefined &&
      Math.abs(point[1] - previousY) < MIN_STROKE_POINT_DISTANCE
    ) {
      continue;
    }

    filteredPoints.push(point);
    previousX = point[0];
    previousY = point[1];
  }

  return filteredPoints;
}

function samplePathContours(
  elements: readonly SvgPathElement[],
  curvePointDivisionCount: number,
) {
  const contours: [number, number][][] = [];
  let currentContour: [number, number][] = [];
  let currentPoint: [number, number] | null = null;

  const flushContour = () => {
    if (currentContour.length === 0) {
      return;
    }

    const filteredContour = filterStrokeContourPoints(currentContour);
    if (filteredContour.length >= 3) {
      contours.push(filteredContour);
    }
    currentContour = [];
  };

  for (const element of elements) {
    switch (element.type) {
      case "move":
        flushContour();
        currentContour = [element.point];
        currentPoint = element.point;
        break;
      case "line":
        if (!currentPoint) {
          currentContour = [element.point];
        } else {
          currentContour.push(element.point);
        }
        currentPoint = element.point;
        break;
      case "cubic":
        if (currentPoint) {
          currentContour.push(
            ...sampleCubicCurve(
              {
                p0: currentPoint,
                p1: element.control1,
                p2: element.control2,
                p3: element.end,
              },
              curvePointDivisionCount,
            ),
          );
        } else {
          currentContour.push(element.end);
        }
        currentPoint = element.end;
        break;
      case "close":
        flushContour();
        currentPoint = null;
        break;
    }
  }

  flushContour();
  return contours;
}

function svgPathElementEndPoint(element: SvgPathElement): [number, number] | null {
  switch (element.type) {
    case "move":
    case "line":
      return element.point;
    case "cubic":
      return element.end;
    case "close":
      return null;
  }
}

function svgPathElementPolylineLength(
  startPoint: [number, number],
  element: SvgPathElement,
) {
  switch (element.type) {
    case "line":
      return pointDistance(startPoint, element.point);
    case "cubic":
      return (
        pointDistance(startPoint, element.control1) +
        pointDistance(element.control1, element.control2) +
        pointDistance(element.control2, element.end)
      );
    case "move":
    case "close":
      return 0;
  }
}

function filterShortPathElements(
  elements: readonly SvgPathElement[],
  minimumElementLength: number,
) {
  if (minimumElementLength <= 0) {
    return [...elements];
  }

  const filteredElements: SvgPathElement[] = [];
  let index = 0;

  while (index < elements.length) {
    const moveElement = elements[index];
    if (!moveElement || moveElement.type !== "move") {
      index++;
      continue;
    }

    const subpathElements: SvgPathElement[] = [];
    const startPoint = moveElement.point;
    index++;

    while (index < elements.length) {
      const element = elements[index];
      index++;

      if (element.type === "move") {
        index--;
        break;
      }

      subpathElements.push(element);
      if (element.type === "close") {
        break;
      }
    }

    const keptElements: SvgPathElement[] = [];
    let lastKeptPoint = startPoint;

    for (const element of subpathElements) {
      if (element.type === "close") {
        continue;
      }

      if (
        svgPathElementPolylineLength(lastKeptPoint, element) <=
        minimumElementLength
      ) {
        continue;
      }

      keptElements.push(element);
      const endPoint = svgPathElementEndPoint(element);
      if (endPoint) {
        lastKeptPoint = endPoint;
      }
    }

    if (keptElements.length === 0) {
      continue;
    }

    filteredElements.push(moveElement, ...keptElements, { type: "close" });
  }

  return filteredElements;
}

function pointAdd(
  a: [number, number],
  b: [number, number],
): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

function pointSubtract(
  a: [number, number],
  b: [number, number],
): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

function pointScale(
  point: [number, number],
  factor: number,
): [number, number] {
  return [point[0] * factor, point[1] * factor];
}

function pointDot(a: [number, number], b: [number, number]) {
  return a[0] * b[0] + a[1] * b[1];
}

function pointLength(point: [number, number]) {
  return Math.hypot(point[0], point[1]);
}

function pointDistance(a: [number, number], b: [number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointDistanceSquared(a: [number, number], b: [number, number]) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function pointNormalize(point: [number, number]): [number, number] {
  const length = pointLength(point);
  return length > 0 ? [point[0] / length, point[1] / length] : [1, 0];
}

function projectOntoSegment(
  segment: { p0: [number, number]; p1: [number, number] },
  point: [number, number],
): [number, number] {
  const delta = pointSubtract(segment.p1, segment.p0);
  const lengthSquared = pointDot(delta, delta);
  if (lengthSquared <= 1e-12) {
    return segment.p0;
  }
  const t = Math.max(
    0,
    Math.min(1, pointDot(pointSubtract(point, segment.p0), delta) / lengthSquared),
  );
  return pointAdd(segment.p0, pointScale(delta, t));
}

function cubicCurvePointAt(curve: CubicCurve, t: number): [number, number] {
  return cubicPointAt(curve.p0, curve.p1, curve.p2, curve.p3, t);
}

function cubicCurveDerivativeAt(
  curve: CubicCurve,
  t: number,
): [number, number] {
  return cubicDerivativeAt(curve.p0, curve.p1, curve.p2, curve.p3, t);
}

function lerp(a: number, b: number, t: number) {
  return a * (1 - t) + b * t;
}

function pointLerp(
  a: [number, number],
  b: [number, number],
  t: number,
): [number, number] {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
  ];
}

function importedStrokeLocationLessThan(
  a: ImportedStrokeLocation,
  b: ImportedStrokeLocation,
) {
  return a.elementIndex < b.elementIndex ||
    (a.elementIndex === b.elementIndex && a.t < b.t);
}

function importedStrokeLocationEqual(
  a: ImportedStrokeLocation,
  b: ImportedStrokeLocation,
) {
  return a.elementIndex === b.elementIndex && a.t === b.t;
}

function importedStrokeEndingLocation(
  component: ImportedStrokeComponent,
): ImportedStrokeLocation {
  if (component.segments.length === 0) {
    return { elementIndex: 0, t: 0 };
  }
  return {
    elementIndex: component.segments.length - 1,
    t: 1,
  };
}

function importedStrokeStandardizeRange(
  range: ImportedStrokeRange,
): ImportedStrokeRange {
  let start = range.start;
  let end = range.end;
  if (importedStrokeLocationLessThan(end, start)) {
    start = range.end;
    end = range.start;
  }

  if (start.elementIndex < end.elementIndex) {
    if (start.t === 1) {
      const nextStart = {
        elementIndex: start.elementIndex + 1,
        t: 0,
      };
      if (importedStrokeLocationLessThan(nextStart, end)) {
        start = nextStart;
      }
    }
    if (end.t === 0) {
      const previousEnd = {
        elementIndex: end.elementIndex - 1,
        t: 1,
      };
      if (importedStrokeLocationLessThan(start, previousEnd)) {
        end = previousEnd;
      }
    }
  }

  return { start, end };
}

function splitCubicAt(
  segment: ImportedStrokeSegment,
  t: number,
): { left: ImportedStrokeSegment; right: ImportedStrokeSegment } {
  const p01 = pointLerp(segment.p0, segment.p1, t);
  const p12 = pointLerp(segment.p1, segment.p2, t);
  const p23 = pointLerp(segment.p2, segment.p3, t);
  const p012 = pointLerp(p01, p12, t);
  const p123 = pointLerp(p12, p23, t);
  const p0123 = pointLerp(p012, p123, t);

  return {
    left: {
      p0: segment.p0,
      p1: p01,
      p2: p012,
      p3: p0123,
    },
    right: {
      p0: p0123,
      p1: p123,
      p2: p23,
      p3: segment.p3,
    },
  };
}

function createFallbackLiveSample(
  element: ExcalidrawFreeDrawElement,
  index: number,
): LiveNotabilityStrokeSample {
  const force =
    !element.simulatePressure &&
    index < element.pressures.length &&
    isFiniteNumber(element.pressures[index])
      ? element.pressures[index]
      : DEFAULT_LIVE_FORCE;

  return {
    timestamp: index,
    force,
    azimuthX: 1,
    azimuthY: 0,
    altitude: DEFAULT_LIVE_ALTITUDE,
    predicted: false,
    estimatedPropsExpectingUpdates: 0,
    expectedUpdatesTimedOut: false,
  };
}

function buildLiveNotabilityControlPoints(
  element: ExcalidrawFreeDrawElement,
  payload: LiveNotabilityStrokeData,
) {
  const controlPoints: NativeNotabilityControlPoint[] = [];

  for (let index = 0; index < element.points.length; index++) {
    const point = element.points[index];
    const sample = payload.samples[index] ?? createFallbackLiveSample(element, index);
    const controlPoint: NativeNotabilityControlPoint = {
      location: [point[0], point[1]],
      timestamp: isFiniteNumber(sample.timestamp) ? sample.timestamp : index,
      force: isFiniteNumber(sample.force) ? sample.force : DEFAULT_LIVE_FORCE,
      azimuthX: isFiniteNumber(sample.azimuthX) ? sample.azimuthX : 1,
      azimuthY: isFiniteNumber(sample.azimuthY) ? sample.azimuthY : 0,
      altitude: isFiniteNumber(sample.altitude)
        ? sample.altitude
        : DEFAULT_LIVE_ALTITUDE,
      predicted: sample.predicted === true,
      estimatedPropsExpectingUpdates: isFiniteNumber(
        sample.estimatedPropsExpectingUpdates,
      )
        ? sample.estimatedPropsExpectingUpdates
        : 0,
      expectedUpdatesTimedOut: sample.expectedUpdatesTimedOut === true,
    };

    const previousPoint = controlPoints[controlPoints.length - 1];
    if (
      previousPoint &&
      previousPoint.location[0] === controlPoint.location[0] &&
      previousPoint.location[1] === controlPoint.location[1]
    ) {
      controlPoints[controlPoints.length - 1] = controlPoint;
      continue;
    }

    controlPoints.push(controlPoint);
  }

  return controlPoints;
}

function solveNative2x2(
  m00: number,
  m01: number,
  m11: number,
  b0: number,
  b1: number,
): [number, number] | null {
  const determinant = m00 * m11 - m01 * m01;
  if (Math.abs(determinant) <= NATIVE_FIT_EPSILON) {
    return null;
  }

  return [
    (b0 * m11 - b1 * m01) / determinant,
    (m00 * b1 - m01 * b0) / determinant,
  ];
}

function chordFallbackCurve(
  p0: [number, number],
  p3: [number, number],
): CubicCurve {
  return {
    p0,
    p1: pointLerp(p0, p3, 1 / 3),
    p2: pointLerp(p0, p3, 2 / 3),
    p3,
  };
}

function fitNativeCubicLeastSquares(
  samples: readonly [number, number][],
  uValues: readonly number[],
  p0: [number, number],
  p3: [number, number],
): CubicCurve {
  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  let bx0 = 0;
  let bx1 = 0;
  let by0 = 0;
  let by1 = 0;

  for (let index = 0; index < samples.length; index++) {
    const point = samples[index];
    const u = uValues[index];
    const oneMinusU = 1 - u;
    const b0 = oneMinusU * oneMinusU * oneMinusU;
    const b1 = 3 * oneMinusU * oneMinusU * u;
    const b2 = 3 * oneMinusU * u * u;
    const b3 = u * u * u;
    const targetX = point[0] - (p0[0] * b0 + p3[0] * b3);
    const targetY = point[1] - (p0[1] * b0 + p3[1] * b3);

    m00 += b1 * b1;
    m01 += b1 * b2;
    m11 += b2 * b2;
    bx0 += b1 * targetX;
    bx1 += b2 * targetX;
    by0 += b1 * targetY;
    by1 += b2 * targetY;
  }

  const solvedX = solveNative2x2(m00, m01, m11, bx0, bx1);
  const solvedY = solveNative2x2(m00, m01, m11, by0, by1);
  if (!solvedX || !solvedY) {
    return chordFallbackCurve(p0, p3);
  }

  return {
    p0,
    p1: [solvedX[0], solvedY[0]],
    p2: [solvedX[1], solvedY[1]],
    p3,
  };
}

function nativeDistancePointToCubic(
  point: [number, number],
  curve: CubicCurve,
  coarseSteps: number = 32,
  refineSteps: number = 8,
) {
  let bestU = 0;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;

  for (let step = 0; step <= coarseSteps; step++) {
    const u = step / coarseSteps;
    const candidate = cubicCurvePointAt(curve, u);
    const distanceSquared = pointDistanceSquared(point, candidate);
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestU = u;
    }
  }

  const coarseSpan = 1 / coarseSteps;
  let low = Math.max(0, bestU - coarseSpan);
  let high = Math.min(1, bestU + coarseSpan);

  for (let step = 0; step < refineSteps; step++) {
    const u1 = low + (high - low) / 3;
    const u2 = high - (high - low) / 3;
    const distance1 = pointDistanceSquared(point, cubicCurvePointAt(curve, u1));
    const distance2 = pointDistanceSquared(point, cubicCurvePointAt(curve, u2));

    if (distance1 < distance2) {
      high = u2;
      bestDistanceSquared = Math.min(bestDistanceSquared, distance1);
    } else {
      low = u1;
      bestDistanceSquared = Math.min(bestDistanceSquared, distance2);
    }
  }

  return Math.sqrt(bestDistanceSquared);
}

function computeNativeErrorThreshold(baseWidth: number, zoom: number) {
  const safeZoom = zoom > 0 ? zoom : 1;
  const effective = clamp(
    baseWidth * safeZoom,
    NATIVE_MIN_EFFECTIVE_SIZE,
    NATIVE_MAX_EFFECTIVE_SIZE,
  );
  const normalized =
    (effective - NATIVE_MIN_EFFECTIVE_SIZE) / NATIVE_EFFECTIVE_SIZE_RANGE;

  return (0.5 / (1 + 1.5 * normalized)) / safeZoom;
}

function fitNativeCandidate(
  controlPoints: readonly NativeNotabilityControlPoint[],
  t0: number,
  t1: number,
): { item: NativeCurveItem; error: number } {
  const last = controlPoints.length - 1;
  const windowStart = Math.max(0, t0 - NATIVE_FIT_CONTEXT_RADIUS);
  const windowEnd = Math.min(last, t1 + NATIVE_FIT_CONTEXT_RADIUS);
  const denominator = Math.max(1, t1 - t0);
  const samples = controlPoints
    .slice(windowStart, windowEnd + 1)
    .map((point) => point.location);
  const uValues = Array.from(
    { length: windowEnd - windowStart + 1 },
    (_, offset) => (windowStart + offset - t0) / denominator,
  );
  const curve = fitNativeCubicLeastSquares(
    samples,
    uValues,
    controlPoints[t0].location,
    controlPoints[t1].location,
  );

  let maxError = 0;
  for (let index = t0; index <= t1; index++) {
    maxError = Math.max(
      maxError,
      nativeDistancePointToCubic(controlPoints[index].location, curve),
    );
  }

  return {
    item: {
      curve,
      windowStart,
      windowEnd,
      t0,
      t1,
    },
    error: maxError,
  };
}

function fitNativeLongestSegment(
  controlPoints: readonly NativeNotabilityControlPoint[],
  t0: number,
  errorThreshold: number,
) {
  const last = controlPoints.length - 1;

  if (last - t0 + 1 <= NATIVE_MAX_FIT_SAMPLES) {
    const candidate = fitNativeCandidate(controlPoints, t0, last);
    if (candidate.error <= errorThreshold) {
      return candidate.item;
    }
  }

  let low = t0 + 1;
  let high = last;
  let bestItem: NativeCurveItem | null = null;

  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (mid - t0 + 1 > NATIVE_MAX_FIT_SAMPLES) {
      high = mid;
      continue;
    }

    const candidate = fitNativeCandidate(controlPoints, t0, mid);
    if (candidate.error <= errorThreshold) {
      bestItem = candidate.item;
      low = mid;
    } else {
      high = mid;
    }
  }

  for (const candidateT1 of [high, low].sort((a, b) => b - a)) {
    if (candidateT1 - t0 + 1 > NATIVE_MAX_FIT_SAMPLES) {
      continue;
    }
    const candidate = fitNativeCandidate(controlPoints, t0, candidateT1);
    if (candidate.error <= errorThreshold) {
      return candidate.item;
    }
  }

  if (bestItem) {
    return bestItem;
  }

  return fitNativeCandidate(controlPoints, t0, Math.min(t0 + 1, last)).item;
}

function alignNativeCurveStartTangent(
  curve: CubicCurve,
  direction: [number, number],
): CubicCurve {
  const normalizedDirection = pointNormalize(direction);
  const originalHandle = pointSubtract(curve.p1, curve.p0);
  let amount = pointDot(originalHandle, normalizedDirection);

  if (amount <= NATIVE_FIT_EPSILON) {
    amount = Math.max(
      pointLength(originalHandle),
      pointDistance(curve.p3, curve.p0) / 3,
    );
  }

  return {
    ...curve,
    p1: pointAdd(curve.p0, pointScale(normalizedDirection, amount)),
  };
}

function applyNativeContinuity(
  curveItems: NativeCurveItem[],
  initialDirection: [number, number] | null,
) {
  if (curveItems.length === 0) {
    return;
  }

  if (initialDirection && pointDistanceSquared(initialDirection, [0, 0]) > 0) {
    curveItems[0].curve = alignNativeCurveStartTangent(
      curveItems[0].curve,
      initialDirection,
    );
  }

  for (let index = 1; index < curveItems.length; index++) {
    const previousTangent = cubicCurveDerivativeAt(
      curveItems[index - 1].curve,
      1,
    );

    if (pointDistanceSquared(previousTangent, [0, 0]) <= NATIVE_FIT_EPSILON) {
      continue;
    }

    curveItems[index].curve = alignNativeCurveStartTangent(
      curveItems[index].curve,
      previousTangent,
    );
  }
}

function isSettledNativePoint(point: NativeNotabilityControlPoint) {
  if (point.predicted) {
    return false;
  }
  if (point.estimatedPropsExpectingUpdates === 0) {
    return true;
  }
  return point.expectedUpdatesTimedOut;
}

function computeNativeFrozenPrefix(
  controlPoints: readonly NativeNotabilityControlPoint[],
  curveItems: readonly NativeCurveItem[],
) {
  let numFrozen = 0;

  for (const item of curveItems) {
    const influencedPoints = controlPoints.slice(
      item.windowStart,
      item.windowEnd + 1,
    );
    if (influencedPoints.every(isSettledNativePoint)) {
      numFrozen += 1;
      continue;
    }
    break;
  }

  return numFrozen;
}

function buildNativeCurves(
  controlPoints: readonly NativeNotabilityControlPoint[],
  errorThreshold: number,
) {
  if (controlPoints.length < 2) {
    return [];
  }

  const curveItems: NativeCurveItem[] = [];
  let t0 = 0;

  while (t0 < controlPoints.length - 1) {
    const item = fitNativeLongestSegment(controlPoints, t0, errorThreshold);
    curveItems.push(item);
    if (item.t1 <= t0) {
      break;
    }
    t0 = item.t1;
  }

  applyNativeContinuity(curveItems, null);
  computeNativeFrozenPrefix(controlPoints, curveItems);

  return curveItems;
}

function usesVariableWidthForPenVariant(variant: PenVariant) {
  return variant === "pen" || variant === "pencil";
}

function nativeWidthScaleFromForce(force: number) {
  return 1 + NATIVE_FORCE_TO_WIDTH_SCALE * (force - NATIVE_FORCE_BASELINE);
}

function nativeAttributeFromPoint(
  point: NativeNotabilityControlPoint,
  penVariant: PenVariant,
): NativePathAttribute {
  return {
    widthScale: usesVariableWidthForPenVariant(penVariant)
      ? nativeWidthScaleFromForce(point.force)
      : 1,
    force: point.force,
    altitude: point.altitude,
    azimuthX: point.azimuthX,
    azimuthY: point.azimuthY,
  };
}

function lerpNativeAttribute(
  a: NativePathAttribute,
  b: NativePathAttribute,
  t: number,
): NativePathAttribute {
  return {
    widthScale: lerp(a.widthScale, b.widthScale, t),
    force: lerp(a.force, b.force, t),
    altitude: lerp(a.altitude, b.altitude, t),
    azimuthX: lerp(a.azimuthX, b.azimuthX, t),
    azimuthY: lerp(a.azimuthY, b.azimuthY, t),
  };
}

function needsNativeAttributeSplit(
  predicted: NativePathAttribute,
  actual: NativePathAttribute,
  baseWidth: number,
  zoom: number,
) {
  if (Math.abs(actual.force - predicted.force) > NATIVE_FORCE_SPLIT_THRESHOLD) {
    return true;
  }
  if (
    Math.abs(actual.altitude - predicted.altitude) >
    NATIVE_ALTITUDE_SPLIT_THRESHOLD
  ) {
    return true;
  }
  if (
    Math.abs(actual.azimuthX - predicted.azimuthX) >
      NATIVE_AZIMUTH_SPLIT_THRESHOLD ||
    Math.abs(actual.azimuthY - predicted.azimuthY) >
      NATIVE_AZIMUTH_SPLIT_THRESHOLD
  ) {
    return true;
  }

  return (
    Math.abs(actual.widthScale - predicted.widthScale) * baseWidth * zoom >
    NATIVE_WIDTH_SCREEN_SPLIT_THRESHOLD
  );
}

function buildNativeAttributedCurves(
  curveItems: readonly NativeCurveItem[],
  controlPoints: readonly NativeNotabilityControlPoint[],
  baseWidth: number,
  zoom: number,
  penVariant: PenVariant,
) {
  const pointAttributes = controlPoints.map((point) =>
    nativeAttributeFromPoint(point, penVariant),
  );
  const attributedCurves: NativeAttributedCurve[] = [];

  for (const item of curveItems) {
    if (item.t1 <= item.t0) {
      continue;
    }

    let remainderCurve = item.curve;
    let remainderStartIndex = item.t0;
    const remainderEndIndex = item.t1;

    while (remainderStartIndex < remainderEndIndex) {
      const startAttribute = pointAttributes[remainderStartIndex];
      const endAttribute = pointAttributes[remainderEndIndex];
      let splitIndex: number | null = null;

      for (
        let index = remainderStartIndex + 1;
        index < remainderEndIndex;
        index++
      ) {
        const t =
          (index - remainderStartIndex) /
          (remainderEndIndex - remainderStartIndex);
        const predicted = lerpNativeAttribute(
          startAttribute,
          endAttribute,
          t,
        );
        const actual = pointAttributes[index];

        if (needsNativeAttributeSplit(predicted, actual, baseWidth, zoom)) {
          splitIndex = index;
          break;
        }
      }

      if (splitIndex === null) {
        attributedCurves.push({
          curve: remainderCurve,
          startIndex: remainderStartIndex,
          endIndex: remainderEndIndex,
          startAttribute,
          endAttribute,
        });
        break;
      }

      const splitT =
        (splitIndex - remainderStartIndex) /
        (remainderEndIndex - remainderStartIndex);
      const splitCurves = splitCubicAt(remainderCurve, splitT);

      attributedCurves.push({
        curve: splitCurves.left,
        startIndex: remainderStartIndex,
        endIndex: splitIndex,
        startAttribute,
        endAttribute: pointAttributes[splitIndex],
      });

      remainderCurve = splitCurves.right;
      remainderStartIndex = splitIndex;
    }
  }

  return attributedCurves;
}

function buildLiveNotabilityStrokeComponent(
  element: ExcalidrawFreeDrawElement,
  payload: LiveNotabilityStrokeData,
): {
  component: ImportedStrokeComponent;
  baseWidth: number;
  firstPoint: [number, number];
} | null {
  const controlPoints = buildLiveNotabilityControlPoints(element, payload);
  if (controlPoints.length === 0) {
    return null;
  }

  const baseWidth = Math.max(0.01, element.strokeWidth * 4.25);
  const zoom =
    isFiniteNumber(payload.zoomAtCreation) && payload.zoomAtCreation > 0
      ? payload.zoomAtCreation
      : 1;
  const firstPoint = controlPoints[0].location;
  const initialRadius = Math.max(
    0.25,
    baseWidth *
      nativeAttributeFromPoint(controlPoints[0], element.penVariant).widthScale *
      0.5,
  );

  if (controlPoints.length === 1) {
    return {
      component: {
        segments: [],
        radii: [initialRadius],
      },
      baseWidth,
      firstPoint,
    };
  }

  const curveItems = buildNativeCurves(
    controlPoints,
    computeNativeErrorThreshold(baseWidth, zoom),
  );
  const attributedCurves = buildNativeAttributedCurves(
    curveItems,
    controlPoints,
    baseWidth,
    zoom,
    element.penVariant,
  );

  if (attributedCurves.length === 0) {
    return {
      component: {
        segments: [],
        radii: [initialRadius],
      },
      baseWidth,
      firstPoint,
    };
  }

  const segments: ImportedStrokeSegment[] = [];
  const radii: number[] = [];

  for (const attributedCurve of attributedCurves) {
    if (segments.length === 0) {
      radii.push(
        Math.max(
          0.25,
          baseWidth * attributedCurve.startAttribute.widthScale * 0.5,
        ),
      );
    }

    segments.push(attributedCurve.curve);
    radii.push(
      Math.max(0.25, baseWidth * attributedCurve.endAttribute.widthScale * 0.5),
    );
  }

  return {
    component: {
      segments,
      radii,
    },
    baseWidth,
    firstPoint,
  };
}

function extractCubicRange(
  segment: ImportedStrokeSegment,
  startT: number,
  endT: number,
): ImportedStrokeSegment {
  if (startT <= 0 && endT >= 1) {
    return segment;
  }

  if (startT <= 0) {
    return splitCubicAt(segment, endT).left;
  }

  if (endT >= 1) {
    return splitCubicAt(segment, startT).right;
  }

  const left = splitCubicAt(segment, endT).left;
  return splitCubicAt(left, startT / endT).right;
}

function importedStrokeVertexPoint(
  component: ImportedStrokeComponent,
  vertexIndex: number,
): [number, number] {
  if (component.segments.length === 0) {
    return [0, 0];
  }
  if (vertexIndex <= 0) {
    return component.segments[0].p0;
  }
  if (vertexIndex >= component.segments.length) {
    return component.segments[component.segments.length - 1].p3;
  }
  return component.segments[vertexIndex].p0;
}

function splitImportedStrokeComponent(
  component: ImportedStrokeComponent,
  range: ImportedStrokeRange,
): ImportedStrokeComponent | null {
  if (component.segments.length === 0) {
    return null;
  }

  const standardizedRange = importedStrokeStandardizeRange(range);
  const { start, end } = standardizedRange;

  if (importedStrokeLocationEqual(start, end)) {
    return null;
  }

  const startRadius = importedStrokeMixedRadius(component, start);
  const endRadius = importedStrokeMixedRadius(component, end);
  const segments: ImportedStrokeSegment[] = [];
  const radii: number[] = [startRadius];

  if (start.elementIndex === end.elementIndex) {
    segments.push(
      extractCubicRange(
        component.segments[start.elementIndex],
        start.t,
        end.t,
      ),
    );
    radii.push(endRadius);
    return {
      segments,
      radii,
    };
  }

  segments.push(
    extractCubicRange(
      component.segments[start.elementIndex],
      start.t,
      1,
    ),
  );
  radii.push(component.radii[start.elementIndex + 1]);

  for (let index = start.elementIndex + 1; index < end.elementIndex; index++) {
    segments.push(component.segments[index]);
    radii.push(component.radii[index + 1]);
  }

  segments.push(
    extractCubicRange(
      component.segments[end.elementIndex],
      0,
      end.t,
    ),
  );
  radii.push(endRadius);

  return {
    segments,
    radii,
  };
}

const POLYNOMIAL_EPSILON = 1e-7;

function evaluatePolynomial(coefficients: readonly number[], value: number) {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index--) {
    result = result * value + coefficients[index];
  }
  return result;
}

function sortAndUniqueNumbers(values: readonly number[], epsilon = 1e-6) {
  const sortedValues = [...values].sort((a, b) => a - b);
  const uniqueValues: number[] = [];

  for (const value of sortedValues) {
    if (
      uniqueValues.length === 0 ||
      Math.abs(value - uniqueValues[uniqueValues.length - 1]) > epsilon
    ) {
      uniqueValues.push(value);
    }
  }

  return uniqueValues;
}

function solveQuadraticRealRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) <= POLYNOMIAL_EPSILON) {
    if (Math.abs(b) <= POLYNOMIAL_EPSILON) {
      return [];
    }
    return [-c / b];
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < -POLYNOMIAL_EPSILON) {
    return [];
  }

  if (Math.abs(discriminant) <= POLYNOMIAL_EPSILON) {
    return [-b / (2 * a)];
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  return [
    (-b - sqrtDiscriminant) / (2 * a),
    (-b + sqrtDiscriminant) / (2 * a),
  ];
}

function realCubeRoot(value: number) {
  return value < 0 ? -Math.pow(-value, 1 / 3) : Math.pow(value, 1 / 3);
}

function solveCubicRealRoots(
  a: number,
  b: number,
  c: number,
  d: number,
): number[] {
  if (Math.abs(a) <= POLYNOMIAL_EPSILON) {
    return solveQuadraticRealRoots(b, c, d);
  }

  const normalizedB = b / a;
  const normalizedC = c / a;
  const normalizedD = d / a;

  const depressedP = normalizedC - (normalizedB * normalizedB) / 3;
  const depressedQ =
    (2 * normalizedB * normalizedB * normalizedB) / 27 -
    (normalizedB * normalizedC) / 3 +
    normalizedD;
  const discriminant =
    (depressedQ * depressedQ) / 4 + (depressedP * depressedP * depressedP) / 27;
  const offset = -normalizedB / 3;

  if (discriminant > POLYNOMIAL_EPSILON) {
    const sqrtDiscriminant = Math.sqrt(discriminant);
    return [
      realCubeRoot(-depressedQ / 2 + sqrtDiscriminant) +
        realCubeRoot(-depressedQ / 2 - sqrtDiscriminant) +
        offset,
    ];
  }

  if (Math.abs(discriminant) <= POLYNOMIAL_EPSILON) {
    const root = realCubeRoot(-depressedQ / 2);
    return sortAndUniqueNumbers([
      2 * root + offset,
      -root + offset,
    ]);
  }

  const radius = 2 * Math.sqrt(-depressedP / 3);
  const angle = Math.acos(
    clamp(
      -depressedQ /
        (2 * Math.sqrt(-(depressedP * depressedP * depressedP) / 27)),
      -1,
      1,
    ),
  );

  return sortAndUniqueNumbers([
    radius * Math.cos(angle / 3) + offset,
    radius * Math.cos((angle + 2 * Math.PI) / 3) + offset,
    radius * Math.cos((angle + 4 * Math.PI) / 3) + offset,
  ]);
}

function bisectRoot(
  coefficients: readonly number[],
  start: number,
  end: number,
) {
  let left = start;
  let right = end;
  let leftValue = evaluatePolynomial(coefficients, left);

  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (left + right) / 2;
    const middleValue = evaluatePolynomial(coefficients, middle);

    if (Math.abs(middleValue) <= POLYNOMIAL_EPSILON) {
      return middle;
    }

    if (leftValue * middleValue <= 0) {
      right = middle;
    } else {
      left = middle;
      leftValue = middleValue;
    }
  }

  return (left + right) / 2;
}

function findRealRootsInUnitIntervalForQuartic(
  coefficients: readonly [number, number, number, number, number],
) {
  const derivativeRoots = solveCubicRealRoots(
    4 * coefficients[4],
    3 * coefficients[3],
    2 * coefficients[2],
    coefficients[1],
  )
    .filter((root) => root > POLYNOMIAL_EPSILON && root < 1 - POLYNOMIAL_EPSILON);

  const points = sortAndUniqueNumbers([0, ...derivativeRoots, 1]);
  const roots: number[] = [];

  for (const point of points) {
    if (Math.abs(evaluatePolynomial(coefficients, point)) <= POLYNOMIAL_EPSILON) {
      roots.push(clamp(point, 0, 1));
    }
  }

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (end - start <= POLYNOMIAL_EPSILON) {
      continue;
    }

    const startValue = evaluatePolynomial(coefficients, start);
    const endValue = evaluatePolynomial(coefficients, end);
    if (startValue * endValue < 0) {
      roots.push(bisectRoot(coefficients, start, end));
    }
  }

  return sortAndUniqueNumbers(
    roots
      .filter((root) => root >= -POLYNOMIAL_EPSILON && root <= 1 + POLYNOMIAL_EPSILON)
      .map((root) => clamp(root, 0, 1)),
  );
}

function importedStrokeDegenerateRangesForSegment(
  segment: ImportedStrokeSegment,
  radius0: number,
  radius1: number,
): { start: number; end: number }[] {
  const q2x =
    3 * (-segment.p0[0] + 3 * segment.p1[0] - 3 * segment.p2[0] + segment.p3[0]);
  const q1x =
    6 * (segment.p0[0] - 2 * segment.p1[0] + segment.p2[0]);
  const q0x = 3 * (segment.p1[0] - segment.p0[0]);
  const q2y =
    3 * (-segment.p0[1] + 3 * segment.p1[1] - 3 * segment.p2[1] + segment.p3[1]);
  const q1y =
    6 * (segment.p0[1] - 2 * segment.p1[1] + segment.p2[1]);
  const q0y = 3 * (segment.p1[1] - segment.p0[1]);

  const coefficients: [number, number, number, number, number] = [
    q0x * q0x + q0y * q0y - (radius1 - radius0) * (radius1 - radius0) - 1e-4,
    2 * (q0x * q1x + q0y * q1y),
    q1x * q1x + 2 * q0x * q2x + q1y * q1y + 2 * q0y * q2y,
    2 * (q1x * q2x + q1y * q2y),
    q2x * q2x + q2y * q2y,
  ];

  const roots = findRealRootsInUnitIntervalForQuartic(coefficients);
  const points = sortAndUniqueNumbers([0, ...roots, 1]);
  const ranges: { start: number; end: number }[] = [];

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index];
    const end = points[index + 1];
    if (end - start <= POLYNOMIAL_EPSILON) {
      continue;
    }

    const midpoint = (start + end) / 2;
    if (evaluatePolynomial(coefficients, midpoint) <= 0) {
      ranges.push({
        start: Math.max(0, start - 0.01),
        end: Math.min(1, end + 0.01),
      });
    }
  }

  return ranges;
}

function mergeImportedStrokeRanges(ranges: ImportedStrokeRange[]) {
  if (ranges.length === 0) {
    return [];
  }

  const mergedRanges = [ranges[0]];
  for (let index = 1; index < ranges.length; index++) {
    const nextRange = ranges[index];
    const previousRange = mergedRanges[mergedRanges.length - 1];
    if (
      nextRange.start.t <= 0 &&
      previousRange.end.t >= 1 &&
      nextRange.start.elementIndex === previousRange.end.elementIndex + 1
    ) {
      previousRange.end = nextRange.end;
    } else {
      mergedRanges.push(nextRange);
    }
  }

  return mergedRanges;
}

function importedStrokeCollectDegenerateRanges(
  component: ImportedStrokeComponent,
) {
  const ranges: ImportedStrokeRange[] = [];

  component.segments.forEach((segment, index) => {
    const localRanges = importedStrokeDegenerateRangesForSegment(
      segment,
      component.radii[index],
      component.radii[index + 1],
    );

    for (const localRange of localRanges) {
      ranges.push({
        start: { elementIndex: index, t: localRange.start },
        end: { elementIndex: index, t: localRange.end },
      });
    }
  });

  return mergeImportedStrokeRanges(ranges);
}

function importedStrokeComplementRanges(
  component: ImportedStrokeComponent,
  degenerateRanges: ImportedStrokeRange[],
) {
  if (component.segments.length === 0) {
    return [];
  }

  if (degenerateRanges.length === 0) {
    return [{
      start: { elementIndex: 0, t: 0 },
      end: importedStrokeEndingLocation(component),
    }];
  }

  const complementRanges: ImportedStrokeRange[] = [];
  let currentStart: ImportedStrokeLocation = { elementIndex: 0, t: 0 };
  const endingLocation = importedStrokeEndingLocation(component);

  for (const degenerateRange of degenerateRanges) {
    if (importedStrokeLocationLessThan(currentStart, degenerateRange.start)) {
      complementRanges.push({
        start: currentStart,
        end: degenerateRange.start,
      });
    }
    currentStart = degenerateRange.end;
  }

  if (importedStrokeLocationLessThan(currentStart, endingLocation)) {
    complementRanges.push({
      start: currentStart,
      end: endingLocation,
    });
  }

  return complementRanges;
}

function buildImportedStrokeComponent(
  element: ExcalidrawFreeDrawElement,
  payload: ImportedNotabilityStrokeData,
): {
  component: ImportedStrokeComponent;
  baseWidth: number;
  firstPoint: [number, number];
} | null {
  const scaleFactor =
    typeof payload.scaleFactor === "number" && Number.isFinite(payload.scaleFactor)
      ? payload.scaleFactor
      : 1;
  const controlPoints: [number, number][] = [];

  for (let i = 0; i + 1 < payload.rawControlPoints.length; i += 2) {
    controlPoints.push([
      payload.rawControlPoints[i] * scaleFactor - element.x,
      payload.rawControlPoints[i + 1] * scaleFactor - element.y,
    ]);
  }

  if (controlPoints.length === 0) {
    return null;
  }

  const segmentCount = Math.floor((controlPoints.length - 1) / 3);
  const attributeCount = segmentCount + 1;
  const baseWidth = Math.max(
    0.01,
    Math.abs(payload.rawCurveWidth || payload.defaultStrokeWidth || 1) *
      (payload.strokeWidthScale || 1) *
      importedBaseWidthCalibration(payload),
  );
  const widthFactors =
    payload.rawFractionalWidths.length >= attributeCount
      ? payload.rawFractionalWidths
          .slice(0, attributeCount)
          .map((width) => importedWidthFactor(payload, width))
      : payload.rawForces.length >= attributeCount
        ? payload.rawForces
            .slice(0, attributeCount)
            .map((force) => importedWidthFactor(payload, force))
        : new Array(attributeCount).fill(1);
  const radii = widthFactors.map((widthFactor) =>
    Math.max(0.25, widthFactor * baseWidth * 0.5),
  );

  const segments: ImportedStrokeSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    segments.push({
      p0: controlPoints[i * 3],
      p1: controlPoints[i * 3 + 1],
      p2: controlPoints[i * 3 + 2],
      p3: controlPoints[i * 3 + 3],
    });
  }

  return {
    component: {
      segments,
      radii,
    },
    baseWidth,
    firstPoint: controlPoints[0],
  };
}

function importedStrokeConfiguration(
  baseWidth: number,
): ImportedStrokeIteratorConfiguration {
  return {
    minimumElementLength: 0.01,
    minimumSubdivisionStepSize: 0.01,
    maximumAllowedCurveError: Math.min(0.05 * baseWidth, 0.25),
    maximumCurveApproximateAsLineDistance: 0.05,
    minimumInternalArcLength: 0.1 * baseWidth,
  };
}

function importedStrokePointAt(
  component: ImportedStrokeComponent,
  location: ImportedStrokeLocation,
) {
  return cubicCurvePointAt(component.segments[location.elementIndex], location.t);
}

function importedStrokeDerivativeAt(
  component: ImportedStrokeComponent,
  location: ImportedStrokeLocation,
) {
  let derivative = cubicCurveDerivativeAt(
    component.segments[location.elementIndex],
    location.t,
  );
  if (pointLength(derivative) < 1e-6) {
    const segment = component.segments[location.elementIndex];
    derivative = pointSubtract(segment.p3, segment.p0);
  }
  return derivative;
}

function importedStrokeMixedRadius(
  component: ImportedStrokeComponent,
  location: ImportedStrokeLocation,
) {
  if (location.elementIndex <= 0 && location.t <= 0) {
    return component.radii[0];
  }
  if (
    location.elementIndex >= component.segments.length - 1 &&
    location.t >= 1
  ) {
    return component.radii[component.radii.length - 1];
  }
  return lerp(
    component.radii[location.elementIndex],
    component.radii[location.elementIndex + 1],
    location.t,
  );
}

function createImportedStrokeIterator(
  component: ImportedStrokeComponent,
  configuration: ImportedStrokeIteratorConfiguration,
): ImportedStrokeIterator {
  const elementCache = component.segments.map((_, index) => {
    const widthDelta = component.radii[index + 1] - component.radii[index];
    const startDerivative = importedStrokeDerivativeAt(component, {
      elementIndex: index,
      t: 0,
    });
    const endDerivative = importedStrokeDerivativeAt(component, {
      elementIndex: index,
      t: 1,
    });
    return {
      startPhi: phi(startDerivative, widthDelta),
      endPhi: phi(endDerivative, widthDelta),
      startAngle: angleFromDifference(startDerivative),
      endAngle: angleFromDifference(endDerivative),
    };
  });

  return {
    configuration,
    reversed: false,
    component,
    numberOfElements: component.segments.length,
    currentLocation: { elementIndex: 0, t: 0 },
    elementCache,
  };
}

function importedStrokeTransformLocation(
  iterator: ImportedStrokeIterator,
  location: ImportedStrokeLocation,
): ImportedStrokeLocation {
  return {
    elementIndex: iterator.reversed
      ? iterator.numberOfElements - location.elementIndex - 1
      : location.elementIndex,
    t: iterator.reversed ? 1 - location.t : location.t,
  };
}

function importedStrokeCurrentPoint(iterator: ImportedStrokeIterator) {
  return importedStrokePointAt(
    iterator.component,
    importedStrokeTransformLocation(iterator, iterator.currentLocation),
  );
}

function importedStrokeCurrentRadius(iterator: ImportedStrokeIterator) {
  return importedStrokeMixedRadius(
    iterator.component,
    importedStrokeTransformLocation(iterator, iterator.currentLocation),
  );
}

function importedStrokeRadiusAt(
  iterator: ImportedStrokeIterator,
  location: ImportedStrokeLocation,
) {
  return importedStrokeMixedRadius(
    iterator.component,
    importedStrokeTransformLocation(iterator, location),
  );
}

function importedStrokeDerivative(
  iterator: ImportedStrokeIterator,
  location: ImportedStrokeLocation,
) {
  const derivative = importedStrokeDerivativeAt(
    iterator.component,
    importedStrokeTransformLocation(iterator, location),
  );
  return iterator.reversed ? pointScale(derivative, -1) : derivative;
}

function importedStrokeCurrentPhi(iterator: ImportedStrokeIterator) {
  const cache = iterator.elementCache[
    iterator.reversed
      ? iterator.numberOfElements - iterator.currentLocation.elementIndex - 1
      : iterator.currentLocation.elementIndex
  ];
  return iterator.reversed ? -cache.endPhi : cache.startPhi;
}

function importedStrokePreviousPhi(iterator: ImportedStrokeIterator) {
  const index =
    iterator.reversed
      ? iterator.numberOfElements - iterator.currentLocation.elementIndex
      : iterator.currentLocation.elementIndex - 1;
  const cache = iterator.elementCache[index];
  return iterator.reversed ? -cache.startPhi : cache.endPhi;
}

function importedStrokeCurrentBaseAngle(iterator: ImportedStrokeIterator) {
  const cache = iterator.elementCache[
    iterator.reversed
      ? iterator.numberOfElements - iterator.currentLocation.elementIndex - 1
      : iterator.currentLocation.elementIndex
  ];
  return iterator.reversed ? cache.endAngle + Math.PI : cache.startAngle;
}

function importedStrokePreviousBaseAngle(iterator: ImportedStrokeIterator) {
  const index =
    iterator.reversed
      ? iterator.numberOfElements - iterator.currentLocation.elementIndex
      : iterator.currentLocation.elementIndex - 1;
  const cache = iterator.elementCache[index];
  return iterator.reversed ? cache.startAngle + Math.PI : cache.endAngle;
}

function importedStrokeReachedEnd(iterator: ImportedStrokeIterator) {
  return (
    iterator.currentLocation.elementIndex >= iterator.numberOfElements ||
    (iterator.currentLocation.elementIndex === iterator.numberOfElements - 1 &&
      iterator.currentLocation.t >= 1)
  );
}

function importedStrokeResetLocation(iterator: ImportedStrokeIterator) {
  iterator.currentLocation = { elementIndex: 0, t: 0 };
}

function importedStrokeAdvanceToNextElement(iterator: ImportedStrokeIterator) {
  iterator.currentLocation = {
    elementIndex: iterator.currentLocation.elementIndex + 1,
    t: 0,
  };
}

function importedStrokeAdvanceT(
  iterator: ImportedStrokeIterator,
  t: number,
) {
  iterator.currentLocation = {
    elementIndex: iterator.currentLocation.elementIndex,
    t,
  };
}

function importedStrokeOffsetPointAt(
  iterator: ImportedStrokeIterator,
  location: ImportedStrokeLocation,
) {
  const transformedLocation = importedStrokeTransformLocation(iterator, location);
  const centerPoint = importedStrokePointAt(iterator.component, transformedLocation);
  let widthDelta =
    iterator.component.radii[transformedLocation.elementIndex + 1] -
    iterator.component.radii[transformedLocation.elementIndex];
  if (iterator.reversed) {
    widthDelta = -widthDelta;
  }
  const offsetAngle = angleDelta(
    importedStrokeDerivative(iterator, location),
    widthDelta,
  );
  return pointAdd(
    centerPoint,
    polarCoordinate(
      offsetAngle,
      importedStrokeMixedRadius(iterator.component, transformedLocation),
    ),
  );
}

function importedStrokePreviousLocation(iterator: ImportedStrokeIterator) {
  return {
    elementIndex: iterator.currentLocation.elementIndex - 1,
    t: 1,
  } satisfies ImportedStrokeLocation;
}

function importedStrokeTurnAngle(
  previousDerivative: [number, number],
  currentDerivative: [number, number],
) {
  const normalizedPrevious = pointNormalize(previousDerivative);
  const perpendicular: [number, number] = [
    -normalizedPrevious[1],
    normalizedPrevious[0],
  ];
  let angle = Math.atan2(
    pointDot(currentDerivative, perpendicular),
    pointDot(currentDerivative, normalizedPrevious),
  );
  if (angle === -Math.PI) {
    angle = Math.PI;
  }
  return angle;
}

function importedStrokeDetermineInternalArc(iterator: ImportedStrokeIterator) {
  const previousPhi = importedStrokePreviousPhi(iterator);
  const currentPhi = importedStrokeCurrentPhi(iterator);
  const turnAngle =
    importedStrokeTurnAngle(
      importedStrokeDerivative(iterator, importedStrokePreviousLocation(iterator)),
      importedStrokeDerivative(iterator, iterator.currentLocation),
    ) +
    previousPhi -
    currentPhi;
  const previousBaseAngle = importedStrokePreviousBaseAngle(iterator);
  const startAngle = angle(previousPhi, previousBaseAngle);
  const endAngle = wrapAngle(startAngle + turnAngle);
  return {
    a1: startAngle,
    a2: endAngle,
    clockwise: turnAngle < 0,
  };
}

function importedStrokeGetCurve(
  iterator: ImportedStrokeIterator,
  endT: number,
): { curve: CubicCurve; error: number } {
  const startLocation = iterator.currentLocation;
  const mapT = (value: number) => startLocation.t * (1 - value) + endT * value;
  const endLocation = {
    elementIndex: startLocation.elementIndex,
    t: endT,
  };
  const startPoint = importedStrokeOffsetPointAt(iterator, startLocation);
  const endPoint = importedStrokeOffsetPointAt(iterator, endLocation);
  const startDerivative = importedStrokeDerivative(iterator, startLocation);
  const endDerivative = importedStrokeDerivative(iterator, endLocation);
  const startRadius = importedStrokeRadiusAt(iterator, startLocation);
  const endRadius = importedStrokeRadiusAt(iterator, endLocation);
  const deltaT = endLocation.t - startLocation.t;
  const radiusSlope = (endRadius - startRadius) / deltaT;
  const startAngle = angleDelta(startDerivative, radiusSlope);
  const endAngle = angleDelta(endDerivative, radiusSlope);
  const startDirection = polarCoordinate(startAngle + Math.PI / 2, 1);
  const endDirection = polarCoordinate(endAngle + Math.PI / 2, 1);

  const sampleStartLocation = {
    elementIndex: startLocation.elementIndex,
    t: mapT(0.1),
  };
  const sampleStartPoint = importedStrokeOffsetPointAt(
    iterator,
    sampleStartLocation,
  );
  const sampleStartLength = pointDistance(sampleStartPoint, startPoint) / 0.1;

  const sampleEndLocation = {
    elementIndex: startLocation.elementIndex,
    t: mapT(0.9),
  };
  const sampleEndPoint = importedStrokeOffsetPointAt(iterator, sampleEndLocation);
  const sampleEndLength = pointDistance(sampleEndPoint, endPoint) / 0.1;

  const curve: CubicCurve = {
    p0: startPoint,
    p1: pointAdd(startPoint, pointScale(startDirection, sampleStartLength / 3)),
    p2: pointSubtract(endPoint, pointScale(endDirection, sampleEndLength / 3)),
    p3: endPoint,
  };
  const midpoint = importedStrokeOffsetPointAt(iterator, {
    elementIndex: startLocation.elementIndex,
    t: mapT(0.5),
  });

  return {
    curve,
    error: pointDistance(midpoint, cubicCurvePointAt(curve, 0.5)),
  };
}

function wrapAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return angle - fullTurn * Math.floor(angle / fullTurn);
}

function angleFromDifference(delta: [number, number]): number {
  return Math.atan2(delta[1], delta[0]);
}

function angle(baseAngle: number, tangentAngle: number): number {
  return wrapAngle((3 * Math.PI) / 2 - baseAngle + tangentAngle);
}

function angleDelta(
  derivative: [number, number],
  radiusDelta: number,
): number {
  const derivativeLength = Math.hypot(derivative[0], derivative[1]) || 1;
  const phi = Math.asin(
    Math.max(-1, Math.min(1, radiusDelta / derivativeLength)),
  );
  return angle(phi, angleFromDifference(derivative));
}

function polarCoordinate(angleInRadians: number, radius: number): [number, number] {
  return [Math.cos(angleInRadians) * radius, Math.sin(angleInRadians) * radius];
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

function phi(derivative: [number, number], radiusDelta: number) {
  const derivativeLength = pointLength(derivative);
  const normalizedDelta =
    derivativeLength > 0 ? radiusDelta / derivativeLength : 0;
  return Math.asin(clamp(normalizedDelta, -1, 1));
}

function arcLengthForAngles(
  startAngle: number,
  endAngle: number,
  radius: number,
) {
  const normalizedStart = wrapAngle(startAngle);
  const normalizedEnd = wrapAngle(endAngle);
  let delta = Math.abs(normalizedEnd - normalizedStart);
  if (delta > Math.PI) {
    delta = Math.PI * 2 - delta;
  }
  return delta * radius;
}

function addArc(
  path: SvgPathBuilder,
  center: [number, number],
  radius: number,
  startAngle: number,
  endAngle: number,
  clockwise: boolean,
) {
  const startPoint: [number, number] = [
    center[0] + radius * Math.cos(startAngle),
    center[1] + radius * Math.sin(startAngle),
  ];
  if (path.currentPoint) {
    path.lineTo(startPoint[0], startPoint[1]);
  } else {
    path.moveTo(startPoint[0], startPoint[1]);
  }

  if (startAngle === endAngle) {
    return;
  }

  let from = startAngle;
  let to = endAngle;
  if (from > to && !clockwise) {
    while (from > to) {
      to += Math.PI * 2;
    }
  } else if (from < to && clockwise) {
    while (from < to) {
      from += Math.PI * 2;
    }
  }

  const delta = to - from;
  const segmentCount = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  for (let index = 1; index <= segmentCount; index++) {
    const a0 = from + (delta * (index - 1)) / segmentCount;
    const a1 = from + (delta * index) / segmentCount;
    const arcDelta = a1 - a0;
    const handleScale = (4 / 3) * Math.tan(arcDelta / 4);
    const endPoint: [number, number] = [
      center[0] + radius * Math.cos(a1),
      center[1] + radius * Math.sin(a1),
    ];
    const control1: [number, number] = [
      center[0] + radius * Math.cos(a0) - radius * handleScale * Math.sin(a0),
      center[1] + radius * Math.sin(a0) + radius * handleScale * Math.cos(a0),
    ];
    const control2: [number, number] = [
      center[0] + radius * Math.cos(a1) + radius * handleScale * Math.sin(a1),
      center[1] + radius * Math.sin(a1) - radius * handleScale * Math.cos(a1),
    ];
    path.bezierCurveTo(
      control1[0],
      control1[1],
      control2[0],
      control2[1],
      endPoint[0],
      endPoint[1],
    );
  }
}

function importedStrokeAddStartcapArc(
  path: SvgPathBuilder,
  iterator: ImportedStrokeIterator,
) {
  const currentPhi = importedStrokeCurrentPhi(iterator);
  const currentBaseAngle = importedStrokeCurrentBaseAngle(iterator);
  addArc(
    path,
    importedStrokeCurrentPoint(iterator),
    importedStrokeCurrentRadius(iterator),
    angle(-currentPhi, currentBaseAngle - Math.PI),
    angle(currentPhi, currentBaseAngle),
    false,
  );
}

function cubicIsLinearWithinTolerance(
  curve: CubicCurve,
  configuration: ImportedStrokeIteratorConfiguration,
) {
  const lineSegment = { p0: curve.p0, p1: curve.p3 };
  const projectedP1 = projectOntoSegment(lineSegment, curve.p1);
  const projectedP2 = projectOntoSegment(lineSegment, curve.p2);
  const maxDistanceSquared =
    configuration.maximumCurveApproximateAsLineDistance *
    configuration.maximumCurveApproximateAsLineDistance;

  return !(
    pointDistanceSquared(curve.p1, projectedP1) >= maxDistanceSquared ||
    pointDistanceSquared(curve.p2, projectedP2) >= maxDistanceSquared
  );
}

function importedStrokeAddCurve(
  path: SvgPathBuilder,
  iterator: ImportedStrokeIterator,
) {
  const isAcceptableError = (error: number) =>
    error <= iterator.configuration.maximumAllowedCurveError;

  while (iterator.currentLocation.t < 1) {
    let error = 0;
    let stepSize = 1 - iterator.currentLocation.t;
    let nextT = 1;
    let curve: CubicCurve = {
      p0: importedStrokeCurrentPoint(iterator),
      p1: importedStrokeCurrentPoint(iterator),
      p2: importedStrokeCurrentPoint(iterator),
      p3: importedStrokeCurrentPoint(iterator),
    };

    do {
      nextT = Math.min(iterator.currentLocation.t + stepSize, 1);
      stepSize /= 2;
      const nextCurve = importedStrokeGetCurve(iterator, nextT);
      curve = nextCurve.curve;
      error = nextCurve.error;
    } while (
      !isAcceptableError(error) &&
      stepSize >= iterator.configuration.minimumSubdivisionStepSize
    );

    if (cubicIsLinearWithinTolerance(curve, iterator.configuration)) {
      path.lineTo(curve.p3[0], curve.p3[1]);
    } else {
      path.bezierCurveTo(
        curve.p1[0],
        curve.p1[1],
        curve.p2[0],
        curve.p2[1],
        curve.p3[0],
        curve.p3[1],
      );
    }

    importedStrokeAdvanceT(iterator, nextT);
  }
}

function importedStrokeAddInternalArc(
  path: SvgPathBuilder,
  iterator: ImportedStrokeIterator,
) {
  const { a1, a2, clockwise } = importedStrokeDetermineInternalArc(iterator);
  const radius = importedStrokeCurrentRadius(iterator);
  const center = importedStrokeCurrentPoint(iterator);

  if (
    arcLengthForAngles(a1, a2, radius) <
    iterator.configuration.minimumInternalArcLength
  ) {
    return;
  }

  if (clockwise) {
    const arcEnd = pointAdd(center, polarCoordinate(a2, radius));
    path.lineTo(arcEnd[0], arcEnd[1]);
    return;
  }

  addArc(path, center, radius, a1, a2, clockwise);
}

const CIRCLE_KAPPA = 0.5522847498307936;

function appendCircleSubpath(
  path: SvgPathBuilder,
  center: [number, number],
  radius: number,
) {
  if (!(radius > 0)) {
    return;
  }

  const controlOffset = radius * CIRCLE_KAPPA;
  const [centerX, centerY] = center;

  path.beginSubpath();
  path.moveTo(centerX + radius, centerY);
  path.bezierCurveTo(
    centerX + radius,
    centerY + controlOffset,
    centerX + controlOffset,
    centerY + radius,
    centerX,
    centerY + radius,
  );
  path.bezierCurveTo(
    centerX - controlOffset,
    centerY + radius,
    centerX - radius,
    centerY + controlOffset,
    centerX - radius,
    centerY,
  );
  path.bezierCurveTo(
    centerX - radius,
    centerY - controlOffset,
    centerX - controlOffset,
    centerY - radius,
    centerX,
    centerY - radius,
  );
  path.bezierCurveTo(
    centerX + controlOffset,
    centerY - radius,
    centerX + radius,
    centerY - controlOffset,
    centerX + radius,
    centerY,
  );
  path.closePath();
}

function appendImportedStrokePathData(
  path: SvgPathBuilder,
  component: ImportedStrokeComponent,
  baseWidth: number,
) {
  const iterator = createImportedStrokeIterator(
    component,
    importedStrokeConfiguration(baseWidth),
  );

  const renderSide = () => {
    importedStrokeAddStartcapArc(path, iterator);
    while (!importedStrokeReachedEnd(iterator)) {
      importedStrokeAddCurve(path, iterator);
      importedStrokeAdvanceToNextElement(iterator);
      if (!importedStrokeReachedEnd(iterator)) {
        importedStrokeAddInternalArc(path, iterator);
      }
    }
  };

  path.beginSubpath();
  renderSide();
  importedStrokeResetLocation(iterator);
  iterator.reversed = true;
  renderSide();
  path.closePath();
}

function buildImportedStrokeShapeData(
  component: ImportedStrokeComponent,
  baseWidth: number,
) {
  const path = new SvgPathBuilder();
  const configuration = importedStrokeConfiguration(baseWidth);
  const degenerateRanges = importedStrokeCollectDegenerateRanges(component);

  if (degenerateRanges.length === 0) {
    appendImportedStrokePathData(path, component, baseWidth);
    const elements = path.toElements(configuration.minimumElementLength);
    return {
      pathData: serializePathElements(elements),
      sampledContours: samplePathContours(
        elements,
        IMPORTED_NOTABILITY_CURVE_POINT_DIVISION_COUNT,
      ),
    };
  }

  for (const degenerateRange of degenerateRanges) {
    const startVertexIndex =
      degenerateRange.start.t <= 0
        ? degenerateRange.start.elementIndex
        : degenerateRange.start.elementIndex + 1;
    const endVertexIndex =
      degenerateRange.end.t < 1
        ? degenerateRange.end.elementIndex
        : degenerateRange.end.elementIndex + 1;

    if (endVertexIndex < startVertexIndex) {
      continue;
    }

    for (
      let vertexIndex = startVertexIndex;
      vertexIndex <= endVertexIndex;
      vertexIndex++
    ) {
      if (
        (vertexIndex !== 0 &&
          component.radii[vertexIndex] < component.radii[vertexIndex - 1]) ||
        (vertexIndex !== component.radii.length - 1 &&
          component.radii[vertexIndex] <= component.radii[vertexIndex + 1])
      ) {
        continue;
      }

      appendCircleSubpath(
        path,
        importedStrokeVertexPoint(component, vertexIndex),
        component.radii[vertexIndex],
      );
    }
  }

  const complementRanges = importedStrokeComplementRanges(
    component,
    degenerateRanges,
  );

  for (const complementRange of complementRanges) {
    const splitComponent = splitImportedStrokeComponent(
      component,
      importedStrokeStandardizeRange(complementRange),
    );
    if (!splitComponent || splitComponent.segments.length === 0) {
      continue;
    }
    appendImportedStrokePathData(path, splitComponent, baseWidth);
  }

  const elements = path.toElements(configuration.minimumElementLength);
  return {
    pathData: serializePathElements(elements),
    sampledContours: samplePathContours(
      elements,
      IMPORTED_NOTABILITY_CURVE_POINT_DIVISION_COUNT,
    ),
  };
}

function generateImportedNotabilityStroke(
  element: ExcalidrawFreeDrawElement,
  payload: ImportedNotabilityStrokeData,
): NotabilityStrokeShape {
  const importedStroke = buildImportedStrokeComponent(element, payload);

  if (!importedStroke) {
    return {
      type: "notability_stroke",
      outlinePoints: [],
      compositeOp: "source-over",
      penOpacity: 100,
      roundCaps: false,
      capStart: { center: [0, 0], radius: 0 },
      capEnd: { center: [0, 0], radius: 0 },
    };
  }

  const { component, baseWidth, firstPoint } = importedStroke;

  if (component.segments.length === 0) {
    const radius = component.radii[0] ?? Math.max(0.5, baseWidth * 0.5);
    return {
      type: "notability_stroke",
      outlinePoints: [],
      compositeOp: "source-over",
      penOpacity: 100,
      roundCaps: true,
      capStart: { center: firstPoint, radius },
      capEnd: { center: firstPoint, radius },
    };
  }

  return {
    type: "notability_stroke",
    outlinePoints: [],
    ...buildImportedStrokeShapeData(component, baseWidth),
    compositeOp: "source-over",
    penOpacity: 100,
    roundCaps: false,
    capStart: { center: [0, 0], radius: 0 },
    capEnd: { center: [0, 0], radius: 0 },
  };
}

function generateLiveNotabilityStroke(
  element: ExcalidrawFreeDrawElement,
  payload: LiveNotabilityStrokeData,
): NotabilityStrokeShape | null {
  const liveStroke = buildLiveNotabilityStrokeComponent(element, payload);
  if (!liveStroke) {
    return null;
  }

  const config = PEN_CONFIGS[element.penVariant] || PEN_CONFIGS.pen;
  const { component, baseWidth, firstPoint } = liveStroke;

  if (component.segments.length === 0) {
    const radius = component.radii[0] ?? Math.max(0.5, baseWidth * 0.5);
    return {
      type: "notability_stroke",
      outlinePoints: [],
      compositeOp: config.compositeOp,
      penOpacity: config.opacity,
      roundCaps: true,
      capStart: { center: firstPoint, radius },
      capEnd: { center: firstPoint, radius },
    };
  }

  return {
    type: "notability_stroke",
    outlinePoints: [],
    ...buildImportedStrokeShapeData(component, baseWidth),
    compositeOp: config.compositeOp,
    penOpacity: config.opacity,
    roundCaps: false,
    capStart: { center: [0, 0], radius: 0 },
    capEnd: { center: [0, 0], radius: 0 },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a Notability-style stroke shape from a freedraw element.
 * Returns the outline polygon and rendering parameters for the canvas pipeline.
 */
export function generateNotabilityStroke(
  element: ExcalidrawFreeDrawElement,
): NotabilityStrokeShape {
  const importedStroke = getImportedNotabilityStrokeData(element);
  if (importedStroke) {
    return generateImportedNotabilityStroke(element, importedStroke);
  }

  const liveStroke = getLiveNotabilityStrokeData(element);
  if (liveStroke) {
    const generatedLiveStroke = generateLiveNotabilityStroke(element, liveStroke);
    if (generatedLiveStroke) {
      return generatedLiveStroke;
    }
  }

  const config = PEN_CONFIGS[element.penVariant] || PEN_CONFIGS.pen;

  // 1. Extract raw points and pressures
  const rawPoints: [number, number][] = element.points.map(
    (p) => [p[0], p[1]] as [number, number],
  );

  let rawPressures: number[];
  if (element.simulatePressure || element.pressures.length === 0) {
    // No real pressure data — use uniform 0.5
    rawPressures = rawPoints.map(() => 0.5);
  } else {
    rawPressures = [...element.pressures];
    // Pad to same length if needed
    while (rawPressures.length < rawPoints.length) {
      rawPressures.push(rawPressures[rawPressures.length - 1] || 0.5);
    }
  }

  // Handle degenerate cases
  if (rawPoints.length === 0) {
    return {
      type: "notability_stroke",
      outlinePoints: [],
      compositeOp: config.compositeOp,
      penOpacity: config.opacity,
      roundCaps: config.roundCaps,
      capStart: { center: [0, 0], radius: 0 },
      capEnd: { center: [0, 0], radius: 0 },
    };
  }

  if (rawPoints.length === 1) {
    // Single dot — use a small dot proportional to stroke width
    const baseWidth = element.strokeWidth * 4.25;
    const p = rawPressures[0];
    const pressureFactor = 1 - config.thinning + config.thinning * p;
    const sizeRange = config.minSize + (config.maxSize - config.minSize) * p;
    const r = Math.max(0.5, (baseWidth * pressureFactor * (sizeRange / config.maxSize)) / 2);
    return {
      type: "notability_stroke",
      outlinePoints: [],
      compositeOp: config.compositeOp,
      penOpacity: config.opacity,
      roundCaps: true,
      capStart: { center: rawPoints[0], radius: r },
      capEnd: { center: rawPoints[0], radius: r },
    };
  }

  // 2. Interpolate with Catmull-Rom
  const segmentsPerSpan = Math.max(2, Math.min(8, Math.ceil(16 / rawPoints.length * 4)));
  const { points: smoothPoints, pressures: smoothPressures } =
    interpolateStroke(rawPoints, rawPressures, segmentsPerSpan, config.smoothing);

  // 3. Compute per-point widths from pressure
  let widths: number[];
  if (config.linearWidth) {
    // Linear mode: pressure directly controls width as a multiplier of baseWidth.
    // Uses the standard 4.25x scaling so that Excalidraw UI stroke widths (1/2/4)
    // produce usable line widths for live drawing (e.g. 0.5 * 2 * 4.25 = 4.25px).
    // The converter compensates by dividing curvesWidth by 4.25, so imported data
    // gets: fracWidth * (curvesWidth/4.25) * 4.25 = fracWidth * curvesWidth (exact).
    // No clamping to 0-1 — imported data can have fractional widths > 1.0.
    const baseWidth = element.strokeWidth * 4.25;
    widths = smoothPressures.map((p) =>
      Math.max(0.5, Math.abs(p) * baseWidth),
    );
  } else {
    const baseWidth = element.strokeWidth * 4.25; // Excalidraw UI scaling
    widths = computeWidths(smoothPressures, config, baseWidth);
  }

  // 4. Generate outline polygon
  const outlinePoints = generateOutlinePolygon(
    smoothPoints,
    widths,
    config,
    (element as any).seed || 0,
  );

  // 5. Compute cap info
  // When tapering is active, the outline polygon already tapers to a point,
  // so we don't need separate round caps (which would create visible dots).
  // Only draw caps when there's no tapering on that end.
  const firstPoint = smoothPoints[0];
  const lastPoint = smoothPoints[smoothPoints.length - 1];
  const firstWidth = widths[0];
  const lastWidth = widths[widths.length - 1];

  const hasStartTaper = config.taperStart > 0;
  const hasEndTaper = config.taperEnd > 0;

  return {
    type: "notability_stroke",
    outlinePoints,
    compositeOp: config.compositeOp,
    penOpacity: config.opacity,
    roundCaps: config.roundCaps,
    capStart: {
      center: firstPoint,
      radius: hasStartTaper ? 0 : firstWidth / 2,
    },
    capEnd: {
      center: lastPoint,
      radius: hasEndTaper ? 0 : lastWidth / 2,
    },
  };
}

/**
 * Check if a shape is a NotabilityStrokeShape.
 */
export function isNotabilityStrokeShape(
  shape: unknown,
): shape is NotabilityStrokeShape {
  return (
    shape !== null &&
    typeof shape === "object" &&
    (shape as any).type === "notability_stroke"
  );
}
