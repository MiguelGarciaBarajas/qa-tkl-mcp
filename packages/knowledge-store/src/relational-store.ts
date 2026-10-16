import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CanonicalEntity,
  Claim,
  ClaimReviewInput,
  ConflictReviewInput,
  ConflictRecord,
  KnowledgeReviewRecord,
  NormalizationResult,
  TraceLink,
} from "@tkl/contracts";
import type { KnowledgeStore, KnowledgeInventorySummary } from "./store.ts";
import type { KnowledgeStoreHistoryEntry } from "./persistent-store.ts";

const DATABASE_SCHEMA_VERSION = 3;
export const SERVING_PROJECTION_VERSION = 1;
const DEFAULT_PROJECTION_BATCH_SIZE = 100;
const MAX_PROJECTION_BATCH_SIZE = 500;
const DATABASE_FILE_NAME = "knowledge-store.sqlite";
const LEGACY_STORE_FILE_NAME = "knowledge-store.json";
const LEGACY_STORE_SCHEMA_VERSION = 3;
const LEGACY_MIGRATION_KEY = "legacy-json-v3-migration";
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RelationalKnowledgeStoreOptions {
  dataDirectory: string;
  tenantId: string;
  productId: string;
  now?: () => string;
  busyTimeoutMs?: number;
}

export interface EntitySearchOptions {
  productId: string;
  source?: string;
  query: string;
  limit: number;
  offset?: number;
}

export interface ServingProjectionDrainResult {
  attempted: number;
  projected: number;
  remaining: number;
  version: number;
}

export interface ServingProjectionRebuildOptions {
  batchSize?: number;
  cursor?: number;
}

export interface ServingProjectionRebuildResult {
  processed: number;
  nextCursor?: number;
  done: boolean;
  remaining: number;
  version: number;
}

export interface RelationalKnowledgeStore extends KnowledgeStore {
  history(): KnowledgeStoreHistoryEntry[];
  searchEntities(options: EntitySearchOptions): CanonicalEntity[];
  pendingServingProjectionCount(): number;
  inventorySummary(): KnowledgeInventorySummary;
  drainServingProjections(options?: { limit?: number }): ServingProjectionDrainResult;
  refreshServingProjections(options?: { limit?: number }): ServingProjectionDrainResult;
  rebuildServingProjections(
    options?: ServingProjectionRebuildOptions,
  ): ServingProjectionRebuildResult;
  close(): void;
}

/**
 * Synchronous relational implementation for local/default deployments.
 *
 * The exported relational interface preserves the adapter boundary so a future
 * PostgreSQL implementation can keep the same KnowledgeStore semantics without
 * treating SQLite as PostgreSQL.
 */
export class SqliteKnowledgeStore implements RelationalKnowledgeStore {
  readonly storagePath: string;
  readonly legacyStoragePath: string;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly now: () => string;
  private readonly database: DatabaseSync;
  private readonly statements = new Map<
    string,
    ReturnType<DatabaseSync["prepare"]>
  >();
  private closed = false;
  private transactionDepth = 0;
  private ftsTokenizer: "trigram" | "unicode61" | undefined;

