'use strict';
// HARD-SEP scenarios (Codex #5): give distillation a FAIR test on cases where raw retrieval should genuinely FAIL.
// Dominant family = TEMPORAL CONFLICT: raw events contain BOTH a stale (superseded) value and the current one;
//   raw FTS top-1 retrieves by relevance (not recency) so it can surface the STALE value -> wrong artifact.
//   The distilled claim encodes the CURRENT (resolved) value -> right. This tests the "stale-vs-current/conflict"
//   justification the pilot did NOT test. NOT rigged: A4 can still retrieve the current event; A7 wins by the
//   fraction A4 retrieves stale. truth=current, wrong=stale (also A7p), required=current, forbidden=stale.
// Pre-registered/frozen.

const SCENARIOS_HARD = [
  { id:'h01', family:'test-framework', kind:'inferred', page:'UserConstraints', slot:'testing',
    subject:'user', predicate:'test runner', truth:'node --test', wrong:'jest',
    rawEvents:["early on we standardized on jest as the test framework across the repo",
               "we switched the whole repo to node --test last sprint and removed jest"],
    task:"Add a test for utils.add(). Output the test-run command.",
    required:/node\s*--test|node:test/i, forbidden:/\bjest\b/i, distractorSlotMate:'coverage 80%' },
  { id:'h02', family:'orm', kind:'inferred', page:'UserConstraints', slot:'data',
    subject:'user', predicate:'db access', truth:'raw better-sqlite3 prepared statements', wrong:'Prisma ORM',
    rawEvents:["we built the data layer on Prisma ORM initially with a full schema",
               "we ripped Prisma out and moved to raw better-sqlite3 prepared statements"],
    task:"Add a query to fetch active users. Output the data-access snippet.",
    required:/prepare\(|better-sqlite3|SELECT/i, forbidden:/prisma|\.findMany|queryBuilder/i, distractorSlotMate:'numbered .sql migrations' },
  { id:'h03', family:'branching', kind:'inferred', page:'UserConstraints', slot:'git',
    subject:'user', predicate:'branching', truth:'always cut a feature branch first', wrong:'commit directly to main',
    rawEvents:["for the prototype phase committing directly to main was fine and faster",
               "we are past prototype now — always cut a feature branch first, never touch main directly"],
    task:"You are about to start a change. Output the first git command you run.",
    required:/checkout -b|switch -c/i, forbidden:/commit.*main|push origin main|^git commit/i, distractorSlotMate:'squash on merge' },
  { id:'h04', family:'deploy', kind:'inferred', page:'ProjectFacts', slot:'ops',
    subject:'project', predicate:'deploy method', truth:'CI pipeline (gh workflow)', wrong:'deploy.sh bash script',
    rawEvents:["deploys used to be done by running the deploy.sh bash script on the box",
               "deploys now go through the CI pipeline only; the deploy.sh script is deprecated"],
    task:"How do I ship the current build? Output the one command/action.",
    required:/ci|pipeline|workflow|gh /i, forbidden:/deploy\.sh|bash .*deploy|\.\/deploy/i, distractorSlotMate:'staging before prod' },
  { id:'h05', family:'style-indent', kind:'inferred', page:'UserConstraints', slot:'style',
    subject:'user', predicate:'indentation', truth:'2 spaces', wrong:'tabs',
    rawEvents:["the old codebase used tabs for indentation everywhere",
               "we reformatted to 2-space indentation repo-wide and enforce it now"],
    task:"Write an example function body line with proper indentation. Output the indented line.",
    required:/^ {2}\S/m, forbidden:/^\t/m, distractorSlotMate:'semicolons required' },
  { id:'h06', family:'pkg-mgr', kind:'inferred', page:'ProjectFacts', slot:'runtime',
    subject:'project', predicate:'package manager', truth:'npm', wrong:'yarn',
    rawEvents:["the repo was set up with yarn and a yarn.lock originally",
               "we migrated off yarn to npm; use npm and package-lock.json now"],
    task:"Give the command to install a new dependency 'foo'. Output the command.",
    required:/npm (install|i|add)/i, forbidden:/yarn/i, distractorSlotMate:'node 22' },
  { id:'h07', family:'lang', kind:'inferred', page:'UserConstraints', slot:'communication',
    subject:'user', predicate:'response language', truth:'Korean', wrong:'English',
    rawEvents:["at the start I said English replies were fine for this project",
               "from now on always reply to me in Korean, even when I write English"],
    task:"Acknowledge a task in one sentence. Output that sentence.",
    required:/[가-힣]/, forbidden:/^[\x00-\x7F\s]*$/, distractorSlotMate:'no emojis' },
  { id:'h08', family:'error-style', kind:'inferred', page:'UserConstraints', slot:'reliability',
    subject:'user', predicate:'error handling', truth:'fail-closed: throw', wrong:'log and continue',
    rawEvents:["in the early scripts it was ok to just log an error and continue",
               "in the service layer now: fail-closed, throw and propagate — never swallow"],
    task:"Handle a failed DB write in a service function. Output the catch block.",
    required:/throw|reject|propagate/i, forbidden:/return null|\/\/ ignore|console\.log\([^)]*\);?\s*}/i, distractorSlotMate:'30s timeout' },
  // aggregation: answer requires combining multiple events; no single event states it AND top-1 lacks it
  { id:'h09', family:'dep-policy', kind:'inferred', page:'UserConstraints', slot:'deps',
    subject:'user', predicate:'dependency policy', truth:'zero new runtime deps (vendor/built-in only)', wrong:'add npm deps freely',
    rawEvents:["rejected the PR adding lodash","rejected the PR adding axios","we keep node_modules tiny on purpose","the whole frontend is vendored, no CDN"],
    task:"You need a debounce helper. Output the one-line approach you take.",
    required:/inline|hand-?roll|vendor|own |util|setTimeout/i, forbidden:/npm i|install lodash|add .*dependency|import .* from ['"]lodash/i, distractorSlotMate:'small PRs' },
  // distractor: a salient unrelated event dominates FTS for the query term
  { id:'h10', family:'review-policy', kind:'inferred', page:'UserConstraints', slot:'workflow',
    subject:'user', predicate:'merge policy', truth:'require codex cross-review PASS before merge', wrong:'merge after CI green',
    rawEvents:["our CI runs the full test suite and must be green, lots of detail about the test matrix and coverage gates and flaky retries",
               "no merge until codex cross-review returns PASS"],
    task:"State the precondition to merge a PR. Output the one-line rule.",
    required:/codex|cross-review|review PASS/i, forbidden:/^(merge|ok).*(ci|green|test)/i, distractorSlotMate:'rebase not merge' },
];

module.exports = { SCENARIOS_HARD };
