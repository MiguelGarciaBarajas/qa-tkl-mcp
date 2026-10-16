import { randomUUID } from "node:crypto";

const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|credential|api[-_]?key)/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createCorrelationId() {
  return randomUUID();
}

export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(entry)
    ])
  );
}

export function createAuditLogger({ sink = console } = {}) {
  if (!sink || typeof sink.info !== "function") {
    throw new Error("Audit sink must provide an info(event) function.");
  }

  return {
    async record(event) {
      if (!isRecord(event) || typeof event.eventType !== "string") {
        throw new Error("Audit event must include an eventType.");
      }
      const safeEvent = redact({
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString()
      });
      await sink.info(safeEvent);
      return safeEvent;
    }
  };
}

const HEALTHY_STATUSES = new Set(["healthy", "ok"]);

/**
 * Correlates health/metrics reported by connectors, the application composition,
 * the API, and the MCP gateway into a single redacted report. Components register
 * their own health snapshots (e.g. a connector's `health()` result); this registry
 * never calls a source system itself, it only aggregates already-computed values.
 */
export function createHealthRegistry({ correlationId = createCorrelationId() } = {}) {
  const components = new Map();

  return {
    record(component, health) {
      if (typeof component !== "string" || component.length === 0) {
        throw new TypeError("A component name is required to record health.");
      }
      if (!isRecord(health) || typeof health.status !== "string") {
        throw new TypeError("Component health must include a string status.");
      }
      components.set(
        component,
        redact({ ...health, checkedAt: health.checkedAt ?? new Date().toISOString() })
      );
    },

    report() {
      const entries = [...components.entries()].map(([component, health]) => ({
        component,
        ...health
      }));
      const status =
        entries.length === 0
          ? "unknown"
          : entries.every((entry) => HEALTHY_STATUSES.has(entry.status))
            ? "healthy"
            : "degraded";
      return { correlationId, status, components: entries };
    }
  };
}
