// SpecialistView — page chrome for operator specialist one-shot invocation.
//
// The invoke contract lives in SpecialistInvokePanel so page and roster entry
// points share one origin-run state machine and request path.

import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { SpecialistInvokePanel } from './SpecialistInvokePanel.js';

export function SpecialistView({ runs = [], initialProfileId = '' }) {
  return html`
    <div class="page specialist-page" data-view="specialist">
      <div class="page-header">
        <div>
          <h1>스페셜리스트</h1>
          <p class="specialist-description">저장된 프로필로 폴더 없는 전문 에이전트를 한 번 호출합니다 (읽기 전용 · 도구 없음)</p>
        </div>
      </div>

      <${SpecialistInvokePanel} initialProfileId=${initialProfileId} runs=${runs} />
    </div>
  `;
}
