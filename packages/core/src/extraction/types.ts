import { z } from "zod";

import type { MediaRef } from "../messages.js";

/** Local mention id used inside one extraction pass to wire edges. */
export const ExtractedEntitySchema = z.object({
  mention_id: z.string().min(1),
  type_label: z.string().min(1),
  canonical_name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  attributes: z.record(z.unknown()).default({}),
});

export const ExtractedEdgeSchema = z.object({
  subject_mention_id: z.string().min(1),
  relation_label: z.string().min(1),
  object_mention_id: z.string().nullable().default(null),
  object_literal: z.string().nullable().default(null),
  /** World-time start; null means use episode closed_at. */
  valid_from: z.number().nullable().default(null),
  /**
   * single = inherently single-valued (residence, job, …) — may close prior
   * edge on clear contradiction. many = additive (friendships, projects).
   */
  cardinality: z.enum(["single", "many"]),
  /**
   * LLM judgment: new fact clearly contradicts an existing open edge on the
   * same (subject, relation). Only meaningful when cardinality is single.
   */
  contradicts_existing: z.boolean().default(false),
});

export const EpisodeExtractionSchema = z.object({
  /** One-sentence dense retrieval handle — always required (§2.4). */
  gist: z.string().min(1),
  /** Durable personal entities only; empty when nothing personal/durable (§2.3, §4). */
  entities: z
    .array(ExtractedEntitySchema)
    .default([])
    .describe(
      "Entities for durable personal facts only; empty array when none",
    ),
  /** Durable personal edges only; empty when nothing personal/durable (§2.3, §4). */
  edges: z
    .array(ExtractedEdgeSchema)
    .default([])
    .describe(
      "Edges for durable personal facts only; empty array when none",
    ),
});

export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;
export type ExtractedEdge = z.infer<typeof ExtractedEdgeSchema>;
export type EpisodeExtraction = z.infer<typeof EpisodeExtractionSchema>;

export const EntityMatchDecisionSchema = z.object({
  same_entity: z.boolean(),
  /** Confidence is advisory; uncertain → treat as not-same (§4.3). */
  confident: z.boolean(),
});

export type EntityMatchDecision = z.infer<typeof EntityMatchDecisionSchema>;

export interface EpisodeTurn {
  rawLogId: number;
  timestamp: number;
  role: "user" | "assistant";
  content: string;
  /** Platform message id; empty string when unknown (legacy rows). */
  messageId: string;
  /** Durable media ref from raw_log columns — never includes `data`. */
  media?: MediaRef;
}

export interface ResolvedEntity {
  mentionId: string;
  nodeId: string;
  /** True when we created a new kg_nodes row for this mention. */
  created: boolean;
  typeLabel: string;
  canonicalName: string;
  aliases: string[];
  attributes: Record<string, unknown>;
}

export interface PreparedEdgeWrite {
  id: string;
  subjectId: string;
  relationLabel: string;
  objectId: string | null;
  objectLiteral: string | null;
  validFrom: number;
  validTo: number;
  ingestedAt: number;
  provenance: number[];
  /** Existing open edge ids to close (set valid_to) before inserting this one. */
  closeEdgeIds: string[];
  closeValidTo: number;
}

export interface PreparedNodeWrite {
  id: string;
  typeLabel: string;
  canonicalName: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  embedding: number[];
  provenance: number[];
}
