/**
 * Far-future sentinel for open `kg_edges.valid_to` values.
 *
 * Unix epoch seconds for 9999-01-01T00:00:00Z.
 * Open edges MUST use this constant — never NULL — so every temporal query
 * is a uniform `valid_from <= :now AND :now < valid_to` (design doc §2.3).
 */
export const VALID_TO_OPEN_SENTINEL = 253370764800;
