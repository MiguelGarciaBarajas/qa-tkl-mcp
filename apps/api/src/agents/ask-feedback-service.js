import { randomUUID } from "node:crypto";

/**
 * Feedback is a review queue only. It never changes canonical knowledge,
 * source claims, or permissions automatically.
 */
export function createAskFeedbackService({
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
} = {}) {
  const entries = [];

  return {
    submit({ runId, productId, reviewerId, disposition, note, correction }) {
      if (!runId || !productId || !reviewerId) {
        throw new TypeError("runId, productId, and reviewerId are required.");
      }
      if (!["useful", "incorrect", "incomplete", "conflicting"].includes(disposition)) {
        throw new TypeError("Unsupported feedback disposition.");
      }
      const entry = {
        id: createId(),
        runId,
        productId,
        reviewerId,
        disposition,
        note: typeof note === "string" ? note.trim() : "",
        ...(correction && typeof correction === "object" ? { correction } : {}),
        status: "pending-review",
        createdAt: now(),
      };
      entries.push(entry);
      return entry;
    },

    list({ productId, status = "pending-review" } = {}) {
      return entries.filter((entry) =>
        (!productId || entry.productId === productId)
        && (!status || entry.status === status));
    },
  };
}