  constructor(options: RelationalKnowledgeStoreOptions) {
    assertScopeId("tenantId", options.tenantId);
    assertScopeId("productId", options.productId);
    if (typeof options.dataDirectory !== "string" || !options.dataDirectory.trim()) {
      throw new TypeError("dataDirectory must not be empty");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new TypeError("busyTimeoutMs must be a non-negative integer");
    }

    this.tenantId = options.tenantId;
    this.productId = options.productId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.storagePath = join(options.dataDirectory, DATABASE_FILE_NAME);
    this.legacyStoragePath = join(
      options.dataDirectory,
      this.tenantId,
      this.productId,
      LEGACY_STORE_FILE_NAME,
    );
    mkdirSync(options.dataDirectory, { recursive: true });

    this.database = new DatabaseSync(this.storagePath);
    try {
      this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.initializeSchema();
      this.migrateLegacySnapshot();
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.statements.clear();
    this.database.close();
    this.closed = true;
  }

  upsert(result: Partial<NormalizationResult>): void {
    this.mutate("upsert", () => this.upsertRecords(result));
  }

  addEntity(entity: CanonicalEntity): void {
    this.assertEntityScope(entity);
    this.mutate("add-entity", () => this.upsertEntity(entity));
  }

  getEntity(id: string): CanonicalEntity | undefined {
    const row = this.prepare(`
      SELECT data_json
      FROM entities
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, id);
    return row ? parseData<CanonicalEntity>(row) : undefined;
  }

  findBySource(sourceId: string): CanonicalEntity[] {
    return this.prepare(`
      SELECT DISTINCT e.data_json, e.sequence
      FROM entities e
      JOIN provenance p
        ON p.tenant_id = e.tenant_id
       AND p.product_id = e.product_id
       AND p.owner_type = 'entity'
       AND p.owner_id = e.id
      WHERE e.tenant_id = ? AND e.product_id = ? AND p.source_id = ?
      ORDER BY e.sequence
    `).all(this.tenantId, this.productId, sourceId).map(parseData<CanonicalEntity>);
  }

  listEntities(productId: string): CanonicalEntity[] {
    if (productId !== this.productId) return [];
    return this.prepare(`
      SELECT data_json
      FROM entities
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all(this.tenantId, productId).map(parseData<CanonicalEntity>);
  }

  searchEntities({
    productId,
    source,
    query,
    limit,
    offset = 0,
  }: EntitySearchOptions): CanonicalEntity[] {
    if (productId !== this.productId) return [];
    assertPageValue("limit", limit, 1);
    assertPageValue("offset", offset, 0);
    const normalizedQuery = query.trim().toLowerCase();
    if (this.pendingServingProjectionCount() > 0) {
      return this.searchCanonicalEntities(source, normalizedQuery, limit, offset);
    }
    if (normalizedQuery.length === 0) {
      return this.searchProjectedEntities(source, undefined, undefined, limit, offset);
    }
    if (this.ftsTokenizer === "trigram" && normalizedQuery.length >= 3) {
      return this.searchProjectedEntities(
        source,
        `"${normalizedQuery.replaceAll('"', '""')}"`,
        normalizedQuery,
        limit,
        offset,
      );
    }
    return this.searchProjectedEntitiesWithSubstring(
      source,
      normalizedQuery,
      limit,
      offset,
    );
  }

  pendingServingProjectionCount(): number {
    const row = this.prepare(`
      SELECT COUNT(*) AS count
      FROM serving_projection_outbox
      WHERE tenant_id = ? AND product_id = ?
    `).get(this.tenantId, this.productId) as { count: number };
    return Number(row.count);
  }

  /**
   * Aggregate-only inventory snapshot for one tenant/product scope, computed entirely
   * with indexed COUNT/GROUP BY queries. No entity, claim, trace-link, review, or payload
   * body is materialized, so this stays bounded on a large store. Coverage buckets use the
   * same trust signal as `@tkl/analyzer-coverage`: a requirement/story counts as manually
   * or automatically mapped only through an explicit-origin `verifies` trace link
   * (automation also credited via a manual test's explicit `relates_to` link to a `test`).
   */
  inventorySummary(): KnowledgeInventorySummary {
    const entityRows = this.prepare(`
      SELECT type, COUNT(*) AS count
      FROM entities
      WHERE tenant_id = ? AND product_id = ?
      GROUP BY type
    `).all(this.tenantId, this.productId) as Array<{ type: string; count: number }>;
    const claimRows = this.prepare(`
      SELECT status, COUNT(*) AS count
      FROM claims
      WHERE tenant_id = ? AND product_id = ?
      GROUP BY status
    `).all(this.tenantId, this.productId) as Array<{ status: string; count: number }>;
    const traceLinkRows = this.prepare(`
      SELECT type, COUNT(*) AS count
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ?
      GROUP BY type
    `).all(this.tenantId, this.productId) as Array<{ type: string; count: number }>;
    const deferredRow = this.prepare(`
      SELECT COUNT(*) AS count
      FROM deferred_trace_links
      WHERE tenant_id = ? AND product_id = ?
    `).get(this.tenantId, this.productId) as { count: number };
    const conflictRows = this.prepare(`
      SELECT status, COUNT(*) AS count
      FROM conflicts
      WHERE tenant_id = ? AND product_id = ?
      GROUP BY status
    `).all(this.tenantId, this.productId) as Array<{ status: string; count: number }>;
    const reviewRow = this.prepare(`
      SELECT COUNT(*) AS count
      FROM reviews
      WHERE tenant_id = ? AND product_id = ?
    `).get(this.tenantId, this.productId) as { count: number };
    const provenanceRows = this.prepare(`
      SELECT source, COUNT(DISTINCT owner_id) AS count
      FROM provenance
      WHERE tenant_id = ? AND product_id = ? AND owner_type = 'entity'
      GROUP BY source
      ORDER BY source
    `).all(this.tenantId, this.productId) as Array<{ source: string; count: number }>;

    const coverageRow = this.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(has_manual), 0) AS with_manual,
        COALESCE(SUM(has_automation), 0) AS with_automation,
        COALESCE(SUM(CASE WHEN has_manual = 1 AND has_automation = 1 THEN 1 ELSE 0 END), 0)
          AS with_both,
        COALESCE(SUM(CASE WHEN has_manual = 0 AND has_automation = 0 THEN 1 ELSE 0 END), 0)
          AS with_neither
      FROM (
        SELECT
          r.id,
          (CASE WHEN EXISTS (
            SELECT 1 FROM trace_links tl
            JOIN entities te
              ON te.tenant_id = tl.tenant_id AND te.product_id = tl.product_id
             AND te.id = tl.from_entity_id
            WHERE tl.tenant_id = r.tenant_id AND tl.product_id = r.product_id
              AND tl.to_entity_id = r.id AND tl.type = 'verifies' AND tl.origin = 'explicit'
              AND te.type = 'manual-test'
          ) THEN 1 ELSE 0 END) AS has_manual,
          (CASE WHEN EXISTS (
            SELECT 1 FROM trace_links tl
            JOIN entities te
              ON te.tenant_id = tl.tenant_id AND te.product_id = tl.product_id
             AND te.id = tl.from_entity_id
            WHERE tl.tenant_id = r.tenant_id AND tl.product_id = r.product_id
              AND tl.to_entity_id = r.id AND tl.type = 'verifies' AND tl.origin = 'explicit'
              AND te.type = 'test'
          ) OR EXISTS (
            SELECT 1 FROM trace_links tl
            JOIN entities mt
              ON mt.tenant_id = tl.tenant_id AND mt.product_id = tl.product_id
             AND mt.id = tl.from_entity_id AND mt.type = 'manual-test'
            JOIN trace_links rel
              ON rel.tenant_id = tl.tenant_id AND rel.product_id = tl.product_id
             AND rel.from_entity_id = mt.id AND rel.type = 'relates_to'
             AND rel.origin = 'explicit'
            JOIN entities at
              ON at.tenant_id = rel.tenant_id AND at.product_id = rel.product_id
             AND at.id = rel.to_entity_id AND at.type = 'test'
            WHERE tl.tenant_id = r.tenant_id AND tl.product_id = r.product_id
              AND tl.to_entity_id = r.id AND tl.type = 'verifies' AND tl.origin = 'explicit'
          ) THEN 1 ELSE 0 END) AS has_automation
        FROM entities r
        WHERE r.tenant_id = ? AND r.product_id = ? AND r.type IN ('requirement', 'story')
      )
    `).get(this.tenantId, this.productId) as {
      total: number;
      with_manual: number;
      with_automation: number;
      with_both: number;
      with_neither: number;
    };

    const unmappedRow = this.prepare(`
      SELECT COUNT(*) AS count
      FROM entities t
      WHERE t.tenant_id = ? AND t.product_id = ?
        AND t.type IN ('test', 'manual-test')
        AND NOT EXISTS (
          SELECT 1 FROM trace_links tl
          WHERE tl.tenant_id = t.tenant_id AND tl.product_id = t.product_id
            AND tl.from_entity_id = t.id AND tl.type = 'verifies' AND tl.origin = 'explicit'
        )
    `).get(this.tenantId, this.productId) as { count: number };

    const verifyRow = this.prepare(`
      SELECT COUNT(*) AS count, AVG(confidence) AS average
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ? AND type = 'verifies' AND origin = 'explicit'
    `).get(this.tenantId, this.productId) as { count: number; average: number | null };

    return {
      entities: {
        total: sumCounts(entityRows),
        byType: toCountMap(entityRows, "type"),
      },
      claims: {
        total: sumCounts(claimRows),
        byStatus: toCountMap(claimRows, "status"),
      },
      traceLinks: {
        total: sumCounts(traceLinkRows),
        deferred: Number(deferredRow.count),
        byType: toCountMap(traceLinkRows, "type"),
      },
      conflicts: {
        total: sumCounts(conflictRows),
        open: Number(
          conflictRows.find((row) => row.status === "open")?.count ?? 0,
        ),
      },
      reviews: { total: Number(reviewRow.count) },
      canonicalSourceProvenance: provenanceRows.map((row) => ({
        source: row.source,
        entityCount: Number(row.count),
      })),
      coverage: {
        requirementTotal: Number(coverageRow.total),
        withManual: Number(coverageRow.with_manual),
        withAutomation: Number(coverageRow.with_automation),
        withBoth: Number(coverageRow.with_both),
        withNeither: Number(coverageRow.with_neither),
        unmappedTests: Number(unmappedRow.count),
        verifyLinkTotal: Number(verifyRow.count),
        averageVerifyLinkConfidence:
          verifyRow.average === null ? null : Number(verifyRow.average),
      },
      pendingServingProjections: this.pendingServingProjectionCount(),
    };
  }

  drainServingProjections(
    { limit = DEFAULT_PROJECTION_BATCH_SIZE }: { limit?: number } = {},
  ): ServingProjectionDrainResult {
    assertProjectionBatchSize(limit);
    const pending = this.prepare(`
      SELECT id, entity_id AS entityId
      FROM serving_projection_outbox
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY id
      LIMIT ?
    `).all(
      this.tenantId,
      this.productId,
      limit,
    ) as Array<{ id: number; entityId: string }>;
    if (pending.length === 0) {
      return {
        attempted: 0,
        projected: 0,
        remaining: this.pendingServingProjectionCount(),
        version: SERVING_PROJECTION_VERSION,
      };
    }

    try {
      this.withTransaction(() => {
        for (const item of pending) {
          const entity = this.getEntity(item.entityId);
          if (entity) this.projectServingEntity(entity);
          else this.deleteServingProjection(item.entityId);
          this.prepare(`
            DELETE FROM serving_projection_outbox
            WHERE tenant_id = ? AND product_id = ? AND id = ?
          `).run(this.tenantId, this.productId, item.id);
        }
      });
    } catch (error) {
      try {
        this.recordProjectionFailure(pending.map((item) => item.id), error);
      } catch {
        // The original failure is authoritative; the durable outbox rows remain pending.
      }
      throw error;
    }

    return {
      attempted: pending.length,
      projected: pending.length,
      remaining: this.pendingServingProjectionCount(),
      version: SERVING_PROJECTION_VERSION,
    };
  }

  refreshServingProjections(
    options: { limit?: number } = {},
  ): ServingProjectionDrainResult {
    return this.drainServingProjections(options);
  }

  rebuildServingProjections({
    batchSize = DEFAULT_PROJECTION_BATCH_SIZE,
    cursor = 0,
  }: ServingProjectionRebuildOptions = {}): ServingProjectionRebuildResult {
    assertProjectionBatchSize(batchSize);
    assertPageValue("cursor", cursor, 0);
    let processed = 0;
    let nextCursor: number | undefined;
    let done = false;

    this.withTransaction(() => {
      const rows = this.prepare(`
        SELECT data_json, sequence
        FROM entities
        WHERE tenant_id = ? AND product_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `).all(
        this.tenantId,
        this.productId,
        cursor,
        batchSize + 1,
      ) as Array<{ data_json: string; sequence: number }>;
      const batch = rows.slice(0, batchSize);
      for (const row of batch) {
        const entity = parseData<CanonicalEntity>(row);
        this.projectServingEntity(entity);
        this.acknowledgeEntityProjection(entity.id);
      }
      processed = batch.length;
      nextCursor = batch.at(-1)?.sequence;
      done = rows.length <= batchSize;
      if (done) {
        this.prepare(`
          DELETE FROM serving_entity_search
          WHERE tenant_id = ? AND product_id = ?
            AND (
              projection_version <> ?
              OR NOT EXISTS (
                SELECT 1
                FROM entities e
                WHERE e.tenant_id = serving_entity_search.tenant_id
                  AND e.product_id = serving_entity_search.product_id
                  AND e.id = serving_entity_search.entity_id
              )
            )
        `).run(this.tenantId, this.productId, SERVING_PROJECTION_VERSION);
      }
    });

    return {
      processed,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      done,
      remaining: this.pendingServingProjectionCount(),
      version: SERVING_PROJECTION_VERSION,
    };
  }

  addClaim(claim: Claim): void {
    this.mutate("add-claim", () => this.upsertClaim(claim));
  }

  listClaims(): Claim[] {
    return this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all(this.tenantId, this.productId).map(parseData<Claim>);
  }

  getClaims(entityId: string): Claim[] {
    return this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND entity_id = ?
      ORDER BY sequence
    `).all(this.tenantId, this.productId, entityId).map(parseData<Claim>);
  }

  getApprovedClaims(entityId: string): Claim[] {
    return this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND entity_id = ? AND status = 'approved'
      ORDER BY sequence
    `).all(this.tenantId, this.productId, entityId).map(parseData<Claim>);
  }

  addTraceLink(link: TraceLink): void {
    this.mutate("add-trace-link", () => this.upsertTraceLink(link));
  }

  listTraceLinks(): TraceLink[] {
    return this.prepare(`
      SELECT data_json
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all(this.tenantId, this.productId).map(parseData<TraceLink>);
  }

  getTraceLinks(entityId: string): TraceLink[] {
    return this.prepare(`
      SELECT data_json
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ?
        AND (
          from_entity_id = ?
          OR to_entity_id = ?
          OR json_extract(data_json, '$.from') = ?
          OR json_extract(data_json, '$.to') = ?
        )
      ORDER BY sequence
    `).all(
      this.tenantId,
      this.productId,
      entityId,
      entityId,
      entityId,
      entityId,
    ).map(parseData<TraceLink>);
  }

  findLinks(sourceId: string): TraceLink[] {
    return this.prepare(`
      SELECT DISTINCT l.data_json, l.sequence
      FROM trace_links l
      LEFT JOIN provenance p
        ON p.tenant_id = l.tenant_id
       AND p.product_id = l.product_id
       AND p.owner_type = 'trace-link'
       AND p.owner_id = l.id
      WHERE l.tenant_id = ? AND l.product_id = ?
        AND (
          p.source_id = ?
          OR json_extract(l.data_json, '$.from') = ?
          OR json_extract(l.data_json, '$.to') = ?
        )
      ORDER BY l.sequence
    `).all(
      this.tenantId,
      this.productId,
      sourceId,
      sourceId,
      sourceId,
    ).map(parseData<TraceLink>);
  }

