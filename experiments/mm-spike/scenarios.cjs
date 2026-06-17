'use strict';
// PRE-REGISTERED scenario set for the kill-test spike (initial validation batch; expand to 40-60 before LLM run per Codex).
// Regexes FROZEN before any LLM generation. Do not tune after seeing generations.
//
// kind 'explicit'  = the decisive answer is stated in a raw event  -> A4 (raw FTS) should expose it -> A4≈A7 (distillation adds little). SAT.
// kind 'inferred'  = the answer is only IMPLIED across noisy events -> A4 should NOT expose it -> only the distilled claim (A7) is decisive. SEP.
//
// fields:
//  truth     = correct object (what A7 injects)
//  wrong     = plausible-but-wrong object (A7p same-format placebo — anchor-leakage control, Codex must-fix #4)
//  rawEvents = noisy original text (A4 retrieves over these)
//  task      = single-artifact prompt (Codex must-fix #2)
//  decisive  = /regex/ : presence == decisive answer exposed (leakage audit)
//  required / forbidden = artifact compliance checks (Stage-1 LLM scoring; refined w/ artifact-extraction before run)
//  distractorSlotMate = a same-slot wrong-topic object (for A5c placebo realism)

const SCENARIOS = [
  // ---------- explicit (expect A4 leak -> SAT) ----------
  { id:'sc01', family:'test-runner', kind:'explicit', page:'UserConstraints', slot:'testing',
    subject:'user', predicate:'preferred test runner', truth:'node --test', wrong:'jest',
    rawEvents:["sure, wire up utils however — and remember I always run tests with node --test, never jest, keep deps lean"],
    task:"Add a test for utils.add(). Output ONLY the test-run command line.",
    decisive:/node\s*--test|node:test/i, required:/node\s*--test|node:test/i, forbidden:/\bjest\b|vitest|mocha/i,
    distractorSlotMate:'coverage threshold 80%' },
  { id:'sc02', family:'commit-trailer', kind:'explicit', page:'UserConstraints', slot:'git',
    subject:'user', predicate:'commit message trailer', truth:'Co-Authored-By line at the end', wrong:'Signed-off-by line',
    rawEvents:["one rule for commits: every message must end with a Co-Authored-By line, no exceptions"],
    task:"Write a one-line commit message for a bugfix, then the trailer. Output ONLY the commit message block.",
    decisive:/Co-Authored-By/i, required:/Co-Authored-By/i, forbidden:/Signed-off-by/i,
    distractorSlotMate:'rebase, never merge commits' },
  { id:'sc03', family:'no-cdn', kind:'explicit', page:'UserConstraints', slot:'frontend',
    subject:'user', predicate:'asset loading policy', truth:'vendor libraries locally, no CDN', wrong:'load from jsDelivr CDN',
    rawEvents:["hard rule for the frontend: never load libraries from a CDN, vendor everything locally under /vendor"],
    task:"Add charting lib to a page. Output ONLY the single <script> or import line you'd use.",
    decisive:/vendor|self-host|locally|\/vendor/i, required:/vendor|\.\/|\/vendor|local/i, forbidden:/https?:\/\/|cdn|jsdelivr|unpkg|googleapis/i,
    distractorSlotMate:'dark mode default on' },
  { id:'sc04', family:'delegate-pm', kind:'explicit', page:'UserConstraints', slot:'workflow',
    subject:'user', predicate:'delegation policy', truth:'delegate through the PM, never spawn workers directly', wrong:'spawn workers directly for speed',
    rawEvents:["workflow rule: the main manager must always delegate work through the PM, never spawn workers directly"],
    task:"You must delegate a coding task. Output ONLY the one-line action you take.",
    decisive:/through the pm|via the pm|to the pm/i, required:/pm/i, forbidden:/spawn .*worker|directly/i,
    distractorSlotMate:'standups are async' },
  { id:'sc05', family:'node-version', kind:'explicit', page:'ProjectFacts', slot:'runtime',
    subject:'palantir-console', predicate:'node runtime', truth:'node 22', wrong:'node 26',
    rawEvents:["heads up: this project runs on node 22 — better-sqlite3 ABI breaks if you use node 26"],
    task:"State the node version to use in CI. Output ONLY the version (e.g. 'node XX').",
    decisive:/node\s*22|node@22/i, required:/22/, forbidden:/\b26\b|\b20\b|\b18\b/,
    distractorSlotMate:'package manager is npm' },
  { id:'sc06', family:'lang', kind:'explicit', page:'UserConstraints', slot:'communication',
    subject:'user', predicate:'response language', truth:'Korean', wrong:'English',
    rawEvents:["just so you know, always respond to me in Korean even if I write in English"],
    task:"Acknowledge a task in one sentence. Output ONLY that sentence.",
    decisive:/korean|한국어/i, required:/[가-힣]/, forbidden:/^[\x00-\x7F\s]*$/,
    distractorSlotMate:'no emojis in replies' },

  // ---------- inferred (expect NO A4 leak -> SEP, tests distillation value) ----------
  { id:'sc07', family:'test-runner', kind:'inferred', page:'UserConstraints', slot:'testing',
    subject:'user', predicate:'preferred test runner', truth:'node --test', wrong:'jest',
    rawEvents:["rejected the PR that added jest to devDependencies","let's keep the dependency tree minimal","the built-in standard-library test tooling is plenty here"],
    task:"Add a test for utils.add(). Output ONLY the test-run command line.",
    decisive:/node\s*--test|node:test/i, required:/node\s*--test|node:test/i, forbidden:/\bjest\b|vitest|mocha/i,
    distractorSlotMate:'coverage threshold 80%' },
  { id:'sc08', family:'commit-trailer', kind:'inferred', page:'UserConstraints', slot:'git',
    subject:'user', predicate:'commit message trailer', truth:'Co-Authored-By line at the end', wrong:'Signed-off-by line',
    rawEvents:["you keep dropping the attribution trailer on my commits","make sure the co-author credit stays on every commit"],
    task:"Write a one-line commit message for a bugfix, then the trailer. Output ONLY the commit message block.",
    decisive:/Co-Authored-By/i, required:/Co-Authored-By/i, forbidden:/Signed-off-by/i,
    distractorSlotMate:'rebase, never merge commits' },
  { id:'sc09', family:'no-orm', kind:'inferred', page:'UserConstraints', slot:'data',
    subject:'user', predicate:'database access style', truth:'raw SQL via better-sqlite3, no ORM', wrong:'use Prisma ORM',
    rawEvents:["we ripped out sequelize last quarter and never looked back","raw queries are way easier to debug here","no more query-builder magic please"],
    task:"Add a query to fetch active users. Output ONLY the data-access line/snippet.",
    decisive:/raw sql|better-sqlite3|prepared statement|no orm/i, required:/SELECT|prepare\(|raw|sql/i, forbidden:/prisma|sequelize|typeorm|drizzle|\.findMany|queryBuilder/i,
    distractorSlotMate:'migrations are numbered .sql files' },
  { id:'sc10', family:'error-handling', kind:'inferred', page:'UserConstraints', slot:'reliability',
    subject:'user', predicate:'error handling style', truth:'fail-closed: throw, never swallow', wrong:'log and continue silently',
    rawEvents:["I hate when errors get swallowed","that silent catch bit us in prod last month","don't just log it and move on"],
    task:"Handle a failed DB write in a service fn. Output ONLY the catch block.",
    decisive:/fail-closed|throw |re-?throw|propagate/i, required:/throw|reject|propagate/i, forbidden:/return null|console\.log.*;?\s*}|\/\/ ignore|swallow/i,
    distractorSlotMate:'timeouts default 30s' },
  { id:'sc11', family:'branch-naming', kind:'inferred', page:'UserConstraints', slot:'git',
    subject:'user', predicate:'branch naming convention', truth:'prefix branches feat/ or docs/ before committing', wrong:'commit directly to main',
    rawEvents:["please don't commit straight to main again","cut a branch first next time","main should stay clean"],
    task:"You're about to start a docs change. Output ONLY the git branch command you run first.",
    decisive:/feat\/|docs\/|fix\/|prefix/i, required:/checkout -b|switch -c|branch/i, forbidden:/commit.*main|push origin main/i,
    distractorSlotMate:'squash on merge' },
  { id:'sc12', family:'response-format', kind:'inferred', page:'UserConstraints', slot:'communication',
    subject:'user', predicate:'answer format', truth:'concise bullet points, no prose', wrong:'long prose explanations',
    rawEvents:["tl;dr please","stop writing essays at me","just give me the key points"],
    task:"Summarize what a deploy script does. Output ONLY your answer.",
    decisive:/bullet|concise|terse|key points only/i, required:/^\s*[-*•]/m, forbidden:/\n\n[A-Z][^-*•\n]{120,}/,
    distractorSlotMate:'use code blocks for commands' },
];

module.exports = { SCENARIOS };
