import { h } from '../../../vendor/preact.module.js';
import { useState, useRef } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedLabel, parseOwnedJson, formatOwnedTime } from './format.js';
import { getOwnedHeaderState } from './state.js';
import { Modal } from '../Modal.js';
const html = htm.bind(h);
const handoffCopy = {
  title: '터미널로 넘기기',
  shell: '어느 셸에 붙여 넣어도 /bin/sh 로 실행됨',
  handoff_identity_unavailable: OWNED_COPY.handoff_identity_unavailable,
  unsupported_path_character: OWNED_COPY.unsupported_path_character,
  guarantee: '넘긴 뒤 Palantir 는 그 실행을 제어·관측하지 않고 인증 게이트도 없다. 명령을 바꿔 실행하면 재현이 깨진다. ' +
    '넘긴 세션은 읽기 전용이고 다시 열지 않는다. Palantir 에서 다시 작업하려면 새 세션.',
  limit: '표지를 버리고 분리된 백그라운드 프로세스는 확인 범위 밖',
  handoff_environment_mismatch: '실행 당시 HOME·실행 파일 기록과 현재 호스트가 달라 넘기지 않았습니다.',
  executable_hash_mismatch: '실행 파일 해시 불일치 — 넘기지 않았습니다.',
  subprocess_remaining: '하위 프로세스가 남았거나 조회할 수 없어 넘기기가 막혔습니다.',
  invalid_handoff_path: '넘기기 경로가 올바르지 않습니다.',
  invalid_claude_session_id: '대화 세션 ID가 올바르지 않습니다.',
  requested: '넘기기 요청 접수', close_sent: '인터럽트·종료 요청 보냄',
  signal_sent: '종료 신호 보냄', exit_confirmed: '대화 실행 종료 확인',
  subprocess_checked: '하위 프로세스 확인', done: '넘기기 완료'
};

function OwnedHeaderField({ label, value, lastValue, asOf }) {
  return html`
    <span class="owned-header-field">
      ${label}: ${ownedLabel(value)}
      ${lastValue && html`<span class="owned-last-known">
        (${formatOwnedTime(asOf)} ${OWNED_COPY.lastKnown}: ${ownedLabel(lastValue)})
      </span>`}
    </span>
  `;
}

export function OwnedSessionHeader({ state, incarnation, host, asOf, onHandoff, handoffDisabled = true }) {
  const [confirmHandoff, setConfirmHandoff] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const commandRef = useRef(null);
  const handedOff = state.session.state === 'handed_off';
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(state.handoff_command);
      setCopyStatus('명령을 복사했습니다.');
    } catch {
      commandRef.current?.focus();
      commandRef.current?.select();
      setCopyStatus('복사하지 못했습니다. 선택된 명령을 직접 복사하세요.');
    }
  };
  const account = parseOwnedJson(incarnation?.account_snapshot);
  const { current, lastKnown } = getOwnedHeaderState(host, state);
  const fields = [
    ['execution', OWNED_COPY.headerExecution],
    ['control', OWNED_COPY.headerControl],
    ['interaction', OWNED_COPY.headerInteraction],
    ['session', OWNED_COPY.headerSession]
  ];
  const capabilityNames = ['observe', 'prompt', 'tool_approval', 'cancel', 'resume'];
  return html`
    <div class="owned-card">
      <p class="owned-header-status">
        <span>${OWNED_COPY.headerHost}: ${host === 'running' ? OWNED_COPY.hostConnected : OWNED_COPY.hostLost}</span>
        ${fields.map(([name, label]) => html`<${OwnedHeaderField} key=${name} label=${label}
          value=${current[name]} lastValue=${lastKnown?.[name]} asOf=${asOf} />`)}
      </p>
      <p>${OWNED_COPY.cwd}: ${state.session.cwd}</p>
      ${handedOff && html`<p role="status">터미널로 넘김 · 읽기 전용</p><p>${handoffCopy.guarantee}</p>`}
      ${onHandoff && !handedOff && html`<button class="btn btn-sm" disabled=${handoffDisabled}
        onClick=${() => setConfirmHandoff(true)}>${handoffCopy.title}</button>`}
      ${confirmHandoff && html`<${Modal} open=${true} labelledBy="owned-handoff-title"
        onClose=${() => setConfirmHandoff(false)}>
        <div class="modal-header"><h2 id="owned-handoff-title">${handoffCopy.title}</h2></div>
        <div class="modal-body">
          <p>${handoffCopy.guarantee}</p><p>${handoffCopy.limit}</p><p>${handoffCopy.shell}</p><p>${OWNED_COPY.handoffFolderTrust}</p>
        </div>
        <div class="modal-footer">
          <button class="btn" onClick=${() => setConfirmHandoff(false)}>취소</button>
          <button class="btn" disabled=${handoffDisabled} onClick=${() => {
            if (handoffDisabled) return;
            setConfirmHandoff(false); onHandoff();
          }}>확인하고 넘기기</button>
        </div>
      </${Modal}>`}
      ${handedOff && state.handoff_command && html`<p>${handoffCopy.shell}</p><p>${OWNED_COPY.handoffFolderTrust}</p><label>터미널에서 실행할 명령
        <textarea ref=${commandRef} class="owned-handoff-command" readonly=${true} rows="6"
          style="width:100%;box-sizing:border-box" value=${state.handoff_command} />
        </label><button class="btn btn-sm" onClick=${copyCommand}>명령 복사</button>
        <p role="status">${copyStatus}</p>`}
      ${state.handoff_subprocesses && html`<div>
        <p>${handoffCopy.subprocess_remaining}</p><p>${handoffCopy.limit}</p>
        <p>${state.handoff_subprocesses.status === 'query_failed' ? '프로세스 조회 실패' : '남은 프로세스'}</p>
        <ul>${(state.handoff_subprocesses.pids || []).map(process => html`<li>PID ${process.pid} · ${process.startedAt}</li>`)}</ul>
        <button class="btn btn-sm" disabled=${handoffDisabled} onClick=${onHandoff}>다시 확인</button>
      </div>`}
      <p>
        ${OWNED_COPY.cli}: ${incarnation?.cli_version || OWNED_COPY.verdict} ·
        ${OWNED_COPY.auth}: ${account?.subscriptionType || OWNED_COPY.verdict}
      </p>
      ${incarnation?.rate_limit_info?.isUsingOverage && html`<p class="owned-unknown">${OWNED_COPY.overage}</p>`}
      <p>
        ${capabilityNames.map(name => {
          const verdict = incarnation?.capabilityVerdict?.[name];
          const verdictText = !verdict || verdict === 'unknown' ? OWNED_COPY.verdict : ownedLabel(verdict);
          return html`<span class="owned-badge">${OWNED_COPY[name]}: ${verdictText}</span>`;
        })}
      </p>
      ${(state.controls || []).map(control => html`
        <p>
          ${control.kind === 'handoff' ? handoffCopy.title : ownedLabel(control.kind)} ·
          ${control.kind === 'handoff' ? handoffCopy[control.stage] || ownedLabel(control.stage) : ownedLabel(control.stage)} ·
          ${ownedLabel(control.state)}
          ${control.reason ? handoffCopy[control.reason] || ownedLabel(control.reason) : ''}
        </p>
      `)}
    </div>
  `;
}
