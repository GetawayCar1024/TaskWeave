/**
 * Local check messages by code. The server fills `message` from these (English, also
 * what the AI sees); the web UI translates by `code` with the same `{param}` names.
 */
export const CHECK_TEXT = {
  noStatement: 'No statement written yet',
  missingSection: '{lang} statement has no {section} section',
  noInteraction: 'Interactive problem without an interaction section ({lang})',
  noTitle: 'No {lang} title in problem.toml',
  missingTutorial: 'Statement language {lang} has no tutorial',
  orphanTutorial: 'Tutorial in {lang}, but there is no {lang} statement',
  formatting: '{n} formatting issue(s): {rules}',
  formattingFixable: '{n} formatting issue(s), all auto-fixable: {rules}',
  noValidator: 'No validator',
  noChecker: 'No checker',
  noInteractor: 'Interactive problem without an interactor',
  noGrader: 'Grader problem without grader sources',
  severalMain: 'More than one MA solution',
  noMain: 'No main solution (tag MA)',
  solutionMissing: 'Listed solution is missing: {file}',
  oneSolution: 'Only one solution: add a brute force and wrong solutions to check the tests',
  noTests: 'No tests: add manual tests or tests/script.txt',
  noSamples: 'No sample tests (tests.samples)',
  noValidatorTests: 'No validator tests',
  generation: 'Last test generation: {error}',
  testsetEmpty: 'Testset {testset} has no tests',
  groupsUndefined: 'Groups are enabled{where} but none is defined',
  looseTests: 'Tests outside every group{where}: {list}',
  groupEmpty: 'Group {group}{where} has no tests',
  groupMissingTests: 'Group {group}{where} refers to missing tests {list}',
  groupsWithoutPoints: 'Groups without points: {list}',
  pointsSum: 'Group points add up to {sum}, not 100',
} as const;

export type CheckCode = keyof typeof CHECK_TEXT;
export type CheckParams = Record<string, string | number>;

/** Fill a `{param}` template. */
export function fillTemplate(template: string, params: CheckParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : ''));
}

export const checkText = (code: CheckCode, params?: CheckParams) => fillTemplate(CHECK_TEXT[code], params);
