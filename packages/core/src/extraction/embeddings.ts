/** Pack/unpack float32 embedding vectors for sqlite-vec BLOB columns. */

export function embeddingToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function blobToEmbedding(blob: Buffer): number[] {
  const aligned =
    blob.byteOffset % 4 === 0
      ? blob
      : Buffer.from(blob);
  return Array.from(
    new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4),
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return -1;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return -1;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
