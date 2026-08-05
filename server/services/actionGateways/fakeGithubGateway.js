'use strict';

const STATUS_BY_KIND = Object.freeze({
  not_found_repo: 404,
  validation_error: 422,
  rate_limited: 429,
  abuse_denied: 403,
  server_error: 500,
});

class FakeGithubGatewayError extends Error {
  constructor(kind, operation, behavior = {}) {
    super(behavior.message || `fake GitHub ${operation} fault: ${kind}`);
    this.name = 'FakeGithubGatewayError';
    this.kind = kind;
    this.operation = operation;
    this.statusCode = behavior.statusCode ?? behavior.status ?? STATUS_BY_KIND[kind] ?? null;
    this.code = behavior.code ?? (kind === 'timeout' || kind === 'response_lost'
      ? 'ETIMEDOUT'
      : null);
  }
}

function cloneIssue(issue) {
  if (!issue) return issue;
  return {
    ...issue,
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => (
        label && typeof label === 'object' ? { ...label } : label
      ))
      : issue.labels,
  };
}

function createFakeGithubGateway(script = {}) {
  const queues = {
    createIssue: Array.isArray(script.createIssue) ? [...script.createIssue] : [],
    getIssue: Array.isArray(script.getIssue) ? [...script.getIssue] : [],
    searchIssuesByMarker: Array.isArray(script.searchIssuesByMarker)
      ? [...script.searchIssuesByMarker]
      : [],
  };
  let nextNumber = Number.isSafeInteger(script.seed) ? script.seed : 1;
  let postCount = 0;
  let getCount = 0;
  let searchCount = 0;
  const byRepoAndNumber = new Map();
  const byNodeId = new Map();

  function nextBehavior(operation) {
    return queues[operation].length > 0 ? queues[operation].shift() : { kind: 'ok' };
  }

  function issueKey(repo, number) {
    return `${repo}#${number}`;
  }

  function storeIssue(issue) {
    const stored = cloneIssue(issue);
    byRepoAndNumber.set(issueKey(stored.repo, stored.number), stored);
    if (stored.node_id != null) byNodeId.set(String(stored.node_id), stored);
    return cloneIssue(stored);
  }

  function makeIssue(input, behavior) {
    const number = behavior.issue && behavior.issue.number !== undefined
      ? behavior.issue.number
      : nextNumber++;
    return {
      number,
      node_id: `FAKE_NODE_${number}`,
      html_url: `https://github.test/${input.repo}/issues/${number}`,
      state: 'open',
      repo: input.repo,
      title: input.title,
      body: input.body,
      labels: Array.isArray(input.labels) ? [...input.labels] : [],
      ...(behavior.issue || {}),
    };
  }

  async function createIssue(input) {
    postCount += 1;
    const behavior = nextBehavior('createIssue');
    const kind = behavior.kind || 'ok';
    if (kind === 'ok') return storeIssue(makeIssue(input, behavior));
    if (kind === 'response_lost' || kind === 'malformed') {
      storeIssue(makeIssue(input, behavior));
    }
    throw new FakeGithubGatewayError(kind, 'createIssue', behavior);
  }

  async function getIssue(input) {
    getCount += 1;
    const behavior = nextBehavior('getIssue');
    const kind = behavior.kind || 'ok';
    if (kind !== 'ok') throw new FakeGithubGatewayError(kind, 'getIssue', behavior);
    if (behavior.issue) return cloneIssue(behavior.issue);
    const stored = input.node_id != null
      ? byNodeId.get(String(input.node_id))
      : byRepoAndNumber.get(issueKey(input.repo, input.number));
    if (!stored) {
      throw new FakeGithubGatewayError('not_found_repo', 'getIssue', {
        message: 'fake GitHub issue not found',
      });
    }
    return cloneIssue(stored);
  }

  for (const issue of Array.isArray(script.issues) ? script.issues : []) {
    storeIssue(issue);
  }

  async function searchIssuesByMarker(input) {
    searchCount += 1;
    const behavior = nextBehavior('searchIssuesByMarker');
    if (Array.isArray(behavior)) return behavior.map(cloneIssue);
    const kind = behavior.kind || 'ok';
    if (kind !== 'ok') {
      throw new FakeGithubGatewayError(kind, 'searchIssuesByMarker', behavior);
    }
    const scriptedIssues = behavior.issues ?? behavior.candidates ?? behavior.result;
    if (Array.isArray(scriptedIssues)) return scriptedIssues.map(cloneIssue);
    return [...byRepoAndNumber.values()]
      .filter((issue) => (
        issue.repo === input.repo
        && typeof issue.body === 'string'
        && issue.body.includes(input.marker)
      ))
      .map(cloneIssue);
  }

  return {
    createIssue,
    getIssue,
    searchIssuesByMarker,
    getPostCount: () => postCount,
    getGetCount: () => getCount,
    getSearchCount: () => searchCount,
  };
}

module.exports = {
  FakeGithubGatewayError,
  createFakeGithubGateway,
};
