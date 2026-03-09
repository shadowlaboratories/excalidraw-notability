import {
  generateNotabilityStroke,
  isNotabilityStrokeShape,
  type LiveNotabilityStrokeData,
} from "../src/notabilityStroke";
import { newFreeDrawElement } from "../src/newElement";
import { ShapeCache } from "../src/shape";

const buildLiveStrokeData = (forces: number[]): LiveNotabilityStrokeData => ({
  version: 1,
  source: "excalidraw-live-input",
  zoomAtCreation: 1,
  samples: forces.map((force, index) => ({
    timestamp: index * 16,
    force,
    azimuthX: 1,
    azimuthY: 0,
    altitude: Math.PI / 2,
    predicted: false,
    estimatedPropsExpectingUpdates: 0,
    expectedUpdatesTimedOut: false,
  })),
});

const createFreedrawElement = (
  opts: {
    points: readonly [number, number][];
    pressures: readonly number[];
    customData?: Record<string, unknown>;
    penVariant?: "pen" | "pencil" | "marker" | "highlighter";
  },
) =>
  newFreeDrawElement({
    type: "freedraw",
    x: 100,
    y: 200,
    points: opts.points,
    pressures: opts.pressures,
    simulatePressure: false,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeWidth: 2,
    opacity: 100,
    roughness: 0,
    penVariant: opts.penVariant ?? "pen",
    customData: opts.customData,
  });

beforeEach(() => {
  ShapeCache.destroy();
});

describe("generateNotabilityStroke", () => {
  it("builds a live Notability path for fresh freedraw strokes", () => {
    const element = createFreedrawElement({
      points: [
        [0, 0],
        [12, 3],
        [26, 10],
        [42, 18],
        [61, 28],
      ],
      pressures: [0.2, 0.35, 0.6, 0.85, 1],
      customData: {
        liveNotabilityStroke: buildLiveStrokeData([0.2, 0.35, 0.6, 0.85, 1]),
      },
    });

    const shape = generateNotabilityStroke(element);

    expect(shape.type).toBe("notability_stroke");
    expect(shape.pathData).toContain("C");
    expect(shape.sampledContours?.length).toBeGreaterThan(0);
    expect(shape.roundCaps).toBe(false);
    expect(shape.penOpacity).toBe(100);
  });

  it("returns a dot for a single-point live stroke", () => {
    const element = createFreedrawElement({
      points: [[0, 0]],
      pressures: [0.75],
      customData: {
        liveNotabilityStroke: buildLiveStrokeData([0.75]),
      },
    });

    const shape = generateNotabilityStroke(element);

    expect(shape.roundCaps).toBe(true);
    expect(shape.capStart.radius).toBeGreaterThan(0);
    expect(shape.capEnd.radius).toBe(shape.capStart.radius);
  });
});

describe("ShapeCache freedraw routing", () => {
  it("uses the Notability renderer only for strokes carrying live sample metadata", () => {
    const liveStroke = createFreedrawElement({
      points: [
        [0, 0],
        [10, 2],
        [24, 8],
        [40, 16],
      ],
      pressures: [0.3, 0.45, 0.7, 0.9],
      customData: {
        liveNotabilityStroke: buildLiveStrokeData([0.3, 0.45, 0.7, 0.9]),
      },
    });
    const legacyStroke = createFreedrawElement({
      points: [
        [0, 0],
        [10, 2],
        [24, 8],
        [40, 16],
      ],
      pressures: [0.3, 0.45, 0.7, 0.9],
    });

    const liveShapes = ShapeCache.generateElementShape(liveStroke, null);
    const legacyShapes = ShapeCache.generateElementShape(legacyStroke, null);

    expect(isNotabilityStrokeShape(liveShapes[0])).toBe(true);
    expect(typeof legacyShapes[0]).toBe("string");
  });
});
