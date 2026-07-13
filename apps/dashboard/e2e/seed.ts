import { readFileSync } from 'node:fs';
import { SEED_PATH } from './global-setup';

interface Seed {
  projectId: string;
  projectName: string;
}

/**
 * Read the project global-setup seeded (see global-setup.ts). Every spec
 * needs this — specs never create their own data, so they can't step on
 * each other when run in parallel.
 */
export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_PATH, 'utf-8')) as Seed;
}
