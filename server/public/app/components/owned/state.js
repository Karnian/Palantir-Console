// Pure selectors shared by the screen, controller hook, and component tests.
export function getOwnedIncarnation(state) {
  return state?.incarnations?.find(incarnation => incarnation.id === state.current_incarnation_id);
}

export function ownedInteraction(state) {
  const incarnation = getOwnedIncarnation(state);
  if (!incarnation || incarnation.state !== 'alive' || incarnation.attribution_uncertain || incarnation.interrupt_unknown) {
    return 'unknown';
  }
  const pendingCards = (state.tool_requests || []).filter(card => (
    card.incarnation_id === incarnation.id && card.state === 'pending'
  ));
  if (pendingCards.length) {
    const hasQuestion = pendingCards.some(card => card.tool_name === 'AskUserQuestion');
    return hasQuestion ? 'awaiting_user' : 'awaiting_permission';
  }
  const hasRunningPrompt = (state.deliveries || []).some(delivery => (
    delivery.incarnation_id === incarnation.id
    && delivery.kind === 'prompt'
    && ['sending', 'written', 'provider_observed'].includes(delivery.state)
    && !delivery.outcome
  ));
  return hasRunningPrompt ? 'running' : 'idle';
}

export function canControlOwnedSession(host, state) {
  const incarnation = getOwnedIncarnation(state);
  return host === 'running'
    && incarnation?.state === 'alive'
    && incarnation.control_available === true
    && state?.session?.state === 'active'
    && !(state.controls || []).some(control => control.state === 'accepted');
}

export function canResumeOwnedSession(state) {
  const incarnation = getOwnedIncarnation(state);
  if (!incarnation || !['exited', 'never_started'].includes(incarnation.state)) return false;
  if (state?.session?.state !== 'active') return false;
  return !!state.controls?.some(control => (
    control.incarnation_id === incarnation.id && control.kind === 'stop' && control.state === 'done'
  ));
}

export function canRestartOwnedSession(state) {
  const incarnation = getOwnedIncarnation(state);
  return state?.session?.state === 'active'
    && !!incarnation
    && ['alive', 'orphaned', 'exited', 'never_started'].includes(incarnation.state);
}

export function canResendOwnedPrompt(state, delivery) {
  const incarnation = getOwnedIncarnation(state);
  return delivery.incarnation_id !== incarnation?.id && state.incarnations.some(previous => (
    previous.id === delivery.incarnation_id && ['exited', 'never_started'].includes(previous.state)
  ));
}

export function buildOwnedConversation(state, events) {
  const prompts = (state?.deliveries || [])
    .filter(delivery => delivery.kind === 'prompt')
    .map(delivery => ({ kind: 'prompt', row: delivery }));
  const messages = events.map(event => ({ kind: 'event', row: event }));
  return [...prompts, ...messages].sort((left, right) => (
    (left.row.created_at || 0) - (right.row.created_at || 0) || (left.row.seq || 0) - (right.row.seq || 0)
  ));
}

export function mergeOwnedEvents(previous, incoming) {
  const bySequence = new Map([...previous, ...incoming].map(event => [event.seq, event]));
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}
