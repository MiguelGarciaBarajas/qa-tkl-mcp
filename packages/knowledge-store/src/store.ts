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
import { createHash } from "node:crypto";

/**
 * Read/write surface the API (Carlos Ramirez) and dashboard (Clemente Herrera)
 * workstreams are expected to integrate against. The in-memory implementation below
 * exists so downstream owners have something concrete to build/test against before a
 * persistent backend is selected; it must not be used in production.
 */
export interface KnowledgeStore {
  upsert(result: Partial<NormalizationResult>): void;

  addEntity(entity: CanonicalEntity): void;
  getEntity(id: string): CanonicalEntity | undefined;
  listEntities(productId: string): CanonicalEntity[];

  addClaim(claim: Claim): void;
  listClaims(): Claim[];
  getClaims(entityId: string): Claim[];
  getApprovedClaims(entityId: string): Claim[];

  addTraceLink(link: TraceLink): void;
  listTraceLinks(): TraceLink[];
  getTraceLinks(entityId: string): TraceLink[];

  addConflict(conflict: ConflictRecord): void;
  listOpenConflicts(entityId?: string): ConflictRecord[];
  conflicts(): Array<Claim | ConflictRecord>;

  reviewClaim(input: ClaimReviewInput): KnowledgeReviewRecord;
  reviewConflict(input: ConflictReviewInput): KnowledgeReviewRecord;
  listReviews(entityId?: string): KnowledgeReviewRecord[];
}

/**
 * Bounded, aggregate-only snapshot of the canonical (Silver) knowledge held for one
 * tenant/product scope. Every field is a count or a small grouped count map derived from
 * indexed columns; no entity, claim, trace-link, or payload bodies are materialized, so it
 * is safe to compute over a large store. Coverage buckets follow the same trust signal the
 * `@tkl/analyzer-coverage` per-requirement analyzer uses: a requirement/story is "mapped"
 * only through an explicit-origin `verifies` trace link (see `docs` for exact semantics).
 */
export interface KnowledgeInventorySummary {
  entities: { total: number; byType: Record<string, number> };
  claims: { total: number; byStatus: Record<string, number> };
  traceLinks: { total: number; deferred: number; byType: Record<string, number> };
  conflicts: { total: number; open: number };
  reviews: { total: number };
  canonicalSourceProvenance: Array<{ source: string; entityCount: number }>;
  coverage: {
    requirementTotal: number;
    withManual: number;
    withAutomation: number;
    withBoth: number;
    withNeither: number;
    unmappedTests: number;
    verifyLinkTotal: number;
    averageVerifyLinkConfidence: number | null;
  };
  pendingServingProjections: number;
}

