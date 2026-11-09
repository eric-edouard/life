import { expect, test } from "bun:test";
import { pcaOf } from "./voice-pca";

test("PCA centers, orders variance and preserves 3D distances including rotated and deficient sets", () => {
  expect(pcaOf([])).toEqual([]);
  expect(pcaOf([[2, 3, 4]])).toEqual([[0, 0, 0]]);
  const vectors = [
    [3, 1, 1],
    [-3, -1, 1],
    [0, 2, -1],
    [0, -2, -1],
  ];
  const points = pcaOf(vectors);
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const distance = (rows: number[][]) =>
        Math.hypot(...(rows[i] ?? []).map((x, k) => x - (rows[j]?.[k] ?? 0)));
      expect(distance(points)).toBeCloseTo(distance(vectors), 8);
    }
  }
  expect(points[0]?.[0]).not.toBe(0);
  expect(pcaOf([[1], [3]])).toEqual([
    [-1, 0, 0],
    [1, 0, 0],
  ]);
  const variances = [0, 1, 2].map((i) =>
    points.reduce((sum, p) => sum + (p[i] ?? 0) ** 2, 0)
  );
  expect(variances[0]).toBeGreaterThanOrEqual(variances[1] ?? 0);
  expect(variances[1]).toBeGreaterThanOrEqual(variances[2] ?? 0);
});

test("PCA retains radial distance: an outlier stays farther from the mean", () => {
  const points = pcaOf([
    [-4, 0],
    [0, 0],
    [1, 0],
    [3, 0],
  ]);
  expect(Math.hypot(...(points[0] ?? []))).toBeGreaterThan(
    Math.hypot(...(points[2] ?? []))
  );
  const repeated = [
    [1, 0, 0, 0],
    [-1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, -1, 0, 0],
  ];
  expect(pcaOf(repeated)).toEqual(pcaOf(repeated));
  for (const point of pcaOf(repeated)) {
    expect(Math.hypot(...point)).toBeCloseTo(1, 8);
  }
});
