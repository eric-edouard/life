export type Vector = number[];

// Embeddings are L2-normalized, so the dot product is the cosine.
export function cosine(a: Vector, b: Vector) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}
