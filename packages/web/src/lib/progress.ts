import type { ProblemSummary } from '@polyforge/shared';

/** Completion checklist shown on problem cards and the contest table. */
export function checklist(p: ProblemSummary) {
  const s = p.status;
  return [
    { key: 'statement', ok: s.statement },
    { key: 'tutorial', ok: s.statementLangs.length > 0 && s.statementLangs.every((x) => s.tutorialLangs.includes(x)) && s.tutorialLangs.every((x) => s.statementLangs.includes(x)) },
    { key: 'validator', ok: s.validator },
    { key: 'checker', ok: s.checker },
    { key: 'std', ok: s.std },
    { key: 'tests', ok: s.manualTests > 0 || s.hasScript },
    { key: 'synced', ok: s.polygonId !== undefined },
  ];
}

export function progress(p: ProblemSummary): number {
  const items = checklist(p);
  return Math.round((items.filter((c) => c.ok).length / items.length) * 100);
}