  addConflict(conflict: ConflictRecord): void {
    this.mutate("add-conflict", () => this.upsertConflict(conflict));
  }

  listOpenConflicts(entityId?: string): ConflictRecord[] {
    const rows = entityId
      ? this.prepare(`
          SELECT data_json
          FROM conflicts
          WHERE tenant_id = ? AND product_id = ? AND status = 'open' AND entity_id = ?
          ORDER BY sequence
        `).all(this.tenantId, this.productId, entityId)
      : this.prepare(`
          SELECT data_json
          FROM conflicts
          WHERE tenant_id = ? AND product_id = ? AND status = 'open'
          ORDER BY sequence
        `).all(this.tenantId, this.productId);
    return rows.map(parseData<ConflictRecord>);
  }

  conflicts(): Array<Claim | ConflictRecord> {
    const claims = this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND status = 'conflict'
      ORDER BY sequence
    `).all(this.tenantId, this.productId).map(parseData<Claim>);
    return [...claims, ...this.listOpenConflicts()];
  }

  reviewClaim(input: ClaimReviewInput): KnowledgeReviewRecord {
    assertReviewer(input.reviewerId, input.reviewedAt, input.note);
    return this.mutate("review-claim", () => {
      const row = this.prepare(`
        SELECT data_json
        FROM claims
        WHERE tenant_id = ? AND product_id = ? AND id = ?
      `).get(this.tenantId, this.productId, input.claimId);
      if (!row) throw new Error(`Claim ${input.claimId} does not exist`);
      const claim = parseData<Claim>(row);
      const openConflict = this.prepare(`
        SELECT c.id
        FROM conflicts c
        JOIN conflict_claims cc
          ON cc.tenant_id = c.tenant_id
         AND cc.product_id = c.product_id
         AND cc.conflict_id = c.id
        WHERE c.tenant_id = ? AND c.product_id = ?
          AND c.status = 'open' AND cc.claim_id = ?
        LIMIT 1
      `).get(this.tenantId, this.productId, claim.id) as { id: string } | undefined;
      if (openConflict) {
        throw new Error(
          `Claim ${claim.id} belongs to open conflict ${openConflict.id}; review the conflict instead`,
        );
      }

      this.updateClaimStatus(claim, input.decision);
      const review = createReview({
        entityId: claim.entityId,
        targetType: "claim",
        targetId: claim.id,
        decision: input.decision,
        reviewerId: input.reviewerId,
        reviewedAt: input.reviewedAt,
        note: normalizedNote(input.note),
      });
      this.upsertReview(review);
      return review;
    });
  }

  reviewConflict(input: ConflictReviewInput): KnowledgeReviewRecord {
    assertReviewer(input.reviewerId, input.reviewedAt, input.note);
    return this.mutate("review-conflict", () => {
      const row = this.prepare(`
        SELECT data_json
        FROM conflicts
        WHERE tenant_id = ? AND product_id = ? AND id = ?
      `).get(this.tenantId, this.productId, input.conflictId);
      if (!row) throw new Error(`Conflict ${input.conflictId} does not exist`);
      const conflict = parseData<ConflictRecord>(row);
      if (conflict.status !== "open") {
        throw new Error(`Conflict ${conflict.id} has already been reviewed`);
      }

      const approvedClaimIds = [...new Set(input.approvedClaimIds)];
      if (approvedClaimIds.length === 0) {
        throw new TypeError("A conflict review must approve at least one claim");
      }
      const unknownClaimId = approvedClaimIds.find((id) => !conflict.claimIds.includes(id));
      if (unknownClaimId) {
        throw new TypeError(
          `Claim ${unknownClaimId} does not belong to conflict ${conflict.id}`,
        );
      }

      const claims = conflict.claimIds.map((claimId) => {
        const claimRow = this.prepare(`
          SELECT data_json
          FROM claims
          WHERE tenant_id = ? AND product_id = ? AND id = ?
        `).get(this.tenantId, this.productId, claimId);
        const claim = claimRow ? parseData<Claim>(claimRow) : undefined;
        if (!claim || claim.entityId !== conflict.entityId) {
          throw new Error(
            `Conflict ${conflict.id} references missing or mismatched claim ${claimId}`,
          );
        }
        return claim;
      });

      for (const claim of claims) {
        this.updateClaimStatus(
          claim,
          approvedClaimIds.includes(claim.id) ? "approved" : "rejected",
        );
      }
      this.updateConflictStatus(conflict, "reviewed");
      const review = createReview({
        entityId: conflict.entityId,
        targetType: "conflict",
        targetId: conflict.id,
        decision: "resolved",
        approvedClaimIds,
        reviewerId: input.reviewerId,
        reviewedAt: input.reviewedAt,
        note: normalizedNote(input.note),
      });
      this.upsertReview(review);
      return review;
    });
  }

  listReviews(entityId?: string): KnowledgeReviewRecord[] {
    const rows = entityId
      ? this.prepare(`
          SELECT data_json
          FROM reviews
          WHERE tenant_id = ? AND product_id = ? AND entity_id = ?
          ORDER BY sequence
        `).all(this.tenantId, this.productId, entityId)
      : this.prepare(`
          SELECT data_json
          FROM reviews
          WHERE tenant_id = ? AND product_id = ?
          ORDER BY sequence
        `).all(this.tenantId, this.productId);
    return rows.map(parseData<KnowledgeReviewRecord>);
  }

  history(): KnowledgeStoreHistoryEntry[] {
    return this.prepare(`
      SELECT id, operation, recorded_at AS recordedAt
      FROM operation_history
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all(this.tenantId, this.productId).map((row) => {
      const entry = row as {
        id: string;
        operation: KnowledgeStoreHistoryEntry["operation"];
        recordedAt: string;
      };
      return {
        id: entry.id,
        operation: entry.operation,
        recordedAt: entry.recordedAt,
      };
    });
  }

  protected upsertWithDeferredTraceLinks(
    result: Partial<NormalizationResult>,
    maxPendingTraceLinks: number,
  ): void {
    this.mutate("upsert", () => {
      const incomingEntityIds = new Set(
        (result.entities ?? []).map((entity) => entity.id),
      );
      const endpointExists = (entityId: string) =>
        incomingEntityIds.has(entityId) || Boolean(this.getEntity(entityId));
      const projectedPending = new Map(
        this.persistedDeferredTraceLinks().map((link) => [link.id, link]),
      );
      const resolvedTraceLinks: TraceLink[] = [];

      for (const [linkId, link] of projectedPending) {
        if (endpointExists(link.fromEntityId) && endpointExists(link.toEntityId)) {
          resolvedTraceLinks.push(link);
          projectedPending.delete(linkId);
        }
      }
      for (const link of result.traceLinks ?? []) {
        if (endpointExists(link.fromEntityId) && endpointExists(link.toEntityId)) {
          resolvedTraceLinks.push(link);
          projectedPending.delete(link.id);
        } else {
          projectedPending.set(link.id, link);
        }
      }
      if (projectedPending.size > maxPendingTraceLinks) {
        throw new Error(`Pending trace link limit of ${maxPendingTraceLinks} exceeded`);
      }

      this.replaceDeferredTraceLinks(projectedPending.values());
      this.upsertRecords({ ...result, traceLinks: resolvedTraceLinks });
    });
  }

