import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import type {
  ChatMessage,
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../ai/types.js";
import { randomUUID } from "node:crypto";

import { blobToEmbedding, cosineSimilarity } from "./embeddings.js";
import { generateStructured } from "./structured.js";
import {
  EntityMatchDecisionSchema,
  type ExtractedEntity,
  type PreparedNodeWrite,
  type ResolvedEntity,
} from "./types.js";

const FUZZY_NAME_LIMIT = 8;
const EMBEDDING_NEIGHBOR_LIMIT = 8;
const VERIFICATION_CANDIDATE_LIMIT = 3;
/** Cosine similarity floor for embedding neighbors. */
const EMBEDDING_MIN_SIMILARITY = 0.55;

export interface EntityResolutionResult {
  resolved: ResolvedEntity[];
  /** New nodes to insert in the final write transaction. */
  newNodes: PreparedNodeWrite[];
}

/**
 * Three-stage entity resolution (§4.3):
 * 1. Within-episode coreference — already done by the extraction LLM.
 * 2. Cross-episode candidate generation (fuzzy name + embedding NN + graph boost).
 * 3. Bounded LLM yes/no verification — bias toward NOT merging on ambiguity.
 *
 * That bias can leave two KG nodes for one real entity (a false split). A false
 * merge corrupts the graph and is hard to undo; a false split is self-healing
 * via a later maintenance op `merge_entities(a, b)`: reassign edges onto a
 * survivor, fold the discarded name into `aliases`, merge provenance/attributes,
 * and retire the discarded node. Provenance still points at the raw log, so no
 * facts are lost. Not part of this hot path — only a post-hoc heal for splits.
 *
 * TODO(maintenance): implement merge_entities(a, b).
 */
export async function resolveEntities(
  db: Kysely<Database>,
  chatModel: LoadedChatModel,
  embeddingModel: LoadedEmbeddingModel,
  entities: ExtractedEntity[],
  episodeId: number,
  /** Mention ids already confidently mapped to existing nodes in this pass. */
  priorResolutions: Map<string, string> = new Map(),
): Promise<EntityResolutionResult> {
  const resolved: ResolvedEntity[] = [];
  const newNodes: PreparedNodeWrite[] = [];
  const mentionToNode = new Map<string, string>(priorResolutions);

  // Resolve sequentially so graph corroboration can use earlier decisions.
  for (const entity of entities) {
    if (mentionToNode.has(entity.mention_id)) {
      const nodeId = mentionToNode.get(entity.mention_id)!;
      resolved.push({
        mentionId: entity.mention_id,
        nodeId,
        created: false,
        typeLabel: entity.type_label,
        canonicalName: entity.canonical_name,
        aliases: entity.aliases,
        attributes: entity.attributes as Record<string, unknown>,
      });
      continue;
    }

    const candidates = await generateCandidates(db, embeddingModel, entity, [
      ...mentionToNode.values(),
    ]);

    let matchedNodeId: string | null = null;
    for (const candidate of candidates.slice(0, VERIFICATION_CANDIDATE_LIMIT)) {
      const same = await verifyMatch(chatModel, entity, candidate);
      if (same) {
        matchedNodeId = candidate.id;
        break;
      }
    }

    if (matchedNodeId) {
      mentionToNode.set(entity.mention_id, matchedNodeId);
      resolved.push({
        mentionId: entity.mention_id,
        nodeId: matchedNodeId,
        created: false,
        typeLabel: entity.type_label,
        canonicalName: entity.canonical_name,
        aliases: entity.aliases,
        attributes: entity.attributes as Record<string, unknown>,
      });
      continue;
    }

    // No confident match → create a new node (bias toward split).
    const embeddingText = buildNodeEmbeddingText(entity);
    const [embedding] = await embeddingModel.embed([embeddingText]);
    const nodeId = randomUUID();
    const prepared: PreparedNodeWrite = {
      id: nodeId,
      typeLabel: entity.type_label,
      canonicalName: entity.canonical_name,
      aliases: entity.aliases,
      attributes: entity.attributes as Record<string, unknown>,
      embedding: embedding ?? [],
      provenance: [episodeId],
    };
    newNodes.push(prepared);
    mentionToNode.set(entity.mention_id, nodeId);
    resolved.push({
      mentionId: entity.mention_id,
      nodeId,
      created: true,
      typeLabel: entity.type_label,
      canonicalName: entity.canonical_name,
      aliases: entity.aliases,
      attributes: entity.attributes as Record<string, unknown>,
    });
  }

  return { resolved, newNodes };
}

interface CandidateNode {
  id: string;
  typeLabel: string;
  canonicalName: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  score: number;
}

async function generateCandidates(
  db: Kysely<Database>,
  embeddingModel: LoadedEmbeddingModel,
  entity: ExtractedEntity,
  alreadyLinkedNodeIds: string[],
): Promise<CandidateNode[]> {
  const rows = await db
    .selectFrom("kg_nodes")
    .select([
      "id",
      "type_label",
      "canonical_name",
      "aliases",
      "attributes",
      "embedding",
    ])
    .execute();

  if (rows.length === 0) {
    return [];
  }

  const nameQuery = normalizeName(entity.canonical_name);
  const aliasQueries = entity.aliases.map(normalizeName);

  const byId = new Map<string, CandidateNode>();

  // Fuzzy / string match stage.
  for (const row of rows) {
    const aliases = parseStringArray(row.aliases);
    const names = [row.canonical_name, ...aliases].map(normalizeName);
    let nameScore = 0;
    for (const n of names) {
      if (n === nameQuery || aliasQueries.includes(n)) {
        nameScore = Math.max(nameScore, 1);
      } else if (
        n.includes(nameQuery) ||
        nameQuery.includes(n) ||
        aliasQueries.some((a) => n.includes(a) || a.includes(n))
      ) {
        nameScore = Math.max(nameScore, 0.7);
      }
    }
    if (nameScore > 0) {
      byId.set(row.id, {
        id: row.id,
        typeLabel: row.type_label,
        canonicalName: row.canonical_name,
        aliases,
        attributes: parseAttributes(row.attributes),
        score: nameScore,
      });
    }
  }

  // Keep top fuzzy hits even if we also score embeddings.
  const fuzzyTop = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, FUZZY_NAME_LIMIT);
  for (const c of fuzzyTop) {
    byId.set(c.id, c);
  }

  // Embedding nearest-neighbor stage.
  const [queryEmbedding] = await embeddingModel.embed([
    buildNodeEmbeddingText(entity),
  ]);
  if (queryEmbedding && queryEmbedding.length > 0) {
    const scored: CandidateNode[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = blobToEmbedding(row.embedding);
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (sim < EMBEDDING_MIN_SIMILARITY) continue;
      scored.push({
        id: row.id,
        typeLabel: row.type_label,
        canonicalName: row.canonical_name,
        aliases: parseStringArray(row.aliases),
        attributes: parseAttributes(row.attributes),
        score: sim,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const c of scored.slice(0, EMBEDDING_NEIGHBOR_LIMIT)) {
      const existing = byId.get(c.id);
      if (existing) {
        existing.score = Math.max(existing.score, c.score);
      } else {
        byId.set(c.id, c);
      }
    }
  }

  // Graph corroboration: boost nodes already connected to entities resolved
  // earlier in this episode.
  if (alreadyLinkedNodeIds.length > 0) {
    const linked = await db
      .selectFrom("kg_edges")
      .select(["subject_id", "object_id"])
      .where((eb) =>
        eb.or([
          eb("subject_id", "in", alreadyLinkedNodeIds),
          eb("object_id", "in", alreadyLinkedNodeIds),
        ]),
      )
      .execute();

    const neighborIds = new Set<string>();
    for (const e of linked) {
      if (e.object_id && alreadyLinkedNodeIds.includes(e.subject_id)) {
        neighborIds.add(e.object_id);
      }
      if (e.object_id && alreadyLinkedNodeIds.includes(e.object_id)) {
        neighborIds.add(e.subject_id);
      }
      if (!e.object_id && alreadyLinkedNodeIds.includes(e.subject_id)) {
        // literal edges don't yield a neighbor node
      }
    }

    for (const id of neighborIds) {
      const existing = byId.get(id);
      if (existing) {
        existing.score += 0.25;
      } else {
        const row = rows.find((r) => r.id === id);
        if (row) {
          byId.set(id, {
            id: row.id,
            typeLabel: row.type_label,
            canonicalName: row.canonical_name,
            aliases: parseStringArray(row.aliases),
            attributes: parseAttributes(row.attributes),
            score: 0.25,
          });
        }
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score);
}

async function verifyMatch(
  chatModel: LoadedChatModel,
  entity: ExtractedEntity,
  candidate: CandidateNode,
): Promise<boolean> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        'You verify entity identity for a knowledge graph. Decide whether the new mention refers to the SAME real-world entity as the existing node. When uncertain, set same_entity=false. Respond only as JSON matching the schema: {"same_entity": boolean, "confident": boolean}. Do not answer with bare yes/no.',
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          new_mention: {
            type_label: entity.type_label,
            canonical_name: entity.canonical_name,
            aliases: entity.aliases,
            attributes: entity.attributes,
          },
          existing_node: {
            type_label: candidate.typeLabel,
            canonical_name: candidate.canonicalName,
            aliases: candidate.aliases,
            attributes: candidate.attributes,
          },
        },
        null,
        2,
      ),
    },
  ];

  const decision = await generateStructured(
    chatModel,
    messages,
    EntityMatchDecisionSchema,
  );

  // Bias toward not-merging: require same_entity AND confident.
  return decision.same_entity && decision.confident;
}

function buildNodeEmbeddingText(entity: ExtractedEntity): string {
  const attrKeys = Object.keys(entity.attributes);
  const attrSnippet =
    attrKeys.length > 0 ? ` ${JSON.stringify(entity.attributes)}` : "";
  return `${entity.type_label}: ${entity.canonical_name}${attrSnippet}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function parseAttributes(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}
