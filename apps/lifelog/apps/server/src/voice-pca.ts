// Three principal components of centered group centroids. Distances here are projections,
// never recognition scores. Cyclic Jacobi also handles repeated eigenvalues and deficient rank.
import { cosine, type Vector } from "./speakers";

function covariance(rows: Vector[], dimensions: number) {
  const matrix = new Float64Array(dimensions * dimensions);
  for (const row of rows) {
    for (let i = 0; i < dimensions; i += 1) {
      for (let j = i; j < dimensions; j += 1) {
        const at = i * dimensions + j;
        matrix[at] = (matrix[at] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
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

function rotate(
  matrix: Float64Array,
  axes: Float64Array,
  p: number,
  q: number,
  n: number
) {
  const off = matrix[p * n + q] ?? 0;
  if (Math.abs(off) < 1e-12) {
    return false;
  }
  const pp = matrix[p * n + p] ?? 0;
  const qq = matrix[q * n + q] ?? 0;
  const theta = 0.5 * Math.atan2(2 * off, qq - pp);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let k = 0; k < n; k += 1) {
    if (k !== p && k !== q) {
      const kp = matrix[k * n + p] ?? 0;
      const kq = matrix[k * n + q] ?? 0;
      matrix[k * n + p] = c * kp - s * kq;
      matrix[p * n + k] = c * kp - s * kq;
      matrix[k * n + q] = s * kp + c * kq;
      matrix[q * n + k] = s * kp + c * kq;
    }
    const ap = axes[k * n + p] ?? 0;
    const aq = axes[k * n + q] ?? 0;
    axes[k * n + p] = c * ap - s * aq;
    axes[k * n + q] = s * ap + c * aq;
  }
  matrix[p * n + p] = c * c * pp - 2 * s * c * off + s * s * qq;
  matrix[q * n + q] = s * s * pp + 2 * s * c * off + c * c * qq;
  matrix[p * n + q] = 0;
  matrix[q * n + p] = 0;
  return true;
}

export function pcaOf(vectors: Vector[]): [number, number, number][] {
  const n = vectors[0]?.length ?? 0;
  const mean = new Array<number>(n)
    .fill(0)
    .map(
      (_, i) =>
        vectors.reduce((sum, v) => sum + (v[i] ?? 0), 0) / vectors.length
    );
  const rows = vectors.map((v) => v.map((x, i) => x - (mean[i] ?? 0)));
  const matrix = covariance(rows, n);
  const axes = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    axes[i * n + i] = 1;
  }
  for (let sweep = 0; sweep < 40; sweep += 1) {
    let changed = false;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        changed = rotate(matrix, axes, p, q, n) || changed;
      }
    }
    if (!changed) {
      break;
    }
  }
  const top = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (matrix[b * n + b] ?? 0) - (matrix[a * n + a] ?? 0))
    .slice(0, 3)
    .map((i) => Array.from({ length: n }, (_, j) => axes[j * n + i] ?? 0));
  return rows.map((v) => [
    cosine(v, top[0] ?? []),
    cosine(v, top[1] ?? []),
    cosine(v, top[2] ?? []),
  ]);
}