/** In-memory reference implementation. Not for production use. */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  protected readonly entities = new Map<string, CanonicalEntity>();
  protected readonly claims: Claim[] = [];
  protected readonly traceLinks: TraceLink[] = [];
  protected readonly conflictRecords: ConflictRecord[] = [];
  protected readonly reviewRecords: KnowledgeReviewRecord[] = [];

  upsert({
    entities = [],
    claims = [],
    traceLinks = [],
  }: {
    entities?: CanonicalEntity[];
    claims?: Claim[];
    traceLinks?: TraceLink[];
  }): void {
    for (const entity of entities) this.addEntity(entity);
    for (const claim of claims) this.addClaim(claim);
    for (const link of traceLinks) this.addTraceLink(link);
  }

  addEntity(entity: CanonicalEntity): void {
    const existing = this.entities.get(entity.id);
    if (
      existing &&
      (existing.tenantId !== entity.tenantId || existing.productId !== entity.productId)
    ) {
      throw new Error(
        `Entity ${entity.id} cannot be reused across tenant or product boundaries`,
      );
    }
    this.entities.set(entity.id, entity);
  }

  getEntity(id: string): CanonicalEntity | undefined {
    return this.entities.get(id);
  }

  findBySource(sourceId: string): CanonicalEntity[] {
    return [...this.entities.values()].filter((entity) =>
      provenanceEntries(entity.provenance).some((item) => item.sourceId === sourceId),
    );
  }

  listEntities(productId: string): CanonicalEntity[] {
    return [...this.entities.values()].filter((e) => e.productId === productId);
  }

  addClaim(claim: Claim): void {
    const equivalentIndex = this.claims.findIndex((item) => sameClaimVersion(item, claim));
    if (equivalentIndex !== -1) {
      const existing = this.claims[equivalentIndex];
      this.claims[equivalentIndex] = {
        ...claim,
        status:
          claim.status === "pending"
          && (existing.status === "approved" || existing.status === "rejected")
            ? existing.status
            : claim.status,
      };
      return;
    }

    const idAlreadyExists = this.claims.some((item) =>
      item.id === claim.id || item.id.startsWith(`${claim.id}@`));
    const storedClaim = idAlreadyExists
      ? { ...claim, id: `${claim.id}@${claimVersionKey(claim)}` }
      : claim;
    const storedIndex = this.claims.findIndex((item) => item.id === storedClaim.id);
    if (storedIndex === -1) {
      this.claims.push(storedClaim);
    } else {
      this.claims[storedIndex] = storedClaim;
    }
  }

  listClaims(): Claim[] {
    return [...this.claims];
  }

  getClaims(entityId: string): Claim[] {
    return this.claims.filter((c) => c.entityId === entityId);
  }

  getApprovedClaims(entityId: string): Claim[] {
    return this.getClaims(entityId).filter((c) => c.status === "approved");
  }

  addTraceLink(link: TraceLink): void {
    const fromEntity = this.entities.get(link.fromEntityId);
    const toEntity = this.entities.get(link.toEntityId);
    if (!fromEntity || !toEntity) {
      throw new Error(`Trace link ${link.id} requires both endpoint entities`);
    }

    if (
      fromEntity.tenantId !== toEntity.tenantId ||
      fromEntity.productId !== toEntity.productId
    ) {
      throw new Error(
        `Trace link ${link.id} cannot cross tenant or product boundaries`,
      );
    }
    replaceById(this.traceLinks, link);
  }

  listTraceLinks(): TraceLink[] {
    return [...this.traceLinks];
  }

  getTraceLinks(entityId: string): TraceLink[] {
    return this.traceLinks.filter(
      (link) =>
        link.fromEntityId === entityId ||
        link.toEntityId === entityId ||
        legacyLinkEndpoint(link, "from") === entityId ||
        legacyLinkEndpoint(link, "to") === entityId,
    );
  }

  findLinks(sourceId: string): TraceLink[] {
    return this.traceLinks.filter(
      (link) =>
        provenanceEntries(link.provenance).some((item) => item.sourceId === sourceId) ||
        legacyLinkEndpoint(link, "from") === sourceId ||
        legacyLinkEndpoint(link, "to") === sourceId,
    );
  }

  addConflict(conflict: ConflictRecord): void {
    const existingIndex = this.conflictRecords.findIndex((item) => item.id === conflict.id);
    if (existingIndex === -1) {
      this.conflictRecords.push(conflict);
    } else if (
      this.conflictRecords[existingIndex].status === "reviewed"
      && sameValues(this.conflictRecords[existingIndex].claimIds, conflict.claimIds)
    ) {
      return;
    } else {
      this.conflictRecords[existingIndex] = conflict;
    }
  }

  listOpenConflicts(entityId?: string): ConflictRecord[] {
    return this.conflictRecords.filter(
      (c) => c.status === "open" && (!entityId || c.entityId === entityId),
    );
  }

  conflicts(): Array<Claim | ConflictRecord> {
    return [
      ...this.claims.filter((claim) => claim.status === "conflict"),
      ...this.conflictRecords.filter((conflict) => conflict.status === "open"),
    ];
  }

  reviewClaim(input: ClaimReviewInput): KnowledgeReviewRecord {
    assertReviewer(input.reviewerId, input.reviewedAt, input.note);
    const claimIndex = this.claims.findIndex((claim) => claim.id === input.claimId);
    if (claimIndex === -1) {
      throw new Error(`Claim ${input.claimId} does not exist`);
    }
    const claim = this.claims[claimIndex];
    const openConflict = this.conflictRecords.find(
      (conflict) => conflict.status === "open" && conflict.claimIds.includes(claim.id),
    );
    if (openConflict) {
      throw new Error(
        `Claim ${claim.id} belongs to open conflict ${openConflict.id}; review the conflict instead`,
      );
    }

    this.claims[claimIndex] = { ...claim, status: input.decision };
    return this.recordReview({
      entityId: claim.entityId,
      targetType: "claim",
      targetId: claim.id,
      decision: input.decision,
      reviewerId: input.reviewerId,
      reviewedAt: input.reviewedAt,
      note: normalizedNote(input.note),
    });
  }

  reviewConflict(input: ConflictReviewInput): KnowledgeReviewRecord {
    assertReviewer(input.reviewerId, input.reviewedAt, input.note);
    const conflictIndex = this.conflictRecords.findIndex(
      (conflict) => conflict.id === input.conflictId,
    );
    if (conflictIndex === -1) {
      throw new Error(`Conflict ${input.conflictId} does not exist`);
    }
    const conflict = this.conflictRecords[conflictIndex];
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

    const conflictClaimIndexes = conflict.claimIds.map((claimId) => {
      const claimIndex = this.claims.findIndex((claim) => claim.id === claimId);
      if (claimIndex === -1 || this.claims[claimIndex].entityId !== conflict.entityId) {
        throw new Error(
          `Conflict ${conflict.id} references missing or mismatched claim ${claimId}`,
        );
      }
      return claimIndex;
    });

    for (const claimIndex of conflictClaimIndexes) {
      const claimId = this.claims[claimIndex].id;
      this.claims[claimIndex] = {
        ...this.claims[claimIndex],
        status: approvedClaimIds.includes(claimId) ? "approved" : "rejected",
      };
    }
    this.conflictRecords[conflictIndex] = { ...conflict, status: "reviewed" };

    return this.recordReview({
      entityId: conflict.entityId,
      targetType: "conflict",
      targetId: conflict.id,
      decision: "resolved",
      approvedClaimIds,
      reviewerId: input.reviewerId,
      reviewedAt: input.reviewedAt,
      note: normalizedNote(input.note),
    });
  }

  listReviews(entityId?: string): KnowledgeReviewRecord[] {
    return this.reviewRecords.filter((review) => !entityId || review.entityId === entityId);
  }

  /**
   * Aggregate-only inventory snapshot computed from in-memory state. Mirrors the
   * durable `SqliteKnowledgeStore.inventorySummary()` semantics so the reference
   * implementation and tests report the same coverage buckets and grouped counts.
   */
  inventorySummary(): KnowledgeInventorySummary {
    const entities = [...this.entities.values()];
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const entitiesByType = countBy(entities, (entity) => entity.type);
    const claimsByStatus = countBy(this.claims, (claim) => claim.status);
    const traceLinksByType = countBy(this.traceLinks, (link) => link.type);

    const provenanceBySource = new Map<string, number>();
    for (const entity of entities) {
      const sources = new Set(
        provenanceSourceList(entity.provenance).filter((source) => source.length > 0),
      );
      for (const source of sources) {
        provenanceBySource.set(source, (provenanceBySource.get(source) ?? 0) + 1);
      }
    }

    const explicitVerifyLinks = this.traceLinks.filter(
      (link) => link.type === "verifies" && link.origin === "explicit",
    );
    const manualTestIds = new Set(
      entities.filter((entity) => entity.type === "manual-test").map((entity) => entity.id),
    );
    const automatedTestIds = new Set(
      entities.filter((entity) => entity.type === "test").map((entity) => entity.id),
    );
    const manualToAutomation = new Set<string>();
    for (const link of this.traceLinks) {
      if (
        link.type === "relates_to"
        && link.origin === "explicit"
        && manualTestIds.has(link.fromEntityId)
        && automatedTestIds.has(link.toEntityId)
      ) {
        manualToAutomation.add(link.fromEntityId);
      }
    }

    const requirements = entities.filter(
      (entity) => entity.type === "requirement" || entity.type === "story",
    );
    let withManual = 0;
    let withAutomation = 0;
    let withBoth = 0;
    let withNeither = 0;
    for (const requirement of requirements) {
      const verifying = explicitVerifyLinks.filter(
        (link) => link.toEntityId === requirement.id,
      );
      const hasManual = verifying.some((link) => manualTestIds.has(link.fromEntityId));
      const hasAutomation = verifying.some(
        (link) =>
          automatedTestIds.has(link.fromEntityId)
          || (manualTestIds.has(link.fromEntityId) && manualToAutomation.has(link.fromEntityId)),
      );
      if (hasManual) withManual += 1;
      if (hasAutomation) withAutomation += 1;
      if (hasManual && hasAutomation) withBoth += 1;
      if (!hasManual && !hasAutomation) withNeither += 1;
    }

    const mappedTestIds = new Set(explicitVerifyLinks.map((link) => link.fromEntityId));
    const unmappedTests = [...manualTestIds, ...automatedTestIds].filter(
      (id) => !mappedTestIds.has(id) && entityById.has(id),
    ).length;
    const verifyLinkTotal = explicitVerifyLinks.length;
    const averageVerifyLinkConfidence = verifyLinkTotal
      ? explicitVerifyLinks.reduce((sum, link) => sum + link.confidence, 0) / verifyLinkTotal
      : null;

    return {
      entities: { total: entities.length, byType: entitiesByType },
      claims: { total: this.claims.length, byStatus: claimsByStatus },
      traceLinks: {
        total: this.traceLinks.length,
        deferred: this.deferredTraceLinkCount(),
        byType: traceLinksByType,
      },
      conflicts: {
        total: this.conflictRecords.length,
        open: this.conflictRecords.filter((conflict) => conflict.status === "open").length,
      },
      reviews: { total: this.reviewRecords.length },
      canonicalSourceProvenance: [...provenanceBySource.entries()]
        .map(([source, entityCount]) => ({ source, entityCount }))
        .sort((left, right) => left.source.localeCompare(right.source)),
      coverage: {
        requirementTotal: requirements.length,
        withManual,
        withAutomation,
        withBoth,
        withNeither,
        unmappedTests,
        verifyLinkTotal,
        averageVerifyLinkConfidence,
      },
      pendingServingProjections: 0,
    };
  }

  /** Deferred trace-link count. Overridden by subclasses that persist a deferral queue. */
  protected deferredTraceLinkCount(): number {
    return 0;
  }

  protected restoreReview(review: KnowledgeReviewRecord): void {
    this.reviewRecords.push(review);
  }

  private recordReview(
    input: Omit<KnowledgeReviewRecord, "id">,
  ): KnowledgeReviewRecord {
    const review: KnowledgeReviewRecord = {
      ...input,
      id: `review:${createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex")
        .slice(0, 16)}`,
    };
    this.reviewRecords.push(review);
    return review;
  }
}

function provenanceEntries(
  provenance: CanonicalEntity["provenance"] | TraceLink["provenance"],
): Array<{ sourceId: string }> {
  return Array.isArray(provenance) ? provenance : [provenance];
}

function provenanceSourceList(
  provenance: CanonicalEntity["provenance"],
): string[] {
  const entries = Array.isArray(provenance) ? provenance : [provenance];
  return entries
    .map((entry) => (typeof entry?.source === "string" ? entry.source : ""))
    .filter((source) => source.length > 0);
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const bucket = key(value);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function legacyLinkEndpoint(link: TraceLink, endpoint: "from" | "to"): string | undefined {
  return (link as TraceLink & { from?: string; to?: string })[endpoint];
}

function replaceById<T extends { id: string }>(values: T[], value: T): void {
  const existingIndex = values.findIndex((item) => item.id === value.id);
  if (existingIndex === -1) {
    values.push(value);
  } else {
    values[existingIndex] = value;
  }
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
