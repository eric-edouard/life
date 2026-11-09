// Three principal components of centered group centroids, preserving their distance from the mean.
import type { Vector } from "./speakers";

function covariance(rows: Vector[], dimensions: number) {
  const matrix = new Float64Array(dimensions * dimensions);
  for (const row of rows) {
    for (let i = 0; i < dimensions; i += 1) {
      const x = row[i] ?? 0;
      let at = i * dimensions + i;
      for (let j = i; j < dimensions; j += 1) {
        matrix[at] = (matrix[at] ?? 0) + x * (row[j] ?? 0);
        at += 1;
      }
    }
  }
  for (let i = 0; i < dimensions; i += 1) {
    for (let j = 0; j < i; j += 1) {
      matrix[i * dimensions + j] = matrix[j * dimensions + i] ?? 0;
    }
  }
  return matrix;
}

const productOf = (matrix: Float64Array, vector: Vector) =>
  vector.map((_, i) =>
    vector.reduce(
      (sum, x, j) => sum + (matrix[i * vector.length + j] ?? 0) * x,
      0
    )
  );

function axisOf(
  matrix: Float64Array,
  seed: Vector,
  axes: Vector[],
  scale: number
) {
  let vector = seed;
  const n = vector.length;
  for (let step = 0; step < 128; step += 1) {
    const next = productOf(matrix, vector);
    // Reorthogonalize to keep numerical residue from reviving an earlier axis.
    for (const previous of axes) {
      const along = dot(next, previous);
      for (let i = 0; i < n; i += 1) {
        next[i] = (next[i] ?? 0) - along * (previous[i] ?? 0);
      }
    }
    const norm = Math.hypot(...next);
    if (norm <= scale * 1e-12 || norm === 0) {
      break;
    }
    const unit = next.map((x) => x / norm);
    const change = Math.abs(1 - Math.abs(dot(unit, vector)));
    vector = unit;
    if (change < 1e-12) {
      break;
    }
  }
  return vector;
}

// Only three axes: bounded power iterations on the covariance, with orthogonal deflation.
function axesOf(matrix: Float64Array, n: number) {
  const axes: Vector[] = [];
  const scale = Math.max(...matrix.map(Math.abs), 0);
  for (let axis = 0; axis < Math.min(3, n); axis += 1) {
    const pivot = Array.from({ length: n }, (_, i) => i).reduce(
      (best, i) =>
        (matrix[i * n + i] ?? 0) > (matrix[best * n + best] ?? 0) ? i : best,
      0
    );
    let vector = Array.from(
      { length: n },
      (_, i) => (i === pivot ? 1 : 0) + 0.01 * Math.sin((i + 1) * (axis + 1))
    );
    const length = Math.hypot(...vector);
    vector = vector.map((x) => x / length);
    vector = axisOf(matrix, vector, axes, scale);
    const value = dot(vector, productOf(matrix, vector));
    if (value <= scale * 1e-12 || value === 0) {
      break;
    }
    axes.push(vector);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const at = i * n + j;
        matrix[at] =
          (matrix[at] ?? 0) - value * (vector[i] ?? 0) * (vector[j] ?? 0);
      }
    }
  }
  return axes;
}

const dot = (a: Vector, b: Vector) =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

export function pcaOf(
  vectors: Vector[],
  project = vectors
): [number, number, number][] {
  const n = vectors[0]?.length ?? 0;
  const mean = new Array<number>(n)
    .fill(0)
    .map(
      (_, i) =>
        vectors.reduce((sum, v) => sum + (v[i] ?? 0), 0) / vectors.length
    );
  const rows = vectors.map((v) => v.map((x, i) => x - (mean[i] ?? 0)));
  const matrix = covariance(rows, n);
  const top = axesOf(matrix, n);
  return project
    .map((v) => v.map((x, i) => x - (mean[i] ?? 0)))
    .map((v) => [
      dot(v, top[0] ?? []),
      dot(v, top[1] ?? []),
      dot(v, top[2] ?? []),
    ]);
}
