'use strict';
// SCALE-STRESS scenarios: test the UNTESTED data-management justification (dedup/maintenance at scale).
// LARGE evolving history on ONE topic = MANY stale same-topic statements + ONE current.
// Hypothesis: raw FTS top-K can't isolate the current fact among stale variants -> deduped current claim (A7) wins.
// PENDING Codex fairness review before any LLM run; 0-LLM audit (audit-scale.cjs) runs first.
// Reuses truth/wrong/required/forbidden from the hard TRAP families. Stale variants are realistic evolving opinions,
// NOT adversarially keyword-stuffed (fairness constraint).

const SCENARIOS_SCALE = [
  { id:'s01', family:'test-framework', page:'UserConstraints', slot:'testing',
    subject:'user', predicate:'test runner', truth:'node --test', wrong:'jest',
    staleHistory:["early on we considered mocha for tests","tried ava for a couple modules","jest became our default test framework for a while",
      "long jest-vs-mocha debate in standup","jest snapshot tests were handy","someone floated jasmine","tap was suggested once",
      "the jest config kept growing","we discussed test coverage gates with jest","CI ran the jest suite nightly"],
    current:"we standardized on node --test (the built-in runner) and removed jest and all other test frameworks",
    task:"Add a test for utils.add(). Output the test-run command.",
    required:/node\s*--test|node:test/i, forbidden:/\bjest\b|mocha|ava|jasmine/i },
  { id:'s02', family:'orm', page:'UserConstraints', slot:'data',
    subject:'user', predicate:'db access', truth:'raw better-sqlite3 prepared statements', wrong:'Prisma ORM',
    staleHistory:["we started with Sequelize for the models","migrated models to Prisma for type-safety","Prisma schema got large",
      "debated Prisma vs Drizzle","TypeORM was used in an old service","Knex query-builder in another corner","Prisma migrations were slow",
      "discussed an ORM abstraction layer","Prisma client generation in CI","ORM caching questions came up"],
    current:"we removed Prisma and all ORMs; the data layer is raw better-sqlite3 prepared statements only",
    task:"Add a query to fetch active users. Output the data-access snippet.",
    required:/prepare\(|better-sqlite3|SELECT/i, forbidden:/prisma|sequelize|typeorm|drizzle|knex|\.findMany/i },
  { id:'s03', family:'deploy', page:'ProjectFacts', slot:'ops',
    subject:'project', predicate:'deploy method', truth:'CI pipeline (gh workflow)', wrong:'deploy.sh bash script',
    staleHistory:["deploys started as a manual deploy.sh on the box","wrote a fancier deploy.sh with rollback","deploy.sh had a staging flag",
      "discussed Capistrano","tried a Makefile deploy target","scp-based deploy for a hotfix once","deploy.sh logging improved",
      "cron-triggered deploy.sh experiment","deploy.sh env handling debated","talked about blue-green with the script"],
    current:"deploys now run only through the CI pipeline (gh workflow); the deploy.sh script is deprecated and removed",
    task:"How do I ship the current build? Output the one command/action.",
    required:/ci|pipeline|workflow|gh /i, forbidden:/deploy\.sh|bash .*deploy|\.\/deploy|capistrano|makefile/i },
  { id:'s04', family:'pkg-mgr', page:'ProjectFacts', slot:'runtime',
    subject:'project', predicate:'package manager', truth:'npm', wrong:'yarn',
    staleHistory:["repo was set up with yarn and yarn.lock","yarn workspaces for the monorepo","debated yarn vs pnpm",
      "pnpm tried for disk savings","yarn berry PnP experiment","yarn resolutions used to pin a dep","yarn cache issues in CI",
      "discussed bun as a runner","yarn upgrade interactive was handy","lockfile conflicts with yarn"],
    current:"we migrated off yarn to npm; use npm and package-lock.json exclusively now",
    task:"Give the command to install a new dependency 'foo'. Output the command.",
    required:/npm (install|i|add)/i, forbidden:/yarn|pnpm|bun /i },
  { id:'s05', family:'lang', page:'UserConstraints', slot:'communication',
    subject:'user', predicate:'response language', truth:'Korean', wrong:'English',
    staleHistory:["at kickoff English replies were fine","some docs were written in English","English for code comments",
      "debated bilingual docs","English in the early standups","commit messages in English","English variable naming",
      "English for the README","English in PR descriptions","English error messages"],
    current:"from now on always reply to me in Korean, even when I write in English",
    task:"Acknowledge a task in one sentence. Output that sentence.",
    required:/[가-힣]/, forbidden:/^[\x00-\x7F\s]*$/ },
];

// build the full event list: stale history first, current last (recency irrelevant to FTS bm25)
function historyOf(sc) { return [...sc.staleHistory, sc.current]; }

module.exports = { SCENARIOS_SCALE, historyOf };
