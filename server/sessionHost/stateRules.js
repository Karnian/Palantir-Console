'use strict';


function getEndedPromptOutcome(turnResult) {
  if (turnResult) {
    if (turnResult.subtype === 'error_during_execution') {
      return 'interrupted';
    }
    if (turnResult.is_error) {
      return 'errored';
    }
    return 'completed';
  }
  return 'outcome_unknown';
}

function createToolDecision(delivery, body) {
  if (delivery.kind === 'question_answer') {
    return {
      behavior: 'answer',
      answer: body.answer ?? body
    };
  }
  if (body.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: `Denied by Palantir user. request=${delivery.id}`
    };
  }
  return {
    behavior: 'allow'
  };
}

function getCompletedPromptOutcome(turnResult) {
  if (turnResult) {
    if (turnResult.is_error) {
      return 'errored';
    }
    return 'completed';
  }
  return 'outcome_unknown';
}

function isToolDecisionObserved(delivery, decision, adapterEvent) {
  if (decision.behavior === 'deny') {
    return adapterEvent.is_error === true && adapterEvent.content === decision.message;
  }
  if (decision.behavior === 'answer') {
    return !adapterEvent.is_error && !delivery.tainted && JSON.stringify(adapterEvent.content) === JSON.stringify(decision.answer);
  }
  return !adapterEvent.is_error && !delivery.tainted;
}

function getToolResultReason(observed, adapterEvent) {
  if (observed) {
    return null;
  }
  if (adapterEvent.is_error) {
    return 'tool_finished_error';
  }
  return 'tool_finished';
}

function getRecoveredIncarnationState(verdict) {
  if (verdict === 'never_started') {
    return 'never_started';
  }
  if (verdict === 'match') {
    return 'orphaned';
  }
  if (verdict === 'mismatch_confirmed') {
    return 'exited';
  }
  return 'liveness_unknown';
}

function getRecoveredStartResult(incarnation) {
  if (incarnation?.state === 'never_started') {
    return {
      state: 'failed',
      reason: 'not_started'
    };
  }
  if (incarnation?.state === 'exited') {
    return {
      state: 'failed',
      reason: 'exited_before_confirm'
    };
  }
  return {
    state: 'blocked',
    reason: 'control_lost'
  };
}
module.exports = {
  getEndedPromptOutcome,
  createToolDecision,
  getCompletedPromptOutcome,
  isToolDecisionObserved,
  getToolResultReason,
  getRecoveredIncarnationState,
  getRecoveredStartResult
};