  protected persistedDeferredTraceLinks(): TraceLink[] {
    return this.prepare(`
      SELECT data_json
      FROM deferred_trace_links
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all(this.tenantId, this.productId).map(parseData<TraceLink>);
  }

  protected addEntityWithDeferredTraceLinks(
    entity: CanonicalEntity,
  ): void {
    this.assertEntityScope(entity);
    this.mutate("add-entity", () => {
      this.upsertEntity(entity);
      const resolvedTraceLinks: TraceLink[] = [];
      const deferredTraceLinks: TraceLink[] = [];
      for (const link of this.persistedDeferredTraceLinks()) {
        const endpointsExist = this.getEntity(link.fromEntityId)
          && this.getEntity(link.toEntityId);
        if (endpointsExist) resolvedTraceLinks.push(link);
        else deferredTraceLinks.push(link);
      }
      this.replaceDeferredTraceLinks(deferredTraceLinks);
      for (const link of resolvedTraceLinks) this.upsertTraceLink(link);
    });
  }

  protected addTraceLinkWithDeferredTraceLinks(
    link: TraceLink,
    maxPendingTraceLinks: number,
  ): void {
    this.mutate("add-trace-link", () => {
      const projectedPending = new Map(
        this.persistedDeferredTraceLinks().map((pending) => [pending.id, pending]),
      );
      const endpointsExist = this.getEntity(link.fromEntityId)
        && this.getEntity(link.toEntityId);
      if (endpointsExist) {
        projectedPending.delete(link.id);
        this.replaceDeferredTraceLinks(projectedPending.values());
        this.upsertTraceLink(link);
        return;
      }
      if (!projectedPending.has(link.id) && projectedPending.size >= maxPendingTraceLinks) {
        throw new Error(`Pending trace link limit of ${maxPendingTraceLinks} exceeded`);
      }
      projectedPending.set(link.id, link);
      this.replaceDeferredTraceLinks(projectedPending.values());
    });
  }

  protected flushDeferredTraceLinks(): void {
    this.withTransaction(() => {
      const remaining: TraceLink[] = [];
      const resolved: TraceLink[] = [];
      for (const link of this.persistedDeferredTraceLinks()) {
        const endpointsExist = this.getEntity(link.fromEntityId)
          && this.getEntity(link.toEntityId);
        if (endpointsExist) resolved.push(link);
        else remaining.push(link);
      }
      if (resolved.length === 0) return;
      this.replaceDeferredTraceLinks(remaining);
      for (const link of resolved) this.upsertTraceLink(link);
      this.appendHistory("upsert");
    });
  }

  private initializeSchema(): void {
    const current = Number(
      (this.database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (current > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Knowledge database schema ${current} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
      );
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(SCHEMA_SQL);
      const claimColumns = this.database.prepare("PRAGMA table_info(claims)").all() as Array<{
        name: string;
      }>;
      if (!claimColumns.some((column) => column.name === "base_id")) {
        this.database.exec("ALTER TABLE claims ADD COLUMN base_id TEXT");
      }
      const claimsMissingBaseId = this.database.prepare(`
        SELECT tenant_id, product_id, id, version_key
        FROM claims
        WHERE base_id IS NULL OR base_id = ''
      `).all() as Array<{
        tenant_id: string;
        product_id: string;
        id: string;
        version_key: string;
      }>;
      const updateBaseId = this.database.prepare(`
        UPDATE claims
        SET base_id = ?
        WHERE tenant_id = ? AND product_id = ? AND id = ?
      `);
      for (const row of claimsMissingBaseId) {
        updateBaseId.run(
          baseClaimIdFromStoredId(row.id, row.version_key),
          row.tenant_id,
          row.product_id,
          row.id,
        );
      }
      this.database.exec(CLAIM_BASE_ID_INDEX_SQL);
      this.initializeFtsProjection();
      if (current < DATABASE_SCHEMA_VERSION) {
        this.database.prepare(`
          INSERT INTO serving_projection_outbox(
            tenant_id, product_id, entity_id, projection_version, enqueued_at
          )
          SELECT tenant_id, product_id, id, ?, ?
          FROM entities
          WHERE true
          ON CONFLICT(tenant_id, product_id, entity_id, projection_version)
          DO UPDATE SET
            enqueued_at = excluded.enqueued_at,
            attempt_count = 0,
            last_attempt_at = NULL,
            last_error = NULL
        `).run(SERVING_PROJECTION_VERSION, this.now());
      }
      this.database.prepare(`
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (?, ?)
        ON CONFLICT(version) DO NOTHING
      `).run(DATABASE_SCHEMA_VERSION, this.now());
      this.database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      this.database.exec("COMMIT");
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  private migrateLegacySnapshot(): void {
    if (!existsSync(this.legacyStoragePath)) return;
    const alreadyMigrated = this.prepare(`
      SELECT 1
      FROM store_metadata
      WHERE tenant_id = ? AND product_id = ? AND key = ?
    `).get(this.tenantId, this.productId, LEGACY_MIGRATION_KEY);
    if (alreadyMigrated) return;

    const snapshot = parseLegacySnapshot(readFileSync(this.legacyStoragePath, "utf-8"));
    assertSnapshotScope(snapshot, this.tenantId, this.productId);
    this.withTransaction(() => {
      const marker = this.prepare(`
        SELECT 1
        FROM store_metadata
        WHERE tenant_id = ? AND product_id = ? AND key = ?
      `).get(this.tenantId, this.productId, LEGACY_MIGRATION_KEY);
      if (marker) return;

      for (const entity of snapshot.entities) this.upsertEntity(entity);
      for (const claim of snapshot.claims) {
        this.upsertClaim(
          claim,
          baseClaimIdFromStoredId(claim.id, [
            claimVersionKey(claim),
            legacyClaimVersionKey(claim),
          ]),
          true,
        );
      }
      for (const link of snapshot.traceLinks) this.upsertTraceLink(link);
      this.replaceDeferredTraceLinks(snapshot.deferredTraceLinks);
      for (const conflict of snapshot.conflicts) this.upsertConflict(conflict);
      for (const review of snapshot.reviews) this.upsertReview(review);
      for (const entry of snapshot.history) this.upsertHistory(entry);

      this.prepare(`
        INSERT INTO store_metadata(tenant_id, product_id, key, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, product_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(
        this.tenantId,
        this.productId,
        LEGACY_MIGRATION_KEY,
        JSON.stringify({
          sourcePath: this.legacyStoragePath,
          sourceSchemaVersion: snapshot.schemaVersion,
          sourceRevision: snapshot.revision,
        }),
        this.now(),
      );
    });
  }

  private upsertRecords(result: Partial<NormalizationResult>): void {
    for (const entity of result.entities ?? []) {
      this.assertEntityScope(entity);
      this.upsertEntity(entity);
    }
    for (const claim of result.claims ?? []) this.upsertClaim(claim);
    for (const link of result.traceLinks ?? []) this.upsertTraceLink(link);
  }

