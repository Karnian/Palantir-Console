import { h, Fragment } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
import { useSnapshotRefresh } from '../lib/hooks/useSnapshotRefresh.js';
import { SnapshotTime } from './SessionSnapshotParts.js';
const html = htm.bind(h);

export function SnapshotRefreshControls({ load, now, loading, reload, compact = true }) {
  const refresh = useSnapshotRefresh({ onComplete: reload });
  const times = load.entries.filter(entry => entry.machine_id).map(entry =>
    load.snapshots.find(item => item.machine.id === entry.machine_id)?.generated_at || entry.generated_at);
  const oldest = times.filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const label = refresh.busy ? '수집 중…' : '새로 만들기';
  const icon = refresh.busy ? '⋯' : '⟳';
  return html`<${Fragment}>
      <div class="session-hub-snapshot-line">
        <span>스냅샷 <${SnapshotTime} value=${oldest} now=${now} relativeOnly=${true} /></span>
        <button class=${compact ? 'ghost session-hub-icon' : 'ghost'} type="button" aria-label="새로 만들기"
          title="스냅샷 새로 만들기" disabled=${refresh.busy || refresh.status?.enabled === false}
          onClick=${() => refresh.refresh()}>${compact ? icon : label}</button>
        <details class="session-hub-snapshot-details">
          <summary aria-label="스냅샷 상세">상세</summary>
          <div class="session-hub-snapshot-info">
            ${load.entries.filter(entry => entry.machine_id).map(entry => html`<p key=${entry.machine_id}>
              <${SnapshotTime} value=${load.snapshots.find(item => item.machine.id === entry.machine_id)?.generated_at
                || entry.generated_at} now=${now} label=${entry.machine_label} snapshot=${true} /></p>`)}
            ${refresh.status?.targets.map(target => html`<p role="status" key=${target.name}>
              ${target.name} · ${target.running ? '수집 중' : target.last_result?.code === 'ok' ? '수집 완료'
                : target.last_result ? '수집 실패' : '수집 전'}</p>`)}
            <button class="ghost" type="button" disabled=${loading} onClick=${reload}>스냅샷 새로고침</button>
          </div>
        </details>
      </div>
      ${refresh.error && html`<p role="alert">수집 상태를 읽지 못했습니다.</p>`}
    </${Fragment}>`;
}
