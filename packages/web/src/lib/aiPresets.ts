/**
 * One-click tasks for the agent: the stages of the problem-building pipeline
 * (DESIGN §4.4) plus statement translation and linting (§4.5, §4.6). Prompts are in
 * English for the model; the agent answers in the UI language.
 */
export interface AiPreset {
  key: string;
  prompt: string;
}

export const FULL_BUILD =
  'Build the complete problem from its statement, following the workflow in your instructions: validator with validator tests, main solution, brute force, generators and script, checker, wrong solutions, then verify everything with the tools (all tests valid, every solution matches its tag, std agrees with brute on small tests) and fix what fails. Keep a plan with update_plan. Finish with a short report of what was built and verified and what needs human attention.';

export const PRESETS: AiPreset[] = [
  { key: 'full', prompt: FULL_BUILD },
  {
    key: 'analyze',
    prompt:
      'Read the statement and summarise: input format, every constraint (including global ones), output format, whether the answer is unique (std checker) or needs a custom checker, and anything ambiguous or missing. Do not change files.',
  },
  {
    key: 'validator',
    prompt:
      'Write or fix validator.cpp so that it strictly enforces every constraint of the statement, and add validator-tests (valid and invalid cases, incl. boundary values). Run run_validator_tests and fix until all pass.',
  },
  { key: 'std', prompt: 'Write or fix solutions/std.cpp (tag MA): a correct, efficient solution. Compile it and run it on the samples.' },
  {
    key: 'brute',
    prompt:
      'Write solutions/brute.cpp: an obviously correct brute force (tag TL-OR-OK, or OK if fast enough). Generate tests and run an invocation of std and brute; investigate any disagreement.',
  },
  {
    key: 'tests',
    prompt:
      'Write or improve generators and tests/script.txt: small random tests, edge cases (minimum sizes, equal values, extremes), maximum-size tests and special structures that break wrong approaches; keep the samples as manual tests. Generate the tests and make sure all are valid.',
  },
  {
    key: 'checker',
    prompt:
      'Decide whether a standard checker fits. If not, write checker.cpp with checker-tests (ok / wa / pe cases) and run run_checker_tests. Set [checker] in problem.toml accordingly.',
  },
  {
    key: 'wrong',
    prompt:
      'Add wrong solutions for typical mistakes (overflow, off-by-one, wrong greedy, too slow, …) with tags WA/TL/RE/ML. Run an invocation; if a wrong solution passes, strengthen the tests until it fails.',
  },
  {
    key: 'verify',
    prompt:
      'Verify the whole problem: compile every program, generate tests, run validator and checker tests and a full invocation. Fix whatever fails, then report the results.',
  },
  {
    key: 'translate',
    prompt:
      'Translate the statement to the other language (zh ⇄ en), keeping the Polygon LaTeX formatting, formulas and macros unchanged, and write it into the corresponding statement/<lang>/ files. Also fill in the title in problem.toml.',
  },
  {
    key: 'lint',
    prompt:
      'Review the statement files for Polygon LaTeX problems: Markdown syntax (**bold**, `code`, # headings) instead of LaTeX, "<=" instead of \\le, math outside $…$, unbalanced braces, inconsistent notation between sections and languages, spacing around formulas in Chinese text. Fix them.',
  },
];

export function pastedStatementPrompt(statement: string): string {
  return `Here is the problem statement:\n\n<statement>\n${statement}\n</statement>\n\nFirst write it into statement/zh/ and statement/en/ (legend, input, output, notes; interaction if interactive) in Polygon LaTeX, set the titles and limits in problem.toml. Then: ${FULL_BUILD}`;
}