  private upsertEntity(entity: CanonicalEntity): void {
    this.assertEntityScope(entity);
    const sequence = this.existingSequence("entities", entity.id)
      ?? this.nextSequence("entities");
    this.prepare(`
      INSERT INTO entities(
        tenant_id, product_id, id, type, title, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      entity.id,
      entity.type,
      entity.title,
      JSON.stringify(entity),
      sequence,
    );
    this.replaceProvenance("entity", entity.id, entity.provenance);
    this.enqueueServingProjection(entity.id);
  }

  private upsertClaim(
    claim: Claim,
    baseId = claim.id,
    preserveStorageId = false,
  ): void {
    this.assertEntityExists(claim.entityId, `Claim ${claim.id}`);
    const candidateRows = this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND base_id = ?
      ORDER BY sequence
    `).all(
      this.tenantId,
      this.productId,
      baseId,
    );
    const equivalent = candidateRows
      .map(parseData<Claim>)
      .find((existing) => sameClaimVersion(existing, claim));
    let storedClaim = equivalent
      ? {
          ...claim,
          id: equivalent.id,
          status:
            claim.status === "pending"
            && (equivalent.status === "approved" || equivalent.status === "rejected")
              ? equivalent.status
              : claim.status,
        }
      : {
          ...claim,
          id: preserveStorageId
            ? claim.id
            : candidateRows.length > 0
            ? `${baseId}@${claimVersionKey(claim)}`
            : baseId,
        };
    let collision = this.prepare(`
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, storedClaim.id);
    if (
      preserveStorageId
      && collision
      && !sameClaimVersion(parseData<Claim>(collision), storedClaim)
    ) {
      storedClaim = {
        ...storedClaim,
        id: `${baseId}@${claimVersionKey(claim)}`,
      };
      collision = this.prepare(`
        SELECT data_json
        FROM claims
        WHERE tenant_id = ? AND product_id = ? AND id = ?
      `).get(this.tenantId, this.productId, storedClaim.id);
    }
    if (collision && !sameClaimVersion(parseData<Claim>(collision), storedClaim)) {
      throw new Error(`Claim version key collision for ${storedClaim.id}`);
    }

    const sequence = this.existingSequence("claims", storedClaim.id)
      ?? this.nextSequence("claims");
    this.prepare(`
      INSERT INTO claims(
        tenant_id, product_id, id, base_id, entity_id, attribute, value_json,
        origin, confidence, status, version_key, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        base_id = excluded.base_id,
        entity_id = excluded.entity_id,
        attribute = excluded.attribute,
        value_json = excluded.value_json,
        origin = excluded.origin,
        confidence = excluded.confidence,
        status = excluded.status,
        version_key = excluded.version_key,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      storedClaim.id,
      baseId,
      storedClaim.entityId,
      storedClaim.attribute,
      JSON.stringify(storedClaim.value) ?? "null",
      storedClaim.origin,
      storedClaim.confidence,
      storedClaim.status,
      claimVersionKey(storedClaim),
      JSON.stringify(storedClaim),
      sequence,
    );
    this.replaceProvenance("claim", storedClaim.id, storedClaim.provenance);
    this.enqueueServingProjection(storedClaim.entityId);
  }

  private upsertTraceLink(link: TraceLink): void {
    const fromEntity = this.getEntity(link.fromEntityId);
    const toEntity = this.getEntity(link.toEntityId);
    if (!fromEntity || !toEntity) {
      throw new Error(`Trace link ${link.id} requires both endpoint entities`);
    }
    if (
      fromEntity.tenantId !== toEntity.tenantId
      || fromEntity.productId !== toEntity.productId
      || fromEntity.tenantId !== this.tenantId
      || fromEntity.productId !== this.productId
    ) {
      throw new Error(`Trace link ${link.id} cannot cross tenant or product boundaries`);
    }

    const previous = this.prepare(`
      SELECT from_entity_id AS fromEntityId, to_entity_id AS toEntityId
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, link.id) as
      | { fromEntityId: string; toEntityId: string }
      | undefined;
    const sequence = this.existingSequence("trace_links", link.id)
      ?? this.nextSequence("trace_links");
    this.prepare(`
      INSERT INTO trace_links(
        tenant_id, product_id, id, from_entity_id, to_entity_id,
        type, origin, confidence, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        from_entity_id = excluded.from_entity_id,
        to_entity_id = excluded.to_entity_id,
        type = excluded.type,
        origin = excluded.origin,
        confidence = excluded.confidence,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      link.id,
      link.fromEntityId,
      link.toEntityId,
      link.type,
      link.origin,
      link.confidence,
      JSON.stringify(link),
      sequence,
    );
    this.replaceProvenance("trace-link", link.id, link.provenance);
    if (previous) {
      this.enqueueServingProjection(previous.fromEntityId);
      this.enqueueServingProjection(previous.toEntityId);
    }
    this.enqueueServingProjection(link.fromEntityId);
    this.enqueueServingProjection(link.toEntityId);
  }

  private upsertDeferredTraceLink(link: TraceLink): void {
    const resolved = this.prepare(`
      SELECT 1
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, link.id);
    if (resolved) {
      throw new Error(`Deferred trace link ${link.id} is already resolved`);
    }
    const sequence = this.existingSequence("deferred_trace_links", link.id)
      ?? this.nextSequence("deferred_trace_links");
    this.prepare(`
      INSERT INTO deferred_trace_links(
        tenant_id, product_id, id, from_entity_id, to_entity_id,
        type, origin, confidence, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        from_entity_id = excluded.from_entity_id,
        to_entity_id = excluded.to_entity_id,
        type = excluded.type,
        origin = excluded.origin,
        confidence = excluded.confidence,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      link.id,
      link.fromEntityId,
      link.toEntityId,
      link.type,
      link.origin,
      link.confidence,
      JSON.stringify(link),
      sequence,
    );
    this.replaceProvenance("deferred-trace-link", link.id, link.provenance);
  }

  private replaceDeferredTraceLinks(links: Iterable<TraceLink>): void {
    this.prepare(`
      DELETE FROM provenance
      WHERE tenant_id = ? AND product_id = ? AND owner_type = 'deferred-trace-link'
    `).run(this.tenantId, this.productId);
    this.prepare(`
      DELETE FROM deferred_trace_links
      WHERE tenant_id = ? AND product_id = ?
    `).run(this.tenantId, this.productId);
    for (const link of links) this.upsertDeferredTraceLink(link);
  }

  private upsertConflict(conflict: ConflictRecord): void {
    this.assertEntityExists(conflict.entityId, `Conflict ${conflict.id}`);
    const existingRow = this.prepare(`
      SELECT data_json
      FROM conflicts
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, conflict.id);
    if (existingRow) {
      const existing = parseData<ConflictRecord>(existingRow);
      if (existing.status === "reviewed" && sameValues(existing.claimIds, conflict.claimIds)) {
        return;
      }
    }

    const sequence = this.existingSequence("conflicts", conflict.id)
      ?? this.nextSequence("conflicts");
    this.prepare(`
      INSERT INTO conflicts(
        tenant_id, product_id, id, entity_id, reason, detected_at,
        status, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        entity_id = excluded.entity_id,
        reason = excluded.reason,
        detected_at = excluded.detected_at,
        status = excluded.status,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      conflict.id,
      conflict.entityId,
      conflict.reason,
      conflict.detectedAt,
      conflict.status,
      JSON.stringify(conflict),
      sequence,
    );
    this.prepare(`
      DELETE FROM conflict_claims
      WHERE tenant_id = ? AND product_id = ? AND conflict_id = ?
    `).run(this.tenantId, this.productId, conflict.id);
    const statement = this.prepare(`
      INSERT INTO conflict_claims(
        tenant_id, product_id, conflict_id, claim_id, ordinal
      ) VALUES (?, ?, ?, ?, ?)
    `);
    conflict.claimIds.forEach((claimId, ordinal) => {
      statement.run(this.tenantId, this.productId, conflict.id, claimId, ordinal);
    });
  }

  private upsertReview(review: KnowledgeReviewRecord): void {
    const sequence = this.existingSequence("reviews", review.id)
      ?? this.nextSequence("reviews");
    this.prepare(`
      INSERT INTO reviews(
        tenant_id, product_id, id, entity_id, target_type, target_id,
        decision, reviewer_id, reviewed_at, note, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        entity_id = excluded.entity_id,
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        decision = excluded.decision,
        reviewer_id = excluded.reviewer_id,
        reviewed_at = excluded.reviewed_at,
        note = excluded.note,
        data_json = excluded.data_json
    `).run(
      this.tenantId,
      this.productId,
      review.id,
      review.entityId,
      review.targetType,
      review.targetId,
      review.decision,
      review.reviewerId,
      review.reviewedAt,
      review.note ?? null,
      JSON.stringify(review),
      sequence,
    );
    this.prepare(`
      DELETE FROM review_approved_claims
      WHERE tenant_id = ? AND product_id = ? AND review_id = ?
    `).run(this.tenantId, this.productId, review.id);
    const statement = this.prepare(`
      INSERT INTO review_approved_claims(
        tenant_id, product_id, review_id, claim_id, ordinal
      ) VALUES (?, ?, ?, ?, ?)
    `);
    (review.approvedClaimIds ?? []).forEach((claimId, ordinal) => {
      statement.run(this.tenantId, this.productId, review.id, claimId, ordinal);
    });
  }

  private upsertHistory(entry: KnowledgeStoreHistoryEntry): void {
    const existing = this.prepare(`
      SELECT sequence
      FROM operation_history
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, entry.id) as { sequence: number } | undefined;
    const sequence = existing?.sequence ?? this.nextSequence("operation_history");
    this.prepare(`
      INSERT INTO operation_history(
        tenant_id, product_id, id, operation, recorded_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, id) DO UPDATE SET
        operation = excluded.operation,
        recorded_at = excluded.recorded_at
    `).run(
      this.tenantId,
      this.productId,
      entry.id,
      entry.operation,
      entry.recordedAt,
      sequence,
    );
  }

  private updateClaimStatus(
    claim: Claim,
    status: "approved" | "rejected",
  ): void {
    const updated = { ...claim, status };
    this.prepare(`
      UPDATE claims
      SET status = ?, data_json = ?
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).run(status, JSON.stringify(updated), this.tenantId, this.productId, claim.id);
    this.enqueueServingProjection(claim.entityId);
  }

  private updateConflictStatus(
    conflict: ConflictRecord,
    status: "reviewed",
  ): void {
    const updated = { ...conflict, status };
    this.prepare(`
      UPDATE conflicts
      SET status = ?, data_json = ?
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).run(status, JSON.stringify(updated), this.tenantId, this.productId, conflict.id);
  }

  private replaceProvenance(
    ownerType: "entity" | "claim" | "trace-link" | "deferred-trace-link",
    ownerId: string,
    provenance: CanonicalEntity["provenance"] | Claim["provenance"] | TraceLink["provenance"],
  ): void {
    this.prepare(`
      DELETE FROM provenance
      WHERE tenant_id = ? AND product_id = ? AND owner_type = ? AND owner_id = ?
    `).run(this.tenantId, this.productId, ownerType, ownerId);
    const statement = this.prepare(`
      INSERT INTO provenance(
        tenant_id, product_id, owner_type, owner_id, ordinal, source,
        source_id, source_version, content_hash, observed_at,
        normalizer_id, normalizer_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    provenanceEntries(provenance).forEach((item, ordinal) => {
      statement.run(
        this.tenantId,
        this.productId,
        ownerType,
        ownerId,
        ordinal,
        item.source,
        item.sourceId,
        item.sourceVersion,
        item.contentHash,
        item.observedAt,
        item.normalizerId,
        item.normalizerVersion,
      );
    });
  }

  protected projectServingEntity(entity: CanonicalEntity): void {
    const document = this.buildServingDocument(entity);
    const entitySequence = this.existingSequence("entities", entity.id);
    if (entitySequence === undefined) {
      throw new Error(`Cannot project missing entity ${entity.id}`);
    }
    this.prepare(`
      INSERT INTO serving_entity_search(
        tenant_id, product_id, entity_id, entity_type, title,
        searchable_text, data_json, entity_sequence, projection_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, entity_id) DO UPDATE SET
        entity_type = excluded.entity_type,
        title = excluded.title,
        searchable_text = excluded.searchable_text,
        data_json = excluded.data_json,
        entity_sequence = excluded.entity_sequence,
        projection_version = excluded.projection_version,
        updated_at = excluded.updated_at
    `).run(
      this.tenantId,
      this.productId,
      entity.id,
      entity.type,
      entity.title,
      document,
      JSON.stringify(entity),
      entitySequence,
      SERVING_PROJECTION_VERSION,
      this.now(),
    );
  }

  private buildServingDocument(entity: CanonicalEntity): string {
    const values: string[] = [entity.id, entity.type, entity.title];
    collectSearchableValues(entity.metadata, values);
    const claims = this.prepare(`
      SELECT attribute, value_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND entity_id = ?
        AND status <> 'rejected'
      ORDER BY sequence
    `).all(this.tenantId, this.productId, entity.id) as Array<{
      attribute: string;
      value_json: string;
    }>;
    for (const claim of claims) {
      values.push(claim.attribute);
      collectSearchableValues(JSON.parse(claim.value_json), values);
    }
    const provenance = this.prepare(`
      SELECT source, source_id AS sourceId, source_version AS sourceVersion
      FROM provenance
      WHERE tenant_id = ? AND product_id = ?
        AND owner_type = 'entity' AND owner_id = ?
      ORDER BY ordinal
    `).all(this.tenantId, this.productId, entity.id) as Array<{
      source: string;
      sourceId: string;
      sourceVersion: string;
    }>;
    for (const item of provenance) {
      values.push(item.source, item.sourceId, item.sourceVersion);
    }
    const links = this.prepare(`
      SELECT id, type, from_entity_id AS fromEntityId, to_entity_id AS toEntityId
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ?
        AND (from_entity_id = ? OR to_entity_id = ?)
      ORDER BY sequence
    `).all(
      this.tenantId,
      this.productId,
      entity.id,
      entity.id,
    ) as Array<{
      id: string;
      type: string;
      fromEntityId: string;
      toEntityId: string;
    }>;
    for (const link of links) {
      values.push(link.id, link.type, link.fromEntityId, link.toEntityId);
    }
    return values.filter(Boolean).join("\n");
  }

  private enqueueServingProjection(entityId: string): void {
    this.prepare(`
      INSERT INTO serving_projection_outbox(
        tenant_id, product_id, entity_id, projection_version, enqueued_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, product_id, entity_id, projection_version)
      DO UPDATE SET
        enqueued_at = excluded.enqueued_at,
        attempt_count = 0,
        last_attempt_at = NULL,
        last_error = NULL
    `).run(
      this.tenantId,
      this.productId,
      entityId,
      SERVING_PROJECTION_VERSION,
      this.now(),
    );
  }

  private acknowledgeEntityProjection(entityId: string): void {
    this.prepare(`
      DELETE FROM serving_projection_outbox
      WHERE tenant_id = ? AND product_id = ? AND entity_id = ?
    `).run(
      this.tenantId,
      this.productId,
      entityId,
    );
  }

  private deleteServingProjection(entityId: string): void {
    this.prepare(`
      DELETE FROM serving_entity_search
      WHERE tenant_id = ? AND product_id = ? AND entity_id = ?
    `).run(this.tenantId, this.productId, entityId);
  }

  private recordProjectionFailure(outboxIds: number[], error: unknown): void {
    if (outboxIds.length === 0) return;
    const placeholders = outboxIds.map(() => "?").join(", ");
    this.withTransaction(() => {
      this.prepare(`
        UPDATE serving_projection_outbox
        SET attempt_count = attempt_count + 1,
            last_attempt_at = ?,
            last_error = ?
        WHERE tenant_id = ? AND product_id = ?
          AND id IN (${placeholders})
      `).run(
        this.now(),
        boundedErrorMessage(error),
        this.tenantId,
        this.productId,
        ...outboxIds,
      );
    });
  }

  private searchProjectedEntities(
    source: string | undefined,
    ftsQuery: string | undefined,
    normalizedQuery: string | undefined,
    limit: number,
    offset: number,
  ): CanonicalEntity[] {
    const sourceClause = source
      ? `AND EXISTS (
          SELECT 1
          FROM provenance source_provenance
          WHERE source_provenance.tenant_id = p.tenant_id
            AND source_provenance.product_id = p.product_id
            AND source_provenance.owner_type = 'entity'
            AND source_provenance.owner_id = p.entity_id
            AND source_provenance.source = ?
        )`
      : "";
    const parameters: Array<string | number> = [this.tenantId, this.productId];
    if (source) parameters.push(source);
    if (ftsQuery) parameters.push(ftsQuery);
    if (normalizedQuery) parameters.push(normalizedQuery, normalizedQuery);
    parameters.push(limit, offset);
    const rows = ftsQuery
      ? this.prepare(`
          SELECT p.data_json
          FROM serving_entity_search p
          JOIN serving_entity_search_fts fts ON fts.rowid = p.row_id
          WHERE p.tenant_id = ? AND p.product_id = ?
            ${sourceClause}
            AND serving_entity_search_fts MATCH ?
          ORDER BY
            CASE
              WHEN instr(lower(p.entity_id), ?) > 0
                OR instr(lower(p.title), ?) > 0
              THEN 0 ELSE 1
            END,
            p.entity_sequence
          LIMIT ? OFFSET ?
        `).all(...parameters)
      : this.prepare(`
          SELECT p.data_json
          FROM serving_entity_search p
          WHERE p.tenant_id = ? AND p.product_id = ?
            ${sourceClause}
          ORDER BY p.entity_sequence
          LIMIT ? OFFSET ?
        `).all(...parameters);
    return rows.map(parseData<CanonicalEntity>);
  }

  private searchProjectedEntitiesWithSubstring(
    source: string | undefined,
    normalizedQuery: string,
    limit: number,
    offset: number,
  ): CanonicalEntity[] {
    const rows = this.prepare(`
      SELECT p.data_json, p.entity_id, p.title, p.searchable_text, p.entity_sequence
      FROM serving_entity_search p
      WHERE p.tenant_id = ? AND p.product_id = ?
        ${source
          ? `AND EXISTS (
              SELECT 1
              FROM provenance source_provenance
              WHERE source_provenance.tenant_id = p.tenant_id
                AND source_provenance.product_id = p.product_id
                AND source_provenance.owner_type = 'entity'
                AND source_provenance.owner_id = p.entity_id
                AND source_provenance.source = ?
            )`
          : ""}
      ORDER BY p.entity_sequence
    `).all(
      this.tenantId,
      this.productId,
      ...(source ? [source] : []),
    ) as Array<{
      data_json: string;
      entity_id: string;
      title: string;
      searchable_text: string;
      entity_sequence: number;
    }>;
    return rows
      .filter((row) => row.searchable_text.toLowerCase().includes(normalizedQuery))
      .sort((left, right) => {
        const leftLegacyMatch = left.entity_id.toLowerCase().includes(normalizedQuery)
          || left.title.toLowerCase().includes(normalizedQuery);
        const rightLegacyMatch = right.entity_id.toLowerCase().includes(normalizedQuery)
          || right.title.toLowerCase().includes(normalizedQuery);
        return Number(rightLegacyMatch) - Number(leftLegacyMatch)
          || left.entity_sequence - right.entity_sequence;
      })
      .slice(offset, offset + limit)
      .map(parseData<CanonicalEntity>);
  }

  private searchCanonicalEntities(
    source: string | undefined,
    normalizedQuery: string,
    limit: number,
    offset: number,
  ): CanonicalEntity[] {
    if (/^[a-z][a-z0-9]*-\d+$/i.test(normalizedQuery)) {
      return this.searchCanonicalReferenceEntities(source, normalizedQuery, limit, offset);
    }
    const queryFilter = normalizedQuery.length === 0
      ? ""
      : `AND (
          instr(lower(e.id), ?) > 0
          OR instr(lower(e.title), ?) > 0
          OR EXISTS (
            SELECT 1
            FROM json_tree(e.data_json, '$.metadata') metadata_value
            WHERE instr(lower(CAST(metadata_value.key AS TEXT)), ?) > 0
              OR (
                metadata_value.atom IS NOT NULL
                AND instr(lower(CAST(metadata_value.atom AS TEXT)), ?) > 0
              )
          )
          OR EXISTS (
            SELECT 1
            FROM claims c
            WHERE c.tenant_id = e.tenant_id
              AND c.product_id = e.product_id
              AND c.entity_id = e.id
              AND c.status <> 'rejected'
              AND (
                instr(lower(c.attribute), ?) > 0
                OR instr(lower(c.value_json), ?) > 0
              )
          )
          OR EXISTS (
            SELECT 1
            FROM provenance search_provenance
            WHERE search_provenance.tenant_id = e.tenant_id
              AND search_provenance.product_id = e.product_id
              AND search_provenance.owner_type = 'entity'
              AND search_provenance.owner_id = e.id
              AND (
                instr(lower(search_provenance.source), ?) > 0
                OR instr(lower(search_provenance.source_id), ?) > 0
                OR instr(lower(search_provenance.source_version), ?) > 0
              )
          )
          OR EXISTS (
            SELECT 1
            FROM trace_links search_link
            WHERE search_link.tenant_id = e.tenant_id
              AND search_link.product_id = e.product_id
              AND (search_link.from_entity_id = e.id OR search_link.to_entity_id = e.id)
              AND (
                instr(lower(search_link.id), ?) > 0
                OR instr(lower(search_link.type), ?) > 0
                OR instr(lower(search_link.from_entity_id), ?) > 0
                OR instr(lower(search_link.to_entity_id), ?) > 0
              )
          )
        )`;
    const rows = this.prepare(`
      SELECT e.data_json
      FROM entities e
      WHERE e.tenant_id = ? AND e.product_id = ?
        ${source
          ? `AND EXISTS (
              SELECT 1
              FROM provenance source_provenance
              WHERE source_provenance.tenant_id = e.tenant_id
                AND source_provenance.product_id = e.product_id
                AND source_provenance.owner_type = 'entity'
                AND source_provenance.owner_id = e.id
                AND source_provenance.source = ?
            )`
          : ""}
        ${queryFilter}
      ORDER BY
        ${normalizedQuery.length === 0
          ? "e.sequence"
          : `CASE
              WHEN instr(lower(e.id), ?) > 0 OR instr(lower(e.title), ?) > 0 THEN 0
              ELSE 1
            END,
            e.sequence`}
      LIMIT ? OFFSET ?
    `).all(
      this.tenantId,
      this.productId,
      ...(source ? [source] : []),
      ...(normalizedQuery.length === 0
        ? []
        : Array(15).fill(normalizedQuery)),
      limit,
      offset,
    );
    return rows.map(parseData<CanonicalEntity>);
  }

  private searchCanonicalReferenceEntities(
    source: string | undefined,
    normalizedQuery: string,
    limit: number,
    offset: number,
  ): CanonicalEntity[] {
    const rows = this.prepare(`
      WITH direct_matches AS (
        SELECT e.id, 0 AS match_rank
        FROM entities e
        WHERE e.tenant_id = ? AND e.product_id = ?
          AND (
            instr(lower(e.id), ?) > 0
            OR instr(lower(e.title), ?) > 0
            OR EXISTS (
              SELECT 1
              FROM json_tree(e.data_json, '$.metadata') metadata_value
              WHERE instr(lower(CAST(metadata_value.key AS TEXT)), ?) > 0
                OR (
                  metadata_value.atom IS NOT NULL
                  AND instr(lower(CAST(metadata_value.atom AS TEXT)), ?) > 0
                )
            )
          )
        UNION ALL
        SELECT c.entity_id, 1 AS match_rank
        FROM claims c
        WHERE c.tenant_id = ? AND c.product_id = ?
          AND c.status <> 'rejected'
          AND (
            instr(lower(c.attribute), ?) > 0
            OR instr(lower(c.value_json), ?) > 0
          )
        UNION ALL
        SELECT p.owner_id, 1 AS match_rank
        FROM provenance p
        WHERE p.tenant_id = ? AND p.product_id = ?
          AND p.owner_type = 'entity'
          AND (
            instr(lower(p.source), ?) > 0
            OR instr(lower(p.source_id), ?) > 0
            OR instr(lower(p.source_version), ?) > 0
          )
        UNION ALL
        SELECT search_link.from_entity_id, 1 AS match_rank
        FROM trace_links search_link
        WHERE search_link.tenant_id = ? AND search_link.product_id = ?
          AND (
            instr(lower(search_link.id), ?) > 0
            OR instr(lower(search_link.type), ?) > 0
            OR instr(lower(search_link.from_entity_id), ?) > 0
            OR instr(lower(search_link.to_entity_id), ?) > 0
          )
        UNION ALL
        SELECT search_link.to_entity_id, 1 AS match_rank
        FROM trace_links search_link
        WHERE search_link.tenant_id = ? AND search_link.product_id = ?
          AND (
            instr(lower(search_link.id), ?) > 0
            OR instr(lower(search_link.type), ?) > 0
            OR instr(lower(search_link.from_entity_id), ?) > 0
            OR instr(lower(search_link.to_entity_id), ?) > 0
          )
      ),
      matched_entities AS (
        SELECT id, MIN(match_rank) AS match_rank
        FROM direct_matches
        GROUP BY id
      ),
      related_matches AS (
        SELECT search_link.to_entity_id AS id, 2 AS match_rank
        FROM trace_links search_link
        JOIN matched_entities matched
          ON matched.id = search_link.from_entity_id
         AND matched.match_rank = 0
        WHERE search_link.tenant_id = ? AND search_link.product_id = ?
        UNION ALL
        SELECT search_link.from_entity_id AS id, 2 AS match_rank
        FROM trace_links search_link
        JOIN matched_entities matched
          ON matched.id = search_link.to_entity_id
         AND matched.match_rank = 0
        WHERE search_link.tenant_id = ? AND search_link.product_id = ?
      ),
      candidates AS (
        SELECT id, MIN(match_rank) AS match_rank
        FROM (
          SELECT id, match_rank FROM matched_entities
          UNION ALL
          SELECT id, match_rank FROM related_matches
        )
        GROUP BY id
      )
      SELECT e.data_json
      FROM candidates candidate
      JOIN entities e
        ON e.tenant_id = ?
       AND e.product_id = ?
       AND e.id = candidate.id
      WHERE 1 = 1
        ${source
          ? `AND EXISTS (
              SELECT 1
              FROM provenance source_provenance
              WHERE source_provenance.tenant_id = e.tenant_id
                AND source_provenance.product_id = e.product_id
                AND source_provenance.owner_type = 'entity'
                AND source_provenance.owner_id = e.id
                AND source_provenance.source = ?
            )`
          : ""}
      ORDER BY candidate.match_rank, e.sequence
      LIMIT ? OFFSET ?
    `).all(
      this.tenantId,
      this.productId,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      this.tenantId,
      this.productId,
      normalizedQuery,
      normalizedQuery,
      this.tenantId,
      this.productId,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      this.tenantId,
      this.productId,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      this.tenantId,
      this.productId,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      this.tenantId,
      this.productId,
      this.tenantId,
      this.productId,
      this.tenantId,
      this.productId,
      ...(source ? [source] : []),
      limit,
      offset,
    );
    return rows.map(parseData<CanonicalEntity>);
  }

  private initializeFtsProjection(): void {
    const existing = this.database.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'serving_entity_search_fts'
    `).get() as { sql: string } | undefined;
    if (existing) {
      try {
        this.database.prepare("SELECT rowid FROM serving_entity_search_fts LIMIT 0").all();
        this.ftsTokenizer = existing.sql.includes("trigram") ? "trigram" : "unicode61";
      } catch (error) {
        const message = boundedErrorMessage(error);
        if (!message.includes("no such module") && !message.includes("no such tokenizer")) {
          throw error;
        }
        this.disableFtsSynchronization();
        this.ftsTokenizer = undefined;
      }
      return;
    }
    for (const tokenizer of ["trigram", "unicode61"] as const) {
      this.database.exec("SAVEPOINT serving_fts_setup");
      try {
        this.database.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS serving_entity_search_fts USING fts5(
            entity_id,
            title,
            searchable_text,
            content='serving_entity_search',
            content_rowid='row_id',
            tokenize='${tokenizer}'
          );
          CREATE TRIGGER IF NOT EXISTS serving_entity_search_ai
          AFTER INSERT ON serving_entity_search BEGIN
            INSERT INTO serving_entity_search_fts(
              rowid, entity_id, title, searchable_text
            ) VALUES (
              new.row_id, new.entity_id, new.title, new.searchable_text
            );
          END;
          CREATE TRIGGER IF NOT EXISTS serving_entity_search_ad
          AFTER DELETE ON serving_entity_search BEGIN
            INSERT INTO serving_entity_search_fts(
              serving_entity_search_fts, rowid, entity_id, title, searchable_text
            ) VALUES (
              'delete', old.row_id, old.entity_id, old.title, old.searchable_text
            );
          END;
          CREATE TRIGGER IF NOT EXISTS serving_entity_search_au
          AFTER UPDATE ON serving_entity_search BEGIN
            INSERT INTO serving_entity_search_fts(
              serving_entity_search_fts, rowid, entity_id, title, searchable_text
            ) VALUES (
              'delete', old.row_id, old.entity_id, old.title, old.searchable_text
            );
            INSERT INTO serving_entity_search_fts(
              rowid, entity_id, title, searchable_text
            ) VALUES (
              new.row_id, new.entity_id, new.title, new.searchable_text
            );
          END;
        `);
        this.database.prepare(`
          INSERT INTO serving_entity_search_fts(serving_entity_search_fts)
          VALUES ('rebuild')
        `).run();
        this.database.exec("RELEASE serving_fts_setup");
        this.ftsTokenizer = tokenizer;
        return;
      } catch (error) {
        this.database.exec("ROLLBACK TO serving_fts_setup");
        this.database.exec("RELEASE serving_fts_setup");
        const message = boundedErrorMessage(error);
        if (message.includes("no such module: fts5")) return;
        if (message.includes("no such tokenizer") && tokenizer === "trigram") continue;
        throw error;
      }
    }
  }

  private disableFtsSynchronization(): void {
    this.database.exec(`
      DROP TRIGGER IF EXISTS serving_entity_search_ai;
      DROP TRIGGER IF EXISTS serving_entity_search_ad;
      DROP TRIGGER IF EXISTS serving_entity_search_au;
    `);
  }

  private mutate<T>(
    operation: KnowledgeStoreHistoryEntry["operation"],
    action: () => T,
  ): T {
    return this.withTransaction(() => {
      const result = action();
      this.appendHistory(operation);
      return result;
    });
  }

  private withTransaction<T>(action: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) return action();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.database);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private appendHistory(operation: KnowledgeStoreHistoryEntry["operation"]): void {
    const sequence = this.nextSequence("operation_history");
    let ordinal = Number(
      (this.prepare(`
        SELECT COUNT(*) AS count
        FROM operation_history
        WHERE tenant_id = ? AND product_id = ?
      `).get(this.tenantId, this.productId) as { count: number }).count,
    ) + 1;
    while (this.prepare(`
      SELECT 1 FROM operation_history
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, `history:${ordinal}`)) {
      ordinal += 1;
    }
    this.prepare(`
      INSERT INTO operation_history(
        tenant_id, product_id, id, operation, recorded_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.tenantId,
      this.productId,
      `history:${ordinal}`,
      operation,
      this.now(),
      sequence,
    );
  }

  private assertEntityScope(entity: CanonicalEntity): void {
    if (entity.tenantId !== this.tenantId || entity.productId !== this.productId) {
      throw new Error(
        `Entity ${entity.id} does not belong to store scope ${this.tenantId}/${this.productId}`,
      );
    }
  }

  private assertEntityExists(entityId: string, subject: string): void {
    if (!this.getEntity(entityId)) {
      throw new Error(`${subject} requires entity ${entityId} in the same store scope`);
    }
  }

  private existingSequence(
    table:
      | "entities"
      | "claims"
      | "trace_links"
      | "deferred_trace_links"
      | "conflicts"
      | "reviews",
    id: string,
  ): number | undefined {
    const row = this.prepare(`
      SELECT sequence
      FROM ${table}
      WHERE tenant_id = ? AND product_id = ? AND id = ?
    `).get(this.tenantId, this.productId, id) as { sequence: number } | undefined;
    return row?.sequence;
  }

  private nextSequence(
    table:
      | "entities"
      | "claims"
      | "trace_links"
      | "deferred_trace_links"
      | "conflicts"
      | "reviews"
      | "operation_history",
  ): number {
    const row = this.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM ${table}
      WHERE tenant_id = ? AND product_id = ?
    `).get(this.tenantId, this.productId) as { sequence: number };
    return Number(row.sequence);
  }

  private prepare(sql: string) {
    this.assertOpen();
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Knowledge database is closed");
  }
}

interface LegacyStoreSnapshot {
  schemaVersion: number;
  revision: number;
  tenantId: string;
  productId: string;
  entities: CanonicalEntity[];
  claims: Claim[];
  traceLinks: TraceLink[];
  deferredTraceLinks: TraceLink[];
  conflicts: ConflictRecord[];
  reviews: KnowledgeReviewRecord[];
  history: KnowledgeStoreHistoryEntry[];
}

function parseLegacySnapshot(content: string): LegacyStoreSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Persistent knowledge store snapshot is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Persistent knowledge store snapshot must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ["entities", "claims", "traceLinks", "conflicts"] as const) {
    if (!Array.isArray(candidate[field])) {
      throw new Error(`Persistent knowledge store snapshot field ${field} must be an array`);
    }
  }
  const schemaVersion = Number(candidate.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error("Persistent knowledge store snapshot has an invalid schemaVersion");
  }
  if (schemaVersion > LEGACY_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Persistent knowledge store schema ${schemaVersion} is newer than supported schema ${LEGACY_STORE_SCHEMA_VERSION}`,
    );
  }
  if (![0, 1, 2, 3].includes(schemaVersion)) {
    throw new Error(`No migration exists for knowledge store schema ${schemaVersion}`);
  }
  if (typeof candidate.tenantId !== "string" || typeof candidate.productId !== "string") {
    throw new Error("Persistent knowledge store snapshot is missing its scope");
  }
  if (
    candidate.revision !== undefined
    && (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 0)
  ) {
    throw new Error("Persistent knowledge store snapshot has an invalid revision");
  }
  for (const field of ["deferredTraceLinks", "reviews", "history"] as const) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      throw new Error(`Persistent knowledge store snapshot field ${field} must be an array`);
    }
  }
  return {
    schemaVersion,
    revision: Number(candidate.revision ?? 0),
    tenantId: candidate.tenantId,
    productId: candidate.productId,
    entities: candidate.entities as CanonicalEntity[],
    claims: candidate.claims as Claim[],
    traceLinks: candidate.traceLinks as TraceLink[],
    deferredTraceLinks: (candidate.deferredTraceLinks ?? []) as TraceLink[],
    conflicts: candidate.conflicts as ConflictRecord[],
    reviews: (candidate.reviews ?? []) as KnowledgeReviewRecord[],
    history: (candidate.history ?? []) as KnowledgeStoreHistoryEntry[],
  };
}

function assertSnapshotScope(
  snapshot: LegacyStoreSnapshot,
  tenantId: string,
  productId: string,
): void {
  if (snapshot.tenantId !== tenantId || snapshot.productId !== productId) {
    throw new Error(
      `Persistent knowledge store snapshot scope ${snapshot.tenantId}/${snapshot.productId} does not match ${tenantId}/${productId}`,
    );
  }
}

function createReview(
  input: Omit<KnowledgeReviewRecord, "id">,
): KnowledgeReviewRecord {
  return {
    ...input,
    id: `review:${createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex")
      .slice(0, 16)}`,
  };
}

function parseData<T>(row: unknown): T {
  const data = (row as { data_json?: unknown }).data_json;
  if (typeof data !== "string") {
    throw new Error("Knowledge database contains an invalid JSON record");
  }
  return JSON.parse(data) as T;
}

function sumCounts(rows: Array<{ count: number }>): number {
  return rows.reduce((total, row) => total + Number(row.count), 0);
}

function toCountMap<K extends string>(
  rows: Array<Record<K, string> & { count: number }>,
  key: K,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row[key]] = Number(row.count);
  }
  return map;
}

