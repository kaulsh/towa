import {
  pipeline,
  type FeatureExtractionPipeline,
  type Tensor,
} from "@huggingface/transformers";
import type { LoadedEmbeddingModel } from "../types.js";

export interface LocalEmbeddingsConfig {
  /**
   * Hugging Face / ONNX model id.
   * Defaults to a small MiniLM ONNX build suitable for CPU.
   */
  model?: string;
  /**
   * Embedding dimensionality. When omitted, inferred during load.
   */
  dimensions?: number;
}

const DEFAULT_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";

function tensorToRows(output: Tensor): number[][] {
  const list = output.tolist() as number[] | number[][];
  if (list.length === 0) return [];
  if (Array.isArray(list[0])) {
    return list as number[][];
  }
  return [list as number[]];
}

async function extractRows(
  extractor: FeatureExtractionPipeline,
  texts: string[],
): Promise<number[][]> {
  const output = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });
  return tensorToRows(output);
}

/**
 * Local CPU embedding loader via transformers.js / ONNX (§8.2 / §8.4).
 * Kept off the GPU deliberately — embedding is the highest-frequency call.
 */
export async function loadLocalEmbeddings(
  config: LocalEmbeddingsConfig = {},
): Promise<LoadedEmbeddingModel> {
  const modelId = config.model ?? DEFAULT_MODEL;

  const extractor = (await pipeline("feature-extraction", modelId, {
    device: "cpu",
  })) as FeatureExtractionPipeline;

  let dimensions = config.dimensions;
  if (dimensions === undefined) {
    const probe = await extractRows(extractor, ["."]);
    const inferred = probe[0]?.length;
    if (inferred === undefined) {
      throw new Error(
        `Could not infer embedding dimensions for "${modelId}". Pass dimensions in config.`,
      );
    }
    dimensions = inferred;
  }

  return {
    id: modelId,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return extractRows(extractor, texts);
    },
  };
}
