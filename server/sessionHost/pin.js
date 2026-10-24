'use strict';

module.exports = Object.freeze({
  sdkVersion: '0.3.308',
  cliVersion: '2.1.308',
  executablePackage: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  cliSha256: 'ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37',
  codesignTeamId: 'Q6L2SF6YDW',
  allowedSubscriptionTypes: Object.freeze(['Claude Max']),
  requiredCapabilities: Object.freeze(['msg_lifecycle_v1', 'interrupt_receipt_v1']),
  resolveSettingsDeadlineMs: 10000,
  initializationDeadlineMs: 60000,
  closeWaitMs: 5000,
  sigtermWaitMs: 5000,
  forbiddenAuthEnv: Object.freeze([
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_BASE_URL'
  ])
});