function provenanceEntries(
  provenance: CanonicalEntity["provenance"] | Claim["provenance"] | TraceLink["provenance"],
) {
  return Array.isArray(provenance) ? provenance : [provenance];
}

function sameClaimVersion(left: Claim, right: Claim): boolean {
  return (left.id === right.id || left.id.startsWith(`${right.id}@`))
    && left.entityId === right.entityId
    && left.attribute === right.attribute
    && JSON.stringify(left.value) === JSON.stringify(right.value)
    && left.origin === right.origin
    && left.confidence === right.confidence
    && JSON.stringify(left.provenance) === JSON.stringify(right.provenance);
}

function claimVersionKey(claim: Claim): string {
  return createHash("sha256")
    .update(JSON.stringify({
      entityId: claim.entityId,
      attribute: claim.attribute,
      value: claim.value,
      origin: claim.origin,
      confidence: claim.confidence,
      provenance: claim.provenance,
    }))
    .digest("hex")
    .slice(0, 16);
}

function baseClaimIdFromStoredId(id: string, versionKeys: string | string[]): string {
  const keys = Array.isArray(versionKeys) ? versionKeys : [versionKeys];
  let baseId = id;
  for (const versionKey of keys) {
    const suffix = `@${versionKey}`;
    if (baseId.endsWith(suffix)) baseId = baseId.slice(0, -suffix.length);
  }
  return baseId;
}

