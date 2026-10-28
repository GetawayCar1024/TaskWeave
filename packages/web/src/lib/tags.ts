import type { SolutionTag } from '@taskweave/shared';

type TagType = 'success' | 'info' | 'warning' | 'error' | 'default';

export function tagType(tag: SolutionTag): TagType {
  switch (tag) {
    case 'MA':
    case 'OK':
      return 'success';
    case 'TL-OR-OK':
      return 'info';
    case 'TL':
    case 'ML':
    case 'TM':
      return 'warning';
    case 'RJ':
    case 'FL':
    case 'NR':
      return 'default';
    default:
      return 'error';
  }
}
