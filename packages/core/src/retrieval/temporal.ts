import type { Kysely } from "kysely";

import { sql } from "kysely";

import type { Database } from "../db/types.js";
import type { HistoryRequest, KgFact } from "./types.js";

/**
 * Default temporal filter: currently-valid edges only (§5.3 / §2.3).
 * `valid_to` never uses NULL — open edges use VALID_TO_OPEN_SENTINEL.
 */
export function isCurrentlyValid(validFrom: number, validTo: number, nowSec: number): boolean {
  return validFrom <= nowSec && nowSec < validTo;
}

/**
 * Dedicated historical path (§5.3): full validity timeline for an entity
 * (and optional relation). This is the load-bearing gate to superseded facts —
 * not implicit past-tense detection in query-gen.
 */
export async function getHistory(
  db: Kysely<Database>,
  request: HistoryRequest,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<KgFact[]> {
  const entity = request.entity.trim();
  if (!entity) {
    return [];
  }

  const rows = await sql<{
    edge_id: string;
    subject_id: string;
    subject_name: string;
    relation_label: string;
    object_id: string | null;
    object_literal: string | null;
    object_name: string | null;
    valid_from: number;
    valid_to: number;
  }>`
    SELECT
      e.id AS edge_id,
      e.subject_id,
      sn.canonical_name AS subject_name,
      e.relation_label,
      e.object_id,
      e.object_literal,
      onode.canonical_name AS object_name,
      e.valid_from,
      e.valid_to
    FROM kg_edges e
    JOIN kg_nodes sn ON sn.id = e.subject_id
    LEFT JOIN kg_nodes onode ON onode.id = e.object_id
    WHERE (
      sn.canonical_name = ${entity}
      OR EXISTS (
        SELECT 1 FROM json_each(sn.aliases) AS a WHERE a.value = ${entity}
      )
    )
    ${request.relation ? sql`AND e.relation_label = ${request.relation}` : sql``}
    ORDER BY e.valid_from ASC, e.ingested_at ASC
  `.execute(db);

  return rows.rows.map((row) => toFact(row, nowSec));
}

/** Load currently-valid facts for the given edge ids. */
export async function loadCurrentFactsByEdgeIds(
  db: Kysely<Database>,
  edgeIds: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<KgFact[]> {
  if (edgeIds.length === 0) {
    return [];
  }

  const rows = await sql<{
    edge_id: string;
    subject_id: string;
    subject_name: string;
    relation_label: string;
    object_id: string | null;
    object_literal: string | null;
    object_name: string | null;
    valid_from: number;
    valid_to: number;
  }>`
    SELECT
      e.id AS edge_id,
      e.subject_id,
      sn.canonical_name AS subject_name,
      e.relation_label,
      e.object_id,
      e.object_literal,
      onode.canonical_name AS object_name,
      e.valid_from,
      e.valid_to
    FROM kg_edges e
    JOIN kg_nodes sn ON sn.id = e.subject_id
    LEFT JOIN kg_nodes onode ON onode.id = e.object_id
    WHERE e.id IN (SELECT value FROM json_each(${JSON.stringify([...edgeIds])}))
      AND e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
  `.execute(db);

  return rows.rows.map((row) => toFact(row, nowSec));
}

/**
 * Currently-valid facts for named entities (attached during context assembly).
 */
export async function loadCurrentFactsForEntities(
  db: Kysely<Database>,
  entityNames: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<KgFact[]> {
  if (entityNames.length === 0) {
    return [];
  }

  const names = entityNames.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) {
    return [];
  }

  const rows = await sql<{
    edge_id: string;
    subject_id: string;
    subject_name: string;
    relation_label: string;
    object_id: string | null;
    object_literal: string | null;
    object_name: string | null;
    valid_from: number;
    valid_to: number;
  }>`
    SELECT
      e.id AS edge_id,
      e.subject_id,
      sn.canonical_name AS subject_name,
      e.relation_label,
      e.object_id,
      e.object_literal,
      onode.canonical_name AS object_name,
      e.valid_from,
      e.valid_to
    FROM kg_edges e
    JOIN kg_nodes sn ON sn.id = e.subject_id
    LEFT JOIN kg_nodes onode ON onode.id = e.object_id
    WHERE e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
      AND (
        sn.canonical_name IN (SELECT value FROM json_each(${JSON.stringify(names)}))
        OR EXISTS (
          SELECT 1 FROM json_each(sn.aliases) AS a
          WHERE a.value IN (SELECT value FROM json_each(${JSON.stringify(names)}))
        )
      )
  `.execute(db);

  return rows.rows.map((row) => toFact(row, nowSec));
}

function toFact(
  row: {
    edge_id: string;
    subject_id: string;
    subject_name: string;
    relation_label: string;
    object_id: string | null;
    object_literal: string | null;
    object_name: string | null;
    valid_from: number;
    valid_to: number;
  },
  nowSec: number,
): KgFact {
  return {
    edgeId: row.edge_id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    relationLabel: row.relation_label,
    objectId: row.object_id,
    objectName: row.object_name,
    objectLiteral: row.object_literal,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isCurrent: isCurrentlyValid(row.valid_from, row.valid_to, nowSec),
  };
}
