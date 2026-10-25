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

export function canSubmitOwnedPrompt(state, operational, allowQueue = false) {
  const incarnation = getOwnedIncarnation(state);
  if (!operational || !canControlOwnedSession('running', state)) return false;
  if (!incarnation || incarnation.attribution_uncertain || incarnation.interrupt_unknown) return false;
  if (incarnation.state !== 'alive') return false;
  const interruptPending = (state.deliveries || []).some(delivery => (
    delivery.incarnation_id === incarnation.id && delivery.kind === 'interrupt'
    && ['queued', 'sending', 'written', 'provider_observed', 'unknown'].includes(delivery.state)
  ));
  if (!allowQueue && interruptPending) return false;
  return ownedInteraction(state) === 'idle' || allowQueue;
}

export function canResendOwnedPrompt(state, delivery) {
  const incarnation = getOwnedIncarnation(state);
  return canSubmitOwnedPrompt(state, canControlOwnedSession('running', state))
    && delivery.incarnation_id !== incarnation?.id && state.incarnations.some(previous => (
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


// Current facts must not inherit cached values when the host cannot answer.
export function getOwnedHeaderState(host, state) {
  const incarnation = getOwnedIncarnation(state);
  let execution = 'unknown';
  if (['alive', 'orphaned'].includes(incarnation?.state)) execution = 'executionAlive';
  if (['exited', 'never_started'].includes(incarnation?.state)) execution = 'executionExited';
  const snapshotValues = {
    execution,
    control: canControlOwnedSession('running', state) ? 'controlPossible' : 'controlUnavailable',
    interaction: ownedInteraction(state),
    session: state?.session?.state || 'unknown'
  };
  if (host === 'running') return { current: snapshotValues, lastKnown: null };
  return {
    current: { execution: 'unknown', control: 'unknown', interaction: 'unknown', session: 'unknown' },
    lastKnown: state?.session ? snapshotValues : null
  };
}

export function getOwnedToolInputPreview(input) {
  const text = input || '';
  const lines = text.split('\n');
  const long = lines.length > 12 || text.length > 600;
  return { long, preview: lines.slice(0, 12).join('\n').slice(0, 600) };
}