function legacyClaimVersionKey(claim: Claim): string {
  return createHash("sha256")
    .update(JSON.stringify({
      entityId: claim.entityId,
      attribute: claim.attribute,
      value: claim.value,
      origin: claim.origin,
      confidence: claim.confidence,
      status: claim.status,
      provenance: claim.provenance,
    }))
    .digest("hex")
    .slice(0, 16);
}

function sameValues(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return left.length === right.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertReviewer(reviewerId: string, reviewedAt: string, note?: string): void {
  if (typeof reviewerId !== "string" || reviewerId.trim().length === 0) {
    throw new TypeError("reviewerId must not be empty");
  }
  if (typeof reviewedAt !== "string" || Number.isNaN(Date.parse(reviewedAt))) {
    throw new TypeError("reviewedAt must be a valid timestamp");
  }
  if (note !== undefined && (typeof note !== "string" || note.trim().length === 0)) {
    throw new TypeError("note must not be empty when provided");
  }
}

function normalizedNote(note?: string): string | undefined {
  return note?.trim();
}

function assertScopeId(name: string, value: string): void {
  if (!SCOPE_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must use only letters, numbers, underscores, or hyphens`);
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS store_metadata (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, product_id, key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS entities (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS claims (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    base_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    attribute TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    origin TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    version_key TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence),
    FOREIGN KEY (tenant_id, product_id, entity_id)
      REFERENCES entities(tenant_id, product_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS trace_links (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    origin TEXT NOT NULL,
    confidence REAL NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence),
    FOREIGN KEY (tenant_id, product_id, from_entity_id)
      REFERENCES entities(tenant_id, product_id, id),
    FOREIGN KEY (tenant_id, product_id, to_entity_id)
      REFERENCES entities(tenant_id, product_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS deferred_trace_links (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    origin TEXT NOT NULL,
    confidence REAL NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS conflicts (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence),
    FOREIGN KEY (tenant_id, product_id, entity_id)
      REFERENCES entities(tenant_id, product_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS conflict_claims (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    conflict_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, conflict_id, ordinal),
    FOREIGN KEY (tenant_id, product_id, conflict_id)
      REFERENCES conflicts(tenant_id, product_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS reviews (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    note TEXT,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence),
    FOREIGN KEY (tenant_id, product_id, entity_id)
      REFERENCES entities(tenant_id, product_id, id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS review_approved_claims (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, review_id, ordinal),
    FOREIGN KEY (tenant_id, product_id, review_id)
      REFERENCES reviews(tenant_id, product_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS operation_history (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    id TEXT NOT NULL,
    operation TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, product_id, id),
    UNIQUE (tenant_id, product_id, sequence)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS provenance (
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    normalizer_id TEXT NOT NULL,
    normalizer_version TEXT NOT NULL,
    PRIMARY KEY (tenant_id, product_id, owner_type, owner_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS serving_entity_search (
    row_id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    title TEXT NOT NULL,
    searchable_text TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    entity_sequence INTEGER NOT NULL,
    projection_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, product_id, entity_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS serving_projection_outbox (
    id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    UNIQUE (tenant_id, product_id, entity_id, projection_version)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_entities_product_type
    ON entities(tenant_id, product_id, type, id);
  CREATE INDEX IF NOT EXISTS idx_provenance_source
    ON provenance(tenant_id, product_id, source, source_id, owner_type, owner_id);
  CREATE INDEX IF NOT EXISTS idx_provenance_source_id
    ON provenance(tenant_id, product_id, source_id, owner_type, owner_id);
  CREATE INDEX IF NOT EXISTS idx_claims_entity_status
    ON claims(tenant_id, product_id, entity_id, status, sequence);
  CREATE INDEX IF NOT EXISTS idx_trace_links_from
    ON trace_links(tenant_id, product_id, from_entity_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_trace_links_to
    ON trace_links(tenant_id, product_id, to_entity_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_conflicts_status_entity
    ON conflicts(tenant_id, product_id, status, entity_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_conflict_claims_claim
    ON conflict_claims(tenant_id, product_id, claim_id, conflict_id);
  CREATE INDEX IF NOT EXISTS idx_deferred_trace_links_from
    ON deferred_trace_links(tenant_id, product_id, from_entity_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_deferred_trace_links_to
    ON deferred_trace_links(tenant_id, product_id, to_entity_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_reviews_entity
    ON reviews(tenant_id, product_id, entity_id, reviewed_at, sequence);
  CREATE INDEX IF NOT EXISTS idx_reviews_target
    ON reviews(tenant_id, product_id, target_type, target_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_history_recorded
    ON operation_history(tenant_id, product_id, recorded_at, sequence);
  CREATE INDEX IF NOT EXISTS idx_serving_entity_type
    ON serving_entity_search(
      tenant_id, product_id, entity_type, entity_sequence, entity_id
    );
  CREATE INDEX IF NOT EXISTS idx_serving_entity_sequence
    ON serving_entity_search(tenant_id, product_id, entity_sequence, entity_id);
  CREATE INDEX IF NOT EXISTS idx_serving_projection_outbox_pending
    ON serving_projection_outbox(
      tenant_id, product_id, projection_version, id
    );
`;

const CLAIM_BASE_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_claims_base_id
    ON claims(tenant_id, product_id, base_id, sequence);
`;

function assertProjectionBatchSize(value: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_PROJECTION_BATCH_SIZE
  ) {
    throw new TypeError(
      `Projection batch size must be an integer from 1 to ${MAX_PROJECTION_BATCH_SIZE}`,
    );
  }
}

function assertPageValue(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
}

function collectSearchableValues(value: unknown, output: string[]): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchableValues(item, output);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectSearchableValues(item, output);
    }
  }
}

function boundedErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1000);
}
