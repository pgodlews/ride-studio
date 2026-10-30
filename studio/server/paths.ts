import { join } from 'node:path';
import type { StudioPaths } from './plugin';

/** Desktop libraries live in userData; application code and bundled assets stay read-only. */
export const ridesDir = (paths: StudioPaths) => join(paths.dataRoot ?? paths.studio, 'public/data/rides');
