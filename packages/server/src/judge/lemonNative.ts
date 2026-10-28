import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LEMON_COMPARISON_MODES, type LemonComparison } from '@taskweave/shared';

/** Other platforms use a standalone three-file checker; native CDF still uses modes 0/1/3. */
export async function lemonNativeSource(shared: string, options: LemonComparison): Promise<string> {
  return `#define TASKWEAVE_LEMON_MODE ${LEMON_COMPARISON_MODES[options.mode]}\n#define TASKWEAVE_LEMON_PRECISION ${options.precision}\n` + await fs.readFile(path.join(shared, 'lemon-native/comparator.cpp'), 'utf8');
}
