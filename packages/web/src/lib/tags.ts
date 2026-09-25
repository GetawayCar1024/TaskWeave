import type { SolutionTag } from '@polyforge/shared';

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
      return 'warning';
    case 'RJ':
    case 'FL':
      return 'default';
    default:
      return 'error';
  }
}
