export interface EventProject {
  id: string;
  name: string;
}

export interface FlakyTransitionEvent {
  kind: 'flaky_transition';
  project: EventProject;
  newlyFlaky: string[];
  newlyResolved: string[];
  run: { branch: string; commitSha: string };
}

export interface QuarantineEvent {
  kind: 'quarantine';
  transition: 'entered' | 'released';
  project: EventProject;
  testName: string;
  flakeRate: number | null;
  expiresAt: Date | null; // set only for 'entered'
}

export type NotificationEvent = FlakyTransitionEvent | QuarantineEvent;
