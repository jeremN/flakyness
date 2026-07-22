import { resolveProjectConfig, type ProjectFlakinessOverrides } from './flakiness';

export interface QuarantineConfig {
  enabled: boolean;
  threshold: number;
  minRuns: number;
  ttlDays: number;
}

export const DEFAULT_QUARANTINE = { threshold: 0.2, ttlDays: 7 } as const;

/** Fields of a projects row this module reads. */
export interface ProjectQuarantineOverrides extends ProjectFlakinessOverrides {
  autoQuarantineEnabled: boolean;
  quarantineThreshold: string | null; // drizzle decimal -> string
  quarantineMinRuns: number | null;
  quarantineTtlDays: number | null;
}

/** Merge stored overrides (NULL = unset) over defaults. minRuns falls back to
 *  the resolved flakiness minRuns; threshold/ttl to the quarantine defaults. */
export function resolveQuarantineConfig(project: ProjectQuarantineOverrides): QuarantineConfig {
  const flakiness = resolveProjectConfig(project);
  return {
    enabled: project.autoQuarantineEnabled,
    threshold:
      project.quarantineThreshold !== null ? Number(project.quarantineThreshold) : DEFAULT_QUARANTINE.threshold,
    minRuns: project.quarantineMinRuns ?? flakiness.minRuns,
    ttlDays: project.quarantineTtlDays ?? DEFAULT_QUARANTINE.ttlDays,
  };
}
