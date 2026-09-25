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
    key: 'tutorial',
    prompt:
      'Write the tutorial (editorial) as statement/<lang>/tutorial.tex for every language that has a statement, and only those. Explain the key idea, the algorithm and its complexity, consistent with solutions/std.cpp; use Polygon LaTeX and keep the language versions equivalent.',
  },
  {
    key: 'translate',
    prompt:
      'Translate the statement and the tutorial to the other language (zh ⇄ en), keeping the Polygon LaTeX formatting, formulas and macros unchanged, and write it into the corresponding statement/<lang>/ files. Also fill in the title in problem.toml.',
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

/** Contest-wide tasks; `{lang}` is replaced by the language picked next to the buttons. */
export interface ContestPreset extends AiPreset {
  needsLang?: boolean;
}

export const CONTEST_PRESETS: ContestPreset[] = [
  {
    key: 'statementsIn',
    needsLang: true,
    prompt:
      'For every problem of the contest, write the statement in language "{lang}" as statement/{lang}/ (legend, input, output, notes; interaction / scoring where the problem has them), translating from the existing statement languages. Keep the Polygon LaTeX formatting, formulas and macros unchanged, and set title.{lang} in problem.toml. Skip problems that already have a complete {lang} statement, and say which ones you skipped.',
  },
  {
    key: 'tutorialsIn',
    needsLang: true,
    prompt:
      'For every problem of the contest, write the tutorial in language "{lang}" as statement/{lang}/tutorial.tex: translate an existing tutorial if there is one, otherwise write it from the statement and solutions/std.cpp (key idea, algorithm, complexity). Only for problems that have a {lang} statement; mention the ones without.',
  },
  {
    key: 'tutorials',
    prompt:
      'For every problem, make sure there is a tutorial for each statement language (and none for languages without a statement): write missing ones consistent with solutions/std.cpp, keep the language versions equivalent.',
  },
  {
    key: 'titles',
    prompt: 'Make sure every problem has a title in problem.toml for each of its statement languages, translated consistently; fix missing or mismatched titles.',
  },
  {
    key: 'consistency',
    prompt:
      'Make the statements of all problems consistent with each other: the same wording for recurring phrases (input/output descriptions, multi-test format, "It is guaranteed that …"), the same notation and macro usage, the same formatting of constraints and samples explanations. Change only what is needed.',
  },
  {
    key: 'lint',
    prompt:
      'Review the statement and tutorial files of every problem for Polygon LaTeX problems: Markdown syntax instead of LaTeX, "<=" instead of \le, math outside $…$, unbalanced braces, spacing around formulas in Chinese text, inconsistencies between languages. Fix them.',
  },
  {
    key: 'verify',
    prompt:
      'Verify every problem of the contest: compile the programs, generate the tests, run validator / checker tests and a full invocation. Fix what is clearly broken, and finish with one line per problem (letter, status, what needs attention).',
  },
  {
    key: 'overview',
    prompt:
      'Give an overview of the contest without changing files: for each problem one or two sentences on the task, the intended solution and its difficulty; then whether the letter order matches the difficulty, and any problems that are too similar.',
  },
];
