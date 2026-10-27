/** Source and Delivery production tools for the production workspace (PW-03, PW-04, PW-05).
 * Canonical contract: .mex/context/decisions.md PW-03..PW-05 and artifacts/production-workspace-implementation/plan.json
 * ("media", "publication", "http", "uiContract" sections). Service interfaces are checked against
 * the actual media/publication modules and Studio's toolsForProject() dependency contract.
 *
 * Reuses the existing theme (styles.css/workflow.css panel/row/two-cols/result-facts/generation-parameters/
 * generation-safety/status-grid/integration classes) and the delegated-action + native <dialog> pattern already
 * used by app.js/workflow.js/workspace.js. Owns no global state: every value lives in closures captured by
 * createProductionTools(); the host (app.js via StudioImplementation) owns splicing html() output into the DOM
 * and calling mount()/destroy() around its own render() lifecycle, same as workflowEditor/ops-workspace.
 *
 * Race-safety: every mutating handler captures episodeId/episode.version and workflowId/runId/reviewNodeId/
 * channelId from getEpisode()/getWorkflowContext() into locals BEFORE its await, and after the await uses only
 * those captured locals plus the server's own result (which carries its own id) - never a fresh getEpisode()/
 * getWorkflowContext() re-read treated as if it were still the pre-await target. Episode-shaped results are
 * handed to onEpisodeUpdated(result) for the host to reconcile against its own dirty-draft state.
 *
 * mount()/destroy()/mode-switch never issue writes and never call Commons search or any OAuth/publish provider
 * action - only local/sanitized GET reads (oauth status, local uploads list, publications list) may auto-fire on
 * mount. Search, import, rights clearing, attach, card, channel save, authorize, disconnect, approve, publish and
 * resume are all explicit user-triggered actions.
 */

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeHttpUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? esc(url.href) : ''; } catch { return ''; }
};
const mediaKind = item => item?.kind || ((item?.type || item?.mime)?.startsWith('image/') ? 'image' : (item?.type || item?.mime)?.startsWith('video/') ? 'video' : (item?.type || item?.mime)?.startsWith('audio/') ? 'audio' : null);
const metadataHtml = metadata => `<details><summary>원본 라이선스 메타데이터 검토</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%">${esc(JSON.stringify(metadata || {}, null, 2))}</pre></details>`;
const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '확인 불가';
const bytes = value => Number.isFinite(value) ? (value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`) : '확인 불가';

const MODES = new Set(['source', 'delivery']);
const ORIGIN_NAMES = { own: '본인 소유', 'third-party': '제3자 · 라이선스 확인됨', generated: '생성된 콘텐츠' };
const OAUTH_STATUS_NAMES = { not_connected: '연결 안 됨', connected: '연결됨', channel_mismatch: '채널 불일치', insufficient_scope: '권한 부족', revoked: '인증 취소됨', reconsent_required: '재동의 필요', provider_blocked: '제공자 차단' };
const INTENT_STATUS_NAMES = { queued: '대기 중', uploading: '업로드 중', transfer_uncertain: '전송 결과 불확실', processing: '처리 중', ready_for_public: '공개 전환 가능', publishing: '공개 전환 중', completed: '공개 완료', private_restricted: '비공개 제한됨', blocked: '차단됨', unknown: '상태 확인 불가', failed: '실패' };
const INTENT_TERMINAL = new Set(['completed', 'blocked', 'failed', 'private_restricted', 'unknown']);
const publicVerified = value => value?.status === 'completed' && value.privacyStatus === 'public' && Boolean(value.videoId && value.verifiedAt);
const intentLabel = value => value?.status === 'completed' ? publicVerified(value) ? '공개 완료 · 서버 readback 검증됨' : '상태 확인 불가 · 공개 검증 증거 누락' : INTENT_STATUS_NAMES[value?.status] || value?.status || '상태 확인 불가';
const YOUTUBE_CATEGORIES = [['1', '영화·애니메이션'], ['2', '자동차·교통'], ['10', '음악'], ['15', '애완동물·동물'], ['17', '스포츠'], ['19', '여행·행사'], ['20', '게임'], ['22', '인물·블로그'], ['23', '코미디'], ['24', '엔터테인먼트'], ['25', '뉴스·정치'], ['26', '노하우·스타일'], ['27', '교육'], ['28', '과학기술']];

export function createProductionTools({
  api,
  getEpisode,
  getWorkflowContext,
  refresh = async () => {},
  onEpisodeUpdated = () => {},
  toast = () => {},
  canMutate = () => false,
} = {}) {
  let root = null;
  let bindings = null;
  let mode = 'source';
  let busy = false;

  // ---- Source panel state ----
  const search = { query: '', kind: 'image', limit: 20, loading: false, status: null, items: [], retryAfter: null, error: '' };
  let uploads = [];
  let uploadsLoaded = false;
  let uploadsError = '';
  const uploadRights = new Map(); // uploadId -> {state:'unchecked'|'checking'|'none'|'cleared', record:object|null}
  let importTarget = null; // the search item currently in the import dialog
  let importAcknowledged = false;
  let importUseAs = 'illustration';
  let rightsTarget = null; // uploadId currently in the rights dialog
  let attachTarget = null; // uploadId currently in the attach dialog
  let cardTarget = false; // whether the card-fallback dialog is open

  // ---- Delivery panel state ----
  let oauth = null;
  let oauthLoading = false;
  let oauthLoaded = false;
  let oauthError = '';
  let savingExternalId = false;
  let authorizing = false;
  let authUrl = '';
  let disconnectOpen = false;
  let disconnecting = false;
  let approval = null;
  let approving = false;
  let approvalError = '';
  let intent = null;
  let publishing = false;
  let polling = null;
  let publications = [];
  let publicationsLoaded = false;
  let publicationsError = '';
  let contextKey = '';
  let lifetime = 0;
  let uploadsLoading = false;
  let publicationsLoading = false;
  let approvalDraft = {};
  let previewBinding = null;
  let previewRevision = 0;
  let publishAttempted = false;
  let intentError = '';
  let dialogFocus = null;

  // Compare snapshots, not titles or a guessed first role. These are local equality
  // guards; the server's candidate fingerprint is the sole approval fingerprint.
  function capture() {
    const ctx = { ...(getWorkflowContext?.() || {}) };
    const episode = ctx.episodeId ? getEpisode?.(ctx.episodeId) : null;
    const owned = episode?.id === ctx.episodeId && episode?.channelId === ctx.channelId;
    return { ctx, episode: owned ? episode : null, key: JSON.stringify([ctx.episodeId, ctx.channelId]),
      snapshot: JSON.stringify([ctx.episodeId, ctx.channelId, ctx.workflowId, ctx.workflowVersion, ctx.runId, ctx.reviewNodeId, ctx.renderNodeId, owned ? episode : null, ctx.workflow || null, ctx.run || null]), lifetime };
  }

  function matches(target, exact = true) {
    const current = capture();
    return current.lifetime === target.lifetime && current.key === target.key && (!exact || current.snapshot === target.snapshot);
  }

  function invalidatePreview() {
    if (!publishAttempted) approval = null;
    previewBinding = null; previewRevision += 1;
    if (!publishAttempted) intent = null;
    stopPolling();
  }

  function syncContext() {
    const target = capture();
    if (contextKey !== target.key) {
      contextKey = target.key; lifetime += 1;
      oauth = null; oauthLoading = false; oauthLoaded = false; oauthError = ''; authUrl = '';
      uploadsLoading = false; uploadsLoaded = false; uploadsError = '';
      search.loading = false;
      for (const [id, value] of uploadRights) if (value.state === 'checking') uploadRights.delete(id);
      publications = []; publicationsLoaded = false; publicationsLoading = false; publicationsError = '';
      intent = null; publishAttempted = false; intentError = ''; approvalError = ''; approvalDraft = {};
      importTarget = null; rightsTarget = null; attachTarget = null; cardTarget = false; disconnectOpen = false;
      invalidatePreview();
    } else if (previewBinding && previewBinding.snapshot !== target.snapshot) {
      invalidatePreview();
    }
  }

  function guardMutate() {
    if (canMutate()) return true;
    toast('현재 프로젝트 상태 또는 로그인 상태를 확인하세요.', true);
    return false;
  }

  async function requireSavedEpisode(target) {
    if (!target.episode || !matches(target)) throw new Error('선택한 프로젝트가 변경되었습니다.');
    const history = await api(`/api/episodes/${encodeURIComponent(target.ctx.episodeId)}/history`);
    if (!matches(target)) throw new Error('응답을 기다리는 동안 초안 또는 프로젝트가 변경되었습니다.');
    const saved = Array.isArray(history) ? history[0]?.snapshot : null;
    const inputs = item => JSON.stringify([item?.title, item?.topic, item?.status, item?.format, item?.scenes, item?.notes]);
    if (!saved || saved.version !== target.episode.version || inputs(saved) !== inputs(target.episode)) {
      throw new Error('저장되지 않은 변경 또는 버전 충돌이 있습니다. 현재 초안을 명시적으로 저장하거나 다시 불러온 뒤 진행하세요.');
    }
  }

  async function requireSavedWorkflow(target) {
    const { workflowId, workflowVersion, workflow } = target.ctx;
    if (!workflowId || !workflowVersion || !matches(target)) throw new Error('프로젝트 워크플로우의 저장 버전을 확인할 수 없습니다.');
    const history = await api(`/api/workflows/${encodeURIComponent(workflowId)}/history`);
    if (!matches(target)) throw new Error('워크플로우를 확인하는 동안 프로젝트 또는 초안이 변경되었습니다.');
    const saved = Array.isArray(history) ? history[0]?.snapshot : null;
    if (!saved || saved.id !== workflowId || saved.version !== workflowVersion || saved.episodeId !== target.ctx.episodeId || saved.channelId !== target.ctx.channelId ||
      (workflow && JSON.stringify([saved.name, saved.nodes, saved.edges]) !== JSON.stringify([workflow.name, workflow.nodes, workflow.edges]))) {
      throw new Error('저장되지 않은 그래프 변경 또는 버전 충돌이 있습니다. 프로젝트 그래프를 명시적으로 저장한 뒤 미리보기를 준비하세요.');
    }
  }

  // ===================== Source panel rendering =====================

  function searchStatusHtml() {
    if (search.loading) return '<p class="hint">검색 중…</p>';
    if (search.status === null) return '<p class="hint">검색어를 입력해 Wikimedia Commons에서 재사용 가능한 영상·이미지를 찾아보세요.</p>';
    if (search.status === 'provider_blocked') return `<p class="hint danger">Commons 검색이 차단되었습니다.${search.error ? ` ${esc(search.error)}` : ''}</p>`;
    if (search.status === 'provider_rate_limited') return `<p class="hint danger">요청 제한에 도달했습니다${Number.isFinite(search.retryAfter) ? ` · ${search.retryAfter}초 후 다시 시도하세요` : ''}.</p>`;
    if (search.status === 'not_configured') return `<p class="hint danger">Commons 제공자 설정이 필요합니다 (MEDIA_USER_AGENT). ${esc(search.error)}</p>`;
    if (search.status !== 'ok') return `<p class="hint danger">Commons 검색 실패 · ${esc(search.status)}. ${esc(search.error)}</p>`;
    if (search.status === 'ok' && !search.items.length) return '<p class="hint">조건에 맞는 결과가 없습니다.</p>';
    return '';
  }

  function searchResultsHtml() {
    if (search.status !== 'ok' || !search.items.length) return '';
    return `<ul class="result-list">${search.items.map((item, index) => `<li>
      <div class="row between"><strong>${esc(item.title)}</strong><span class="badge ${item.supported ? 'lime' : 'coral'}">${item.supported ? '가져오기 지원' : '지원되지 않는 형식'}</span></div>
      <p>${esc(item.kind === 'video' ? '영상' : '이미지')}${item.mime ? ` · ${esc(item.mime)}` : ''}${item.width && item.height ? ` · ${Number(item.width)}×${Number(item.height)}` : ''}${Number.isFinite(item.size) ? ` · ${bytes(item.size)}` : ''}</p>
      ${item.rights ? `<p class="hint">${esc(item.rights.licenseShortName || item.rights.usageTerms || '라이선스 정보 확인 필요')}${item.rights.attributionRequired ? ' · 출처 표기 필요' : ''}${item.rights.copyrighted === true ? ' · 저작권 있음으로 표기됨' : ''}</p>` : ''}
      ${metadataHtml(item.extmetadata)}
      <div class="row">${safeHttpUrl(item.descriptionUrl) ? `<a href="${safeHttpUrl(item.descriptionUrl)}" target="_blank" rel="noopener noreferrer">Commons에서 보기 ↗</a>` : ''}<button class="small" type="button" data-pt-action="open-import" data-index="${index}" ${item.supported ? '' : 'disabled'}>가져오기</button></div>
    </li>`).join('')}</ul>`;
  }

  function importDialogHtml() {
    const item = importTarget;
    if (!item) return '';
    const rights = item.rights || {};
    return `<h2 id="pt-import-title">Commons 미디어 가져오기</h2>
      <p>${esc(item.title)}</p>
      <dl class="result-facts">
        <div><dt>형식</dt><dd>${esc(item.kind === 'video' ? '영상' : '이미지')} · ${esc(item.mime || '확인 불가')}</dd></div>
        <div><dt>라이선스</dt><dd>${esc(rights.licenseShortName || '확인 불가')}</dd></div>
        <div><dt>이용 조건</dt><dd>${esc(rights.usageTerms || '확인 불가')}</dd></div>
        <div><dt>출처 표기</dt><dd>${esc(rights.attribution || '아래 원본 메타데이터에서 직접 확인하세요')}${rights.attributionRequired ? ' (필수)' : ''}</dd></div>
        <div><dt>제한 사항</dt><dd>${esc(rights.restrictions || '확인되지 않음 · 제한 없음의 증거가 아닙니다')}</dd></div>
        <div><dt>Commons SHA-1</dt><dd><code style="overflow-wrap:anywhere">${esc(item.sha1 || '확인 불가')}</code></dd></div>
      </dl>
      ${metadataHtml(item.extmetadata)}
      <p class="hint">실제 권리와 라이선스는 Commons 문서 페이지에서 직접 확인한 뒤 가져오세요. 가져오기는 파일만 내려받으며, 권리 확정은 다음 단계(권리 정리)에서 별도로 진행합니다.</p>
      ${safeHttpUrl(item.descriptionUrl) ? `<p><a href="${safeHttpUrl(item.descriptionUrl)}" target="_blank" rel="noopener">Commons 문서 페이지에서 확인 ↗</a></p>` : ''}
      <fieldset class="generation-parameters"><legend>사용 용도</legend>
        <label class="generation-checkbox"><input type="radio" name="useAs" value="evidence" ${importUseAs === 'evidence' ? 'checked' : ''}> 사실 근거 (실제 보도 장면)</label>
        <label class="generation-checkbox"><input type="radio" name="useAs" value="illustration" ${importUseAs === 'illustration' ? 'checked' : ''}> 예시·일러스트레이션 (실제 사건 장면 아님)</label>
      </fieldset>
      <label class="generation-checkbox"><input type="checkbox" id="pt-import-ack" ${importAcknowledged ? 'checked' : ''}> 위 라이선스와 이용 조건을 확인했으며, 이 미디어를 가져올 권한이 있음을 인정합니다.</label>
      <div class="dialog-actions"><button type="button" data-pt-action="close-import">취소</button><button class="primary" type="button" data-pt-action="confirm-import" ${importAcknowledged && item.supported ? '' : 'disabled'}>가져오기</button></div>`;
  }

  function uploadsHtml() {
    if (uploadsError) return `<p class="hint danger">${esc(uploadsError)}</p><button class="small" type="button" data-pt-action="reload-uploads">다시 시도</button>`;
    if (!uploadsLoaded) return '<p class="hint">불러오는 중…</p>';
    const relevant = uploads.filter(item => ['image', 'video', 'audio'].includes(mediaKind(item))).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    if (!relevant.length) return '<p class="hint">업로드된 이미지·영상·음악이 없습니다.</p>';
    return `<ul class="result-list">${relevant.map(item => {
      const state = uploadRights.get(item.id);
      const cleared = state?.state === 'cleared' && state.record?.sha256 === item.sha256;
      const record = state?.record;
      return `<li>
        <div class="row between"><strong>${esc(item.name)}</strong><span class="badge ${cleared ? 'lime' : ''}">${cleared ? '권리 정리됨' : state?.state === 'checking' ? '확인 중…' : '권리 미확인'}</span></div>
        <p>${esc(mediaKind(item) === 'video' ? '영상' : mediaKind(item) === 'audio' ? '음악' : '이미지')}${item.width && item.height ? ` · ${Number(item.width)}×${Number(item.height)}` : ''}${Number.isFinite(item.size) ? ` · ${bytes(item.size)}` : ''} · ${esc(stamp(item.createdAt))}</p>
        ${record ? `<p class="hint">${esc(ORIGIN_NAMES[record.origin] || record.origin)}${record.attribution ? ` · ${esc(record.attribution)}` : ''}</p>` : ''}
        <div class="row"><button class="small" type="button" data-pt-action="open-rights" data-id="${esc(item.id)}">${cleared ? '권리 정보 보기' : '권리 정리'}</button>${mediaKind(item) === 'audio' ? '' : `<button class="small" type="button" data-pt-action="open-attach" data-id="${esc(item.id)}" ${cleared ? '' : 'disabled'} title="${cleared ? '' : '먼저 권리를 정리하세요'}">장면에 연결</button>`}</div>
      </li>`;
    }).join('')}</ul>`;
  }

  function rightsDialogHtml() {
    const uploadId = rightsTarget;
    const item = uploads.find(entry => entry.id === uploadId);
    if (!item) return '';
    const state = uploadRights.get(uploadId);
    if (state?.state === 'cleared' && state.record) {
      const record = state.record;
      return `<h2 id="pt-rights-title">이용 권리 · ${esc(item.name)}</h2>
        <dl class="result-facts">
          <div><dt>출처 구분</dt><dd>${esc(ORIGIN_NAMES[record.origin] || record.origin)}</dd></div>
          ${record.sourceUrl ? `<div><dt>출처 URL</dt><dd>${safeHttpUrl(record.sourceUrl) ? `<a href="${safeHttpUrl(record.sourceUrl)}" target="_blank" rel="noopener">${esc(record.sourceUrl)}</a>` : esc(record.sourceUrl)}</dd></div>` : ''}
          ${record.licenseId ? `<div><dt>라이선스</dt><dd>${esc(record.licenseId)}</dd></div>` : ''}
          ${record.attribution ? `<div><dt>출처 표기</dt><dd>${esc(record.attribution)}</dd></div>` : ''}
          <div><dt>확정 시각</dt><dd>${esc(stamp(record.acknowledgedAt))}</dd></div>
          <div><dt>SHA-256</dt><dd><code>${esc(record.sha256 || '확인 불가')}</code></dd></div>
        </dl>
        <p class="hint">이용 권리는 한 번 정리하면 변경할 수 없습니다. 다른 조건이 필요하면 새로 업로드하세요.</p>
        <div class="dialog-actions"><button type="button" data-pt-action="close-rights">닫기</button></div>`;
    }
    const provenance = item.provenance || {};
    const prefillSourceUrl = provenance.sourceUrl || provenance.descriptionUrl || '';
    const extmeta = provenance.extmetadata || {};
    const metaValue = field => typeof extmeta[field] === 'object' && extmeta[field] !== null ? extmeta[field].value : extmeta[field];
    const prefillLicense = provenance.rights?.licenseShortName || metaValue('LicenseShortName') || '';
    const prefillAttribution = provenance.rights?.attribution || metaValue('Attribution') || metaValue('Artist') || metaValue('Credit') || '';
    return `<h2 id="pt-rights-title">이용 권리 정리 · ${esc(item.name)}</h2>
      <p class="hint">실제로 사용하려면 출처와 권리를 명확히 밝혀야 합니다. 한 번 확정하면 다시 바꿀 수 없으니 정확히 입력하세요.</p>
      ${state?.state === 'checking' ? '<p class="hint">기존 권리 기록을 확인하는 중…</p>' : ''}
      <form id="pt-rights-form">
        <fieldset class="generation-parameters"><legend>출처 구분</legend>
          <label class="generation-checkbox"><input type="radio" name="origin" value="own" required> 본인이 직접 촬영·제작</label>
          <label class="generation-checkbox"><input type="radio" name="origin" value="third-party"> 제3자 자료 (라이선스로 이용 허가됨)</label>
          <label class="generation-checkbox"><input type="radio" name="origin" value="generated"> AI 등으로 생성된 콘텐츠</label>
        </fieldset>
        <label>출처 URL (제3자 자료 필수)<input type="url" name="sourceUrl" maxlength="2000" value="${esc(prefillSourceUrl)}" placeholder="https://..."></label>
        <label>라이선스 (제3자 자료 필수)<input type="text" name="licenseId" maxlength="200" value="${esc(prefillLicense)}" placeholder="예: CC BY-SA 4.0"></label>
        <label>출처 표기 (제3자 자료 필수)<input type="text" name="attribution" maxlength="500" value="${esc(prefillAttribution)}" placeholder="저작자 또는 출처 표기 문구"></label>
        ${metadataHtml(extmeta)}
        <p>로컬 SHA-256: <code style="overflow-wrap:anywhere">${esc(item.sha256 || '확인 불가')}</code></p>
        <label>생성 작업 ID (생성 콘텐츠인 경우)<input name="generationJobId" maxlength="100"></label>
        <p class="hint">아래 권리 확정은 직접 검토한 원본 권리·이용 조건·출처 표기에 대한 명시적 확인입니다.</p>
        <div class="dialog-actions"><button type="button" data-pt-action="close-rights">취소</button><button class="primary" type="submit">권리 확정</button></div>
      </form>`;
  }

  function attachDialogHtml() {
    const uploadId = attachTarget;
    const item = uploads.find(entry => entry.id === uploadId);
    const ctx = getWorkflowContext?.() || {};
    const episode = getEpisode?.(ctx.episodeId);
    if (!item || !episode) return '';
    const scenes = Array.isArray(episode.scenes) ? episode.scenes : [];
    return `<h2 id="pt-attach-title">장면에 연결 · ${esc(item.name)}</h2>
      <form id="pt-attach-form">
        <label>대상 장면<select name="sceneId" required><option value="">선택하세요</option>${scenes.map(scene => `<option value="${esc(scene.id)}">${esc(scene.title || '이름 없는 장면')}</option>`).join('')}</select></label>
        <label>대상 레이아웃 슬롯 (선택)<select name="slotId"><option value="">전체 장면</option></select></label>
        <p>로컬 SHA-256: <code style="overflow-wrap:anywhere">${esc(item.sha256 || '확인 불가')}</code></p>
        ${mediaKind(item) === 'video' ? `<div class="two-cols"><label>시작 지점 (초)<input type="number" name="trimStart" min="0" max="${Number(item.duration) || 36000}" step="0.1" value="0"></label><label>종료 지점 (초, 선택)<input type="number" name="trimEnd" min="0" max="${Number(item.duration) || 36000}" step="0.1"></label></div>` : ''}
        <fieldset class="generation-parameters"><legend>사용 용도</legend>
          <label class="generation-checkbox"><input type="radio" name="useAs" value="evidence" ${importUseAs === 'evidence' ? 'checked' : ''}> 사실 근거</label>
          <label class="generation-checkbox"><input type="radio" name="useAs" value="illustration" ${importUseAs === 'illustration' ? 'checked' : ''}> 예시·일러스트레이션</label>
        </fieldset>
        <p class="hint">현재 버전(v${episode.version})을 기준으로 저장합니다. 다른 곳에서 먼저 저장했다면 다시 불러온 뒤 연결하세요.</p>
        <div class="dialog-actions"><button type="button" data-pt-action="close-attach">취소</button><button class="primary" type="submit">연결</button></div>
      </form>`;
  }

  function cardDialogHtml() {
    if (!cardTarget) return '';
    const ctx = getWorkflowContext?.() || {};
    const episode = getEpisode?.(ctx.episodeId);
    if (!episode) return '<h2 id="pt-card-title">텍스트 카드로 대체</h2><p class="hint">대상 에피소드를 확인할 수 없습니다.</p><div class="dialog-actions"><button type="button" data-pt-action="close-card">닫기</button></div>';
    const scenes = Array.isArray(episode.scenes) ? episode.scenes : [];
    return `<h2 id="pt-card-title">텍스트 카드로 대체</h2>
      <p class="hint">정리된 원본 영상·이미지가 없을 때, 장면의 이야기와 내레이션은 유지한 채 이미지 없는 텍스트 카드로 전환합니다. 업로드나 라이선스 정보가 필요하지 않습니다.</p>
      <form id="pt-card-form">
        <label>대상 장면<select name="sceneId" required ${scenes.length ? '' : 'disabled'}><option value="">선택하세요</option>${scenes.map(scene => `<option value="${esc(scene.id)}">${esc(scene.title || '이름 없는 장면')}</option>`).join('')}</select></label>
        ${!scenes.length ? '<p class="hint">전환할 수 있는 장면이 없습니다 (이미 모두 텍스트 카드입니다).</p>' : ''}
        <div class="dialog-actions"><button type="button" data-pt-action="close-card">취소</button><button class="primary" type="submit" ${scenes.length ? '' : 'disabled'}>텍스트 카드로 전환</button></div>
      </form>`;
  }

  function sourceHtml() {
    return `<div data-production-tools data-mode="source">
      <section class="panel section-spacer" aria-label="소스 도구">
        <div class="panel-header"><h2>소스 · 이용 권리</h2></div>
        <div class="panel-body">
          <div class="source-note">재사용 가능한 실제 영상·이미지를 Wikimedia Commons에서 찾아 가져오거나, 직접 업로드한 파일의 이용 권리를 정리한 뒤 장면에 연결하세요. 업로드한 음악은 이용 권리를 정리한 뒤 음악 편집기에서 선택할 수 있습니다. 적절한 원본이 없다면 이야기를 유지한 텍스트 카드로 대체할 수 있습니다.</div>
          <form id="pt-search-form" class="two-cols" role="search">
            <label>Wikimedia Commons 검색<input type="search" name="query" maxlength="200" value="${esc(search.query)}" placeholder="예: 서울 야경"></label>
            <label>종류<select name="kind"><option value="image" ${search.kind === 'image' ? 'selected' : ''}>이미지</option><option value="video" ${search.kind === 'video' ? 'selected' : ''}>영상</option></select></label>
            <div class="row" style="align-items:end;grid-column:1/-1"><button class="small" type="submit" ${search.loading ? 'disabled' : ''}>${search.loading ? '검색 중…' : '검색'}</button></div>
          </form>
          <div id="pt-search-results" class="section-spacer">${searchStatusHtml()}${searchResultsHtml()}</div>
          <div class="section-spacer">
            <div class="panel-header" style="border:0;padding:0 0 10px"><h3>내 업로드 · 권리 정리</h3><div class="row"><button class="small" type="button" data-pt-action="reload-uploads">↻ 새로고침</button><button class="small" type="button" data-pt-action="upload">↑ 새 파일 업로드</button></div></div>
            <div id="pt-uploads">${uploadsHtml()}</div>
          </div>
          <div class="section-spacer">
            <h3>원본 미확보 시 텍스트 카드로 대체</h3>
            <p class="hint">정리된 원본이 없을 때, 이야기와 내레이션을 유지한 채 이미지 없는 텍스트 카드로 전환합니다. 업로드나 라이선스가 필요 없습니다.</p>
            <button class="small" type="button" data-pt-action="open-card">텍스트 카드로 전환</button>
          </div>
        </div>
      </section>
      <input hidden type="file" id="pt-upload-file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg,audio/ogg,.wav,.mp3,.ogg">
      <dialog data-pt-dialog="import" id="pt-import-dialog" aria-labelledby="pt-import-title">${importDialogHtml()}</dialog>
      <dialog data-pt-dialog="rights" id="pt-rights-dialog" aria-labelledby="pt-rights-title">${rightsDialogHtml()}</dialog>
      <dialog data-pt-dialog="attach" id="pt-attach-dialog" aria-labelledby="pt-attach-title">${attachDialogHtml()}</dialog>
      <dialog data-pt-dialog="card" id="pt-card-dialog" aria-labelledby="pt-card-title">${cardDialogHtml()}</dialog>
    </div>`;
  }

  // ===================== Delivery panel rendering =====================

  function contextSummaryHtml(ctx, episode) {
    return `<dl class="result-facts">
        <div><dt>에피소드</dt><dd>${esc(episode?.title || ctx.episodeId || '선택되지 않음')}${episode ? ` · v${episode.version}` : ''}</dd></div>
        <div><dt>워크플로우</dt><dd>${esc(ctx.workflowId || '확인 불가')}${ctx.workflowVersion ? ` · v${ctx.workflowVersion}` : ''}</dd></div>
        <div><dt>실행</dt><dd>${esc(ctx.runId || '선택된 실행 없음')}</dd></div>
        <div><dt>검토 노드</dt><dd>${esc(ctx.reviewNodeId || '선택된 검토 없음')}</dd></div>
      </dl>${!ctx.runId || !ctx.reviewNodeId ? '<p class="hint">워크플로우 빌더에서 실행과 검토 노드를 먼저 선택하고 검토 승인을 완료해야 공개 게시를 준비할 수 있습니다.</p>' : ''}`;
  }

  function oauthHtml(ctx) {
    if (!ctx.channelId) return '<p class="hint">채널을 먼저 선택하세요.</p>';
    if (oauthError) return `<p class="hint danger">${esc(oauthError)}</p><button class="small" type="button" data-pt-action="reload-oauth">다시 시도</button>`;
    if (oauthLoading && !oauth) return '<p class="hint">연결 상태를 확인하는 중…</p>';
    if (!oauth) return '<p class="hint">연결 상태를 아직 확인하지 않았습니다.</p><button class="small" type="button" data-pt-action="reload-oauth">상태 확인</button>';
    const verified = oauth.status === 'connected' && oauth.hasForceSslScope && !oauth.reconsentRequired;
    return `<div class="status-grid"><article class="integration">
        <h3>연결 상태</h3>
        <span class="badge ${verified ? 'lime' : oauth.status === 'not_connected' ? '' : 'coral'}">${esc(oauth.status === 'not_configured' ? 'OAuth 서버 설정 필요' : OAUTH_STATUS_NAMES[oauth.status] || oauth.status || '확인 불가')}</span>
        <p>채널 ID: ${esc(oauth.channelExternalId || '미설정')}${oauth.channelTitle ? ` · ${esc(oauth.channelTitle)}` : ''}</p>
        <p>업로드/수정 범위(force-ssl): ${oauth.hasForceSslScope ? '있음' : '없음 또는 확인 불가'}</p>
        <p>만료: ${oauth.expiresAt ? esc(stamp(oauth.expiresAt)) : '확인 불가'}${oauth.testingMode ? ' · 테스트 모드(최대 7일)' : ''}</p>
        <p>갱신 토큰: ${oauth.hasRefreshToken ? '있음' : '없음'}${oauth.reconsentRequired ? ' · 재동의 필요' : ''}</p>
        <p>마지막 확인: ${esc(stamp(oauth.lastCheckedAt))}</p>
      </article></div>
      <p class="hint">이 상태는 마지막으로 확인된 서버 응답입니다. 실제 업로드·공개 전환 성공을 의미하지 않습니다. 비밀 값은 서버에만 보관되며 여기에는 표시되지 않습니다.</p>
      <form id="pt-channel-form" class="two-cols">
        <label>YouTube 채널 ID (UC로 시작, 24자)<input type="text" name="externalId" pattern="UC[A-Za-z0-9_-]{22}" maxlength="64" value="${esc(oauth.channelExternalId || '')}" placeholder="UC..." ${canMutate() ? '' : 'disabled'}></label>
        <div class="row" style="align-items:end"><button class="small" type="submit" ${canMutate() ? '' : 'disabled'}>${savingExternalId ? '저장 중…' : '채널 ID 저장'}</button></div>
      </form>
      <div class="row section-spacer">
        <button type="button" data-pt-action="authorize" ${canMutate() && oauth.channelExternalId && oauth.configured !== false ? '' : 'disabled'} title="${oauth.channelExternalId ? '' : '먼저 채널 ID를 저장하세요'}">${authorizing ? '연결 URL 준비 중…' : 'YouTube 계정 연결/재연결'}</button>
        ${oauth.connected ? `<button class="quiet small danger" type="button" data-pt-action="open-disconnect" ${canMutate() ? '' : 'disabled'}>연결 해제</button>` : ''}
      </div>
      ${authUrl ? `<p class="section-spacer">${safeHttpUrl(authUrl) ? `<a href="${safeHttpUrl(authUrl)}" target="_blank" rel="noopener">Google 인증 페이지 열기 ↗</a>` : '인증 URL을 확인할 수 없습니다.'} · 이 링크를 눌러 브라우저에서 직접 인증을 완료하세요. 이 화면은 자동으로 이동하지 않습니다.</p>` : ''}`;
  }

  function approvedSummaryHtml() {
    if (!approval) return '';
    const manifest = approval.manifest;
    const fingerprint = approval.fingerprint;
    const complete = Boolean(manifest && typeof manifest === 'object' && typeof fingerprint === 'string' && fingerprint);
    return `<section aria-label="서버 게시 미리보기" class="section-spacer"><h3>서버 게시 manifest · 최종 확인</h3><dl class="result-facts">
        <div><dt>승인 ID</dt><dd><code>${esc(approval.id)}</code></dd></div>
        <div><dt>Fingerprint</dt><dd><code style="overflow-wrap:anywhere">${esc(fingerprint || '서버 fingerprint 누락 · 공개 불가')}</code></dd></div>
      </dl>
      <p class="hint">설명에 포함될 크레딧, 렌더·소스 해시, 장면/슬롯 권리, 채널, 아동용·AI 공개 결정을 포함한 서버 원문입니다.</p>
      <p>필수 크레딧 (서버 원문)</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%">${esc(manifest?.credits ?? '서버 manifest에서 확인하세요')}</pre>
      <pre tabindex="0" aria-label="전체 서버 manifest 및 크레딧" style="white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%">${esc(JSON.stringify(manifest ?? null, null, 2))}</pre>
      ${intent || publishAttempted ? `<div class="wf-review-decision" role="status">
          <h3>게시 상태: ${esc(intentLabel(intent))}</h3>
          <p>서버 단계: ${esc(intent?.phase || '확인 불가')} · 공개 범위: ${esc(intent?.privacyStatus || 'unknown')}</p>
          ${intent?.videoId ? `<p>원격 영상 ID: <code>${esc(intent.videoId)}</code></p>` : ''}
          ${intent?.message ? `<p>${esc(intent.message)}</p>` : ''}
          <p class="hint">마지막 확인: ${esc(stamp(intent?.updatedAt))}</p>
        </div>
        <div class="row"><button class="small" type="button" data-pt-action="refresh-intent">기존 작업 상태 확인</button>${intent?.id && intent.status !== 'completed' ? `<button class="small primary" type="button" data-pt-action="resume-intent" ${canMutate() ? '' : 'disabled'}>${publishing ? '처리 중…' : '기존 작업 확인·재개'}</button>` : ''}</div>
        <p class="hint">새로고침을 멈추거나 창을 닫아도 서버에 저장된 게시 작업은 계속 진행됩니다. 이 화면은 상태만 보여줍니다.</p>`
      : `<div class="generation-safety">아래 최종 승인은 이 승인 ID만 사용해 비공개 업로드, 검증, 동일 영상 공개 전환을 시작합니다.</div>
        <button class="primary" type="button" data-pt-action="publish-approval" ${complete && canMutate() && !busy ? '' : 'disabled'}>${publishing ? '시작하는 중…' : '최종 승인하고 공개'}</button>`}
      ${intentError ? `<p class="hint danger" role="status">${esc(intentError)}</p>` : ''}</section>`;
  }

  function approvalHtml(ctx, episode) {
    const ready = Boolean(ctx.workflowId && ctx.runId && ctx.reviewNodeId && episode);
    return `<p class="hint">게시 준비는 서버 승인과 미리보기만 만듭니다. 전체 manifest와 크레딧을 확인한 뒤 '최종 승인하고 공개'를 눌러야 전송을 시작합니다. 입력을 바꾸면 미리보기가 무효화됩니다.</p>
      ${approvalError ? `<p class="hint danger" role="alert">${esc(approvalError)}</p>` : ''}
      ${!ready ? '<p class="hint">실행·검토가 선택되지 않아 승인할 수 없습니다.</p>' : ''}
      <form id="pt-approval-form">
        <fieldset ${publishAttempted ? 'disabled' : ''} style="border:0;padding:0;min-width:0">
        <label>제목<input type="text" name="title" maxlength="100" required value="${esc(episode?.title || '')}" ${ready ? '' : 'disabled'}></label>
        <label>설명 (필수)<textarea name="description" maxlength="5000" rows="4" required ${ready ? '' : 'disabled'}></textarea></label>
        <div class="two-cols">
          <label>카테고리<select name="categoryId" required ${ready ? '' : 'disabled'}><option value="">선택하세요</option>${YOUTUBE_CATEGORIES.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}</select></label>
          <label>태그 (쉼표로 구분)<input type="text" name="tags" maxlength="500" ${ready ? '' : 'disabled'}></label>
        </div>
        <fieldset class="generation-parameters"><legend>아동용 영상 여부 (필수)</legend>
          <label class="generation-checkbox"><input type="radio" name="selfDeclaredMadeForKids" value="true" required ${ready ? '' : 'disabled'}> 예, 아동용입니다</label>
          <label class="generation-checkbox"><input type="radio" name="selfDeclaredMadeForKids" value="false" ${ready ? '' : 'disabled'}> 아니요, 아동용이 아닙니다</label>
        </fieldset>
        <fieldset class="generation-parameters"><legend>AI 생성·변형 콘텐츠 공개 여부 (필수)</legend>
          <label class="generation-checkbox"><input type="radio" name="containsSyntheticMedia" value="true" required ${ready ? '' : 'disabled'}> 예, AI로 생성되었거나 사실적으로 변형된 콘텐츠를 포함합니다</label>
          <label class="generation-checkbox"><input type="radio" name="containsSyntheticMedia" value="false" ${ready ? '' : 'disabled'}> 아니요, 해당 없음</label>
        </fieldset>
        <label>공개 범위 결정 근거 (필수)<textarea name="disclosureRationale" maxlength="2000" rows="2" required ${ready ? '' : 'disabled'}></textarea></label>
        <label class="generation-checkbox"><input type="checkbox" name="rightsAcknowledged" value="true" required ${ready ? '' : 'disabled'}> 이 제작물의 모든 소스·이용 권리·출처 표기를 확인했으며, 공개 게시에 대한 책임을 인정합니다.</label>
        <div class="dialog-actions" style="border:0;padding:12px 0 0"><button class="primary" type="submit" ${ready && canMutate() && !busy ? '' : 'disabled'}>${approving ? '미리보기 준비 중…' : '게시 준비 · 미리보기'}</button></div>
        </fieldset>
      </form>${approvedSummaryHtml()}`;
  }

  function publicationsHtml() {
    if (publicationsError) return `<p class="hint danger">${esc(publicationsError)}</p>`;
    if (!publicationsLoaded) return '<p class="hint">불러오는 중…</p>';
    if (!publications.length) return '<p class="hint">게시 기록이 없습니다.</p>';
    return `<button class="small" type="button" data-pt-action="reload-publications">게시 기록 새로고침</button><div class="data-list">${publications.map(pub => `<div class="data-row"><div><h3>${esc(pub.title || pub.manifest?.title || pub.id)}</h3><p>${esc(stamp(pub.createdAt))}</p><button class="small" type="button" data-pt-action="inspect-publication" data-id="${esc(pub.id)}">이 승인·기존 작업 확인</button></div><span class="badge ${publicVerified(pub.intent) ? 'lime' : ['blocked', 'failed', 'private_restricted'].includes(pub.intent?.status) ? 'coral' : ''}">${esc(pub.intent ? intentLabel(pub.intent) : '서버 승인 · 전송 증거 확인 필요')}</span></div>`).join('')}</div>`;
  }

  function disconnectDialogHtml() {
    if (!disconnectOpen) return '';
    return `<h2 id="pt-disconnect-title">YouTube 연결 해제</h2>
      <p>저장된 인증 정보를 삭제합니다. 다시 게시하려면 재인증이 필요합니다. 이미 시작된 게시 작업에는 영향을 주지 않습니다.</p>
      <div class="dialog-actions"><button type="button" data-pt-action="close-disconnect">취소</button><button class="danger" type="button" data-pt-action="confirm-disconnect" ${canMutate() ? '' : 'disabled'}>${disconnecting ? '해제 중…' : '연결 해제'}</button></div>`;
  }

  function deliveryHtml() {
    const ctx = getWorkflowContext?.() || {};
    const episode = getEpisode?.(ctx.episodeId);
    return `<div data-production-tools data-mode="delivery">
      <section class="panel section-spacer" aria-label="배포 도구">
        <div class="panel-header"><h2>배포 · 공개 게시</h2></div>
        <div class="panel-body">
          ${contextSummaryHtml(ctx, episode)}
          <div class="section-spacer"><h3>YouTube 채널 연결</h3><div id="pt-oauth">${oauthHtml(ctx)}</div></div>
          <div class="section-spacer"><h3>최종 승인 및 공개 게시</h3><div id="pt-approval">${approvalHtml(ctx, episode)}</div></div>
          <div class="section-spacer"><h3>이 에피소드의 게시 기록</h3><div id="pt-publications">${publicationsHtml()}</div></div>
          <div class="section-spacer">
            <p class="hint">YouTube Studio에서 처리 상태·저작권 확인·수익화 등을 직접 확인할 수 있습니다. 파일을 자동으로 연결하거나 클릭하지 않으며, 별도 탭에서 직접 로그인해 확인하는 용도입니다.</p>
            <a href="https://studio.youtube.com" target="_blank" rel="noopener">YouTube Studio 열기 ↗</a>
          </div>
        </div>
      </section>
      <dialog data-pt-dialog="disconnect" id="pt-disconnect-dialog" aria-labelledby="pt-disconnect-title">${disconnectDialogHtml()}</dialog>
    </div>`;
  }

  // ===================== Shared lifecycle =====================

  function html({ mode: requestedMode = 'source' } = {}) {
    syncContext();
    mode = MODES.has(requestedMode) ? requestedMode : 'source';
    return mode === 'delivery' ? deliveryHtml() : sourceHtml();
  }

  function findRoot() {
    return document.querySelector(`[data-production-tools][data-mode="${mode}"]`);
  }

  function repaint() {
    if (!root || !root.isConnected) return;
    const savedForms = [...root.querySelectorAll('form')].map(form => ({ id: form.id, fields: [...form.elements].filter(item => item.name).map(item => ({ name: item.name, type: item.type, value: item.value, checked: item.checked })) }));
    const active = document.activeElement;
    const within = active && root.contains(active);
    const hint = within ? { action: active.dataset?.ptAction || '', id: active.dataset?.id || '', name: active.name || '', formId: active.closest?.('form')?.id || '' } : null;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html({ mode });
    root.replaceWith(wrapper.firstElementChild);
    mount();
    for (const saved of savedForms) {
      const form = root?.querySelector(`#${CSS.escape(saved.id)}`);
      if (!form) continue;
      for (const field of saved.fields) {
        const controls = [...form.elements].filter(item => item.name === field.name);
        for (const control of controls) {
          if (['checkbox', 'radio'].includes(field.type)) { if (control.value === field.value) control.checked = field.checked; }
          else control.value = field.value;
        }
      }
      if (saved.id === 'pt-attach-form') {
        const slotId = saved.fields.find(field => field.name === 'slotId')?.value || '';
        refreshSlotOptions(form.elements.sceneId.value);
        form.elements.slotId.value = slotId;
      }
    }
    if (!hint) return;
    let next = null;
    if (hint.action) next = root?.querySelector(`[data-pt-action="${hint.action}"]${hint.id ? `[data-id="${CSS.escape(hint.id)}"]` : ''}`);
    else if (hint.formId && hint.name) next = root?.querySelector(`#${CSS.escape(hint.formId)} [name="${CSS.escape(hint.name)}"]`);
    next?.focus?.({ preventScroll: true });
  }

  function reopenDialogs() {
    const openMap = { import: Boolean(importTarget), rights: Boolean(rightsTarget), attach: Boolean(attachTarget), card: cardTarget, disconnect: disconnectOpen };
    for (const [name, open] of Object.entries(openMap)) {
      const dialog = root.querySelector(`[data-pt-dialog="${name}"]`);
      if (!dialog) continue;
      if (open && !dialog.open) { try { dialog.showModal(); } catch { /* already open or not attached */ } }
      else if (!open && dialog.open) dialog.close();
    }
  }

  function clearDialogTarget(name) {
    if (name === 'import') importTarget = null;
    else if (name === 'rights') rightsTarget = null;
    else if (name === 'attach') attachTarget = null;
    else if (name === 'card') cardTarget = false;
    else if (name === 'disconnect') disconnectOpen = false;
  }

  function restoreDialogFocus() {
    if (!dialogFocus || !root) return;
    const { action, id, index } = dialogFocus;
    root.querySelector(`[data-pt-action="${CSS.escape(action)}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}${index !== undefined ? `[data-index="${CSS.escape(index)}"]` : ''}`)?.focus?.({ preventScroll: true });
  }

  function refreshSlotOptions(sceneId) {
    const select = root?.querySelector('#pt-attach-form [name="slotId"]');
    if (!select) return;
    const ctx = getWorkflowContext?.() || {};
    const episode = getEpisode?.(ctx.episodeId);
    const scene = episode?.scenes?.find(item => item.id === sceneId);
    const slots = Array.isArray(scene?.slots) ? scene.slots : [];
    select.innerHTML = `<option value="">전체 장면</option>${slots.map(slot => `<option value="${esc(slot.id)}">${esc(slot.name || slot.id)}</option>`).join('')}`;
  }

  // ---- Source async actions ----

  async function loadUploads() {
    if (uploadsLoading) return;
    const target = capture(); uploadsLoading = true;
    try {
      const result = await api('/api/uploads');
      if (!matches(target, false)) return;
      if (!Array.isArray(result)) throw new Error('업로드 목록 응답 형식이 올바르지 않습니다.');
      uploads = result; uploadsError = '';
    } catch (error) { if (matches(target, false)) uploadsError = error.message; }
    finally { if (target.lifetime === lifetime) { uploadsLoading = false; uploadsLoaded = true; repaint(); } }
  }

  async function checkRights(uploadId) {
    const target = capture();
    const current = uploadRights.get(uploadId);
    if (current?.state === 'cleared' || current?.state === 'checking') return;
    uploadRights.set(uploadId, { state: 'checking', record: null });
    repaint();
    try {
      const result = await api(`/api/uploads/${encodeURIComponent(uploadId)}/rights`);
      if (!matches(target, false)) return;
      const upload = uploads.find(item => item.id === uploadId);
      const records = Array.isArray(result) ? result : [result];
      const record = records.find(item => item?.uploadId === uploadId && item.sha256 === upload?.sha256) || null;
      uploadRights.set(uploadId, record ? { state: 'cleared', record } : { state: 'none', record: null });
    } catch (error) {
      if (!matches(target, false)) return;
      uploadRights.set(uploadId, { state: 'error', record: null });
      toast(`권리 정보를 확인하지 못했습니다. ${error.message}`, true);
    }
    repaint();
  }

  async function doImport(button) {
    const item = importTarget;
    const target = capture();
    const useAs = importUseAs;
    if (!item?.supported || !importAcknowledged || busy || !guardMutate()) return;
    busy = true; button.disabled = true; repaint();
    try {
      const upload = await api('/api/sources/import', { method: 'POST', body: JSON.stringify({ pageId: item.pageId, kind: item.kind, useAs, rightsAcknowledged: true }) });
      if (!matches(target, false)) return;
      uploads = [upload, ...uploads.filter(entry => entry.id !== upload.id)];
      uploadRights.set(upload.id, { state: 'unchecked', record: null });
      importTarget = null;
      toast('미디어를 가져왔습니다. 이제 이용 권리를 정리하세요.');
    } catch (error) { toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  async function submitRights(form) {
    const target = capture();
    const uploadId = rightsTarget;
    if (!uploadId || busy || !guardMutate()) return;
    const data = new FormData(form);
    const origin = String(data.get('origin') || '');
    if (!['own', 'third-party', 'generated'].includes(origin)) { toast('출처 구분을 선택하세요.', true); return; }
    const body = { origin };
    if (origin === 'generated' && data.get('generationJobId')) body.generationJobId = String(data.get('generationJobId')).trim();
    if (origin === 'third-party') {
      body.sourceUrl = String(data.get('sourceUrl') || '').trim();
      body.licenseId = String(data.get('licenseId') || '').trim();
      body.attribution = String(data.get('attribution') || '').trim();
      if (!body.sourceUrl || !body.licenseId || !body.attribution) { toast('제3자 자료는 출처 URL·라이선스·출처 표기가 모두 필요합니다.', true); return; }
    }
    busy = true; repaint();
    try {
      const record = await api(`/api/uploads/${encodeURIComponent(uploadId)}/rights`, { method: 'POST', body: JSON.stringify(body) });
      if (!matches(target, false)) return;
      uploadRights.set(uploadId, { state: 'cleared', record });
      rightsTarget = null;
      toast('이용 권리를 정리했습니다.');
    } catch (error) { toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  async function submitAttach(form) {
    const target = capture();
    const uploadId = attachTarget;
    if (!uploadId || busy || !guardMutate()) return;
    const ctx = getWorkflowContext?.() || {};
    const episodeId = ctx.episodeId;
    const episode = getEpisode?.(episodeId);
    if (!episodeId || !episode) { toast('대상 에피소드를 확인할 수 없습니다.', true); return; }
    const expectedVersion = episode.version;
    const data = new FormData(form);
    const sceneId = String(data.get('sceneId') || '');
    if (!sceneId) { toast('대상 장면을 선택하세요.', true); return; }
    const slotId = String(data.get('slotId') || '');
    const useAs = String(data.get('useAs') || 'illustration');
    const trimStartRaw = data.get('trimStart');
    const trimEndRaw = data.get('trimEnd');
    const trimStart = trimStartRaw !== null && trimStartRaw !== '' ? Number(trimStartRaw) : undefined;
    const trimEnd = trimEndRaw !== null && trimEndRaw !== '' ? Number(trimEndRaw) : undefined;
    const item = uploads.find(entry => entry.id === uploadId);
    const rights = uploadRights.get(uploadId)?.record;
    if (!item?.sha256 || rights?.sha256 !== item.sha256) { toast('현재 파일 해시와 일치하는 권리 확인이 필요합니다.', true); return; }
    if ((trimStart !== undefined && (!Number.isFinite(trimStart) || trimStart < 0)) || (trimEnd !== undefined && (!Number.isFinite(trimEnd) || trimEnd <= (trimStart || 0))) || (Number.isFinite(item.duration) && ((trimEnd ?? trimStart ?? 0) > item.duration))) { toast('영상 길이 안에서 올바른 트림 범위를 입력하세요.', true); return; }
    if (!episode.scenes?.some(scene => scene.id === sceneId && (!slotId || scene.slots?.some(slot => slot.id === slotId)))) { toast('대상 장면·슬롯이 현재 프로젝트에 없습니다.', true); return; }
    busy = true; repaint();
    try {
      const body = { sceneId, uploadId, expectedVersion, useAs, ...(slotId ? { slotId } : {}), ...(trimStart !== undefined ? { trimStart } : {}), ...(trimEnd !== undefined ? { trimEnd } : {}) };
      await requireSavedEpisode(target);
      const updated = await api(`/api/episodes/${encodeURIComponent(episodeId)}/source`, { method: 'POST', body: JSON.stringify(body) });
      if (matches(target) && updated?.id === episodeId) { attachTarget = null; onEpisodeUpdated(updated); }
      toast('장면에 연결했습니다.');
    } catch (error) { toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  async function submitCard(form) {
    const target = capture();
    if (busy || !guardMutate()) return;
    const ctx = getWorkflowContext?.() || {};
    const episodeId = ctx.episodeId;
    const episode = getEpisode?.(episodeId);
    if (!episodeId || !episode) { toast('대상 에피소드를 확인할 수 없습니다.', true); return; }
    const expectedVersion = episode.version;
    const sceneId = String(new FormData(form).get('sceneId') || '');
    if (!sceneId) { toast('대상 장면을 선택하세요.', true); return; }
    busy = true; repaint();
    try {
      await requireSavedEpisode(target);
      const updated = await api(`/api/episodes/${encodeURIComponent(episodeId)}/card`, { method: 'POST', body: JSON.stringify({ sceneId, expectedVersion }) });
      if (matches(target) && updated?.id === episodeId) { cardTarget = false; onEpisodeUpdated(updated); }
      toast('텍스트 카드로 전환했습니다.');
    } catch (error) { toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  async function handleUploadFile(input) {
    const target = capture();
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy || !guardMutate()) return;
    busy = true; repaint();
    try {
      toast('업로드하는 중입니다…');
      const saved = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!matches(target, false)) return;
      uploads = [saved, ...uploads.filter(entry => entry.id !== saved.id)];
      uploadRights.set(saved.id, { state: 'unchecked', record: null });
      toast('업로드했습니다. 이제 이용 권리를 정리하세요.');
    } catch (error) { toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  async function submitSearch(form) {
    const target = capture();
    if (busy || search.loading) return;
    const data = new FormData(form);
    const query = String(data.get('query') || '').trim();
    const kind = data.get('kind') === 'video' ? 'video' : 'image';
    if (!query) { toast('검색어를 입력하세요.', true); return; }
    search.query = query; search.kind = kind; search.loading = true; search.items = []; search.error = ''; search.retryAfter = null; search.status = null;
    repaint();
    try {
      const result = await api(`/api/sources/search?query=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}&limit=${search.limit}`);
      if (!matches(target, false)) return;
      search.status = typeof result?.status === 'string' ? result.status : 'provider_invalid_response';
      if (result?.status === 'ok' && !Array.isArray(result.items)) throw new Error('Commons 검색 응답 형식이 올바르지 않습니다.');
      search.items = Array.isArray(result?.items) ? result.items.map(item => ({ ...item, kind: mediaKind(item), descriptionUrl: item.sourceUrl || item.descriptionUrl })) : [];
      search.retryAfter = Number.isFinite(result?.retryAfter) ? result.retryAfter : null;
      search.error = result?.message || result?.error || '';
    } catch (error) { if (matches(target, false)) { search.status = error.status === 403 ? 'provider_blocked' : error.status === 429 ? 'provider_rate_limited' : error.status === 503 ? 'not_configured' : 'provider_unavailable'; search.error = error.message; } }
    finally { if (target.lifetime === lifetime) { search.loading = false; repaint(); } }
  }

  // ---- Delivery async actions ----

  async function loadOauth(target = capture()) {
    const channelId = target.ctx.channelId;
    if (!channelId) { oauth = null; oauthError = ''; repaint(); return; }
    oauthLoading = true;
    try {
      const result = await api(`/api/channels/${encodeURIComponent(channelId)}/youtube`);
      if (!matches(target, false)) return;
      if (result?.channelId !== channelId) throw new Error('연결 상태의 채널이 일치하지 않습니다.');
      oauth = result; oauthError = '';
    } catch (error) { if (matches(target, false)) { oauthError = error.message; oauth = null; } }
    finally { if (target.lifetime === lifetime) { oauthLoading = false; oauthLoaded = true; repaint(); } }
  }

  async function submitChannel(form) {
    const target = capture();
    if (busy || !guardMutate()) return;
    const ctx = getWorkflowContext?.() || {};
    const channelId = ctx.channelId;
    if (!channelId) { toast('채널을 먼저 선택하세요.', true); return; }
    const externalId = String(new FormData(form).get('externalId') || '').trim();
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(externalId)) { toast('올바른 YouTube 채널 ID(UC로 시작하는 24자) 형식이 아닙니다.', true); return; }
    // expectedUpdatedAt is the FrameForge channel entity's own updatedAt (confirmed by DeliveryImplementation as
    // oauth.channelUpdatedAt, read fresh on every status() call) - distinct from oauth.lastCheckedAt, which is the
    // OAuth record's own check time, not the channel entity's concurrency token.
    const expectedUpdatedAt = oauth?.channelUpdatedAt;
    if (!expectedUpdatedAt) { toast('채널 동시성 정보를 확인할 수 없어 저장할 수 없습니다. 상태를 새로고침한 뒤 다시 시도하세요.', true); return; }
    busy = true; savingExternalId = true; repaint();
    try {
      await api(`/api/channels/${encodeURIComponent(channelId)}/youtube`, { method: 'PUT', body: JSON.stringify({ externalId, expectedUpdatedAt }) });
      if (!matches(target, false)) return;
      invalidatePreview(); authUrl = '';
      toast('채널 ID를 저장했습니다.');
      await loadOauth(target);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; savingExternalId = false; repaint(); }
  }

  async function doAuthorize() {
    const target = capture();
    if (busy || !guardMutate()) return;
    const ctx = getWorkflowContext?.() || {};
    const channelId = ctx.channelId;
    if (!channelId || oauth?.channelId !== channelId || oauth.configured === false || !/^UC[A-Za-z0-9_-]{22}$/.test(oauth.channelExternalId || '')) { toast('서버 설정과 저장된 YouTube 채널 ID를 확인하세요.', true); return; }
    busy = true; authorizing = true; authUrl = ''; repaint();
    try {
      const result = await api(`/api/channels/${encodeURIComponent(channelId)}/youtube/authorize`, { method: 'POST' });
      if (!matches(target, false)) return;
      const url = new URL(result?.authUrl);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password) throw new Error('허용되지 않은 Google 인증 URL입니다.');
      authUrl = url.href;
      if (!authUrl) toast('인증 URL을 받지 못했습니다.', true);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; authorizing = false; repaint(); }
  }

  async function doDisconnect() {
    const target = capture();
    if (busy || !guardMutate()) return;
    const ctx = getWorkflowContext?.() || {};
    const channelId = ctx.channelId;
    if (!channelId) return;
    busy = true; disconnecting = true; repaint();
    try {
      await api(`/api/channels/${encodeURIComponent(channelId)}/youtube`, { method: 'DELETE' });
      if (!matches(target, false)) return;
      disconnectOpen = false; authUrl = '';
      invalidatePreview();
      toast('연결을 해제했습니다.');
      await loadOauth(target);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; disconnecting = false; repaint(); }
  }

  async function submitApproval(form) {
    const target = capture();
    const revision = previewRevision;
    if (busy || !guardMutate()) return;
    if (publishAttempted) { toast('기존 게시 작업을 확인하세요. 새 승인은 만들지 않습니다.', true); return; }
    if (publications.some(item => item.intent && item.intent.status !== 'completed')) { toast('기존 게시 작업의 상태를 먼저 확인하세요. 불확실한 작업을 새 승인으로 재전송하지 않습니다.', true); return; }
    const ctx = getWorkflowContext?.() || {};
    const { episodeId, workflowId, runId, reviewNodeId } = ctx;
    if (!workflowId || !runId || !reviewNodeId) { toast('실행과 검토 노드를 먼저 선택하세요.', true); return; }
    const episode = getEpisode?.(episodeId);
    if (!episode) { toast('에피소드를 확인할 수 없습니다.', true); return; }
    const expectedEpisodeVersion = episode.version;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    const categoryId = String(data.get('categoryId') || '');
    const selfDeclared = data.get('selfDeclaredMadeForKids');
    const synthetic = data.get('containsSyntheticMedia');
    const rightsAcknowledged = data.get('rightsAcknowledged') === 'true';
    if (!title || !categoryId) { toast('제목과 카테고리를 입력하세요.', true); return; }
    if (!String(data.get('description') || '').trim() || !String(data.get('disclosureRationale') || '').trim()) { toast('설명과 공개 범위 결정 근거를 입력하세요.', true); return; }
    if (!['true', 'false'].includes(selfDeclared) || !['true', 'false'].includes(synthetic)) { toast('아동용 여부와 AI 콘텐츠 공개 여부를 모두 선택하세요.', true); return; }
    if (!rightsAcknowledged) { toast('이용 권리 확인에 동의해야 승인할 수 있습니다.', true); return; }
    const body = {
      workflowId, runId, reviewNodeId, expectedEpisodeVersion, title,
      description: String(data.get('description') || ''),
      categoryId,
      tags: String(data.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean),
      selfDeclaredMadeForKids: selfDeclared === 'true',
      containsSyntheticMedia: synthetic === 'true',
      disclosureRationale: String(data.get('disclosureRationale') || ''),
      rightsAcknowledged: true,
    };
    approval = null; previewBinding = null; approvalError = '';
    busy = true; approving = true; repaint();
    try {
      await requireSavedEpisode(target);
      await requireSavedWorkflow(target);
      if (previewRevision !== revision) return;
      const result = await api('/api/publication/approvals', { method: 'POST', body: JSON.stringify(body) });
      if (!matches(target) || previewRevision !== revision) return;
      if (!result?.id || !result.manifest || typeof result.fingerprint !== 'string' || !result.fingerprint) throw new Error('서버 승인에 전체 manifest 또는 fingerprint가 없습니다. 공개할 수 없습니다.');
      approval = result;
      previewBinding = target;
      intent = null;
      toast('서버 미리보기를 준비했습니다. 전체 manifest와 크레딧을 확인하세요.');
    } catch (error) { if (matches(target, false) && previewRevision === revision) approvalError = error.message; }
    finally { busy = false; approving = false; repaint(); }
  }

  function stopPolling() { if (polling) { clearTimeout(polling); polling = null; } }

  function startPolling() {
    stopPolling();
    if (!root?.isConnected || !publishAttempted || INTENT_TERMINAL.has(intent?.status)) return;
    const approvalId = approval?.id;
    if (!approvalId) return;
    const target = capture();
    polling = setTimeout(async () => {
      polling = null;
      if (!root?.isConnected || approval?.id !== approvalId || !matches(target, false)) return;
      try {
        const result = await api(`/api/publication/approvals/${encodeURIComponent(approvalId)}`);
        if (!root?.isConnected || approval?.id !== approvalId || !matches(target, false)) return;
        intent = publicationIntent(result);
        intentError = '';
        repaint();
      } catch (error) { if (matches(target, false)) { intentError = `기존 작업 상태 확인 실패: ${error.message}`; repaint(); } }
      if (root?.isConnected && matches(target, false)) startPolling();
    }, 6000);
  }

  function publicationIntent(result) {
    // Service.state may include the sanitized approval alongside its intent.
    const value = result?.intent ?? (result?.status && result?.id !== approval?.id ? result : null);
    if (value && approval && value.approvalId && value.approvalId !== approval.id) throw new Error('게시 작업의 승인 ID가 일치하지 않습니다.');
    if (value?.status === 'completed' && !publicVerified(value)) return { ...value, status: 'unknown', message: '서버의 공개 readback 검증 증거가 누락되었습니다. 기존 작업만 확인하세요.' };
    return value;
  }

  async function doPublish() {
    const target = capture();
    if (busy || !approval || !guardMutate()) return;
    if (publishAttempted) { await doRefreshIntent(); return; }
    if (!previewBinding || !matches(previewBinding) || !approval.manifest || !approval.fingerprint) { invalidatePreview(); repaint(); toast('제작물 또는 입력이 변경되었습니다. 미리보기를 다시 준비하세요.', true); return; }
    const approvalId = approval.id;
    busy = true; publishing = true; publishAttempted = true; intentError = ''; repaint();
    try {
      const result = await api(`/api/publication/approvals/${encodeURIComponent(approvalId)}/publish`, { method: 'POST', body: '{}' });
      if (!matches(target, false) || approval?.id !== approvalId) return;
      intent = publicationIntent(result);
      toast('게시 작업을 시작했습니다.');
      startPolling();
    } catch (error) {
      if (!matches(target, false) || approval?.id !== approvalId) return;
      intentError = `게시 응답을 확인할 수 없습니다. 새 업로드를 만들지 않고 기존 승인 작업을 확인합니다. ${error.message}`;
      await doRefreshIntent(target, approvalId);
      startPolling();
    }
    finally { busy = false; publishing = false; repaint(); }
  }

  async function doResume() {
    const target = capture();
    if (busy || !intent || !guardMutate()) return;
    const intentId = intent.id;
    const approvalId = approval?.id;
    busy = true; publishing = true; repaint();
    try {
      const result = await api(`/api/publication/intents/${encodeURIComponent(intentId)}/resume`, { method: 'POST', body: '{}' });
      if (!matches(target, false) || approval?.id !== approvalId) return;
      intent = publicationIntent(result);
      toast('게시 작업을 다시 확인·재개했습니다.');
      startPolling();
    } catch (error) { if (matches(target, false)) { intentError = error.message; await doRefreshIntent(target, approvalId); } }
    finally { busy = false; publishing = false; repaint(); }
  }

  async function doRefreshIntent(target = capture(), approvalId = approval?.id) {
    if (!approvalId) return;
    try {
      const result = await api(`/api/publication/approvals/${encodeURIComponent(approvalId)}`);
      if (!matches(target, false) || approval?.id !== approvalId) return;
      intent = publicationIntent(result);
      repaint();
    } catch (error) { if (matches(target, false)) { intentError = error.message; toast(error.message, true); repaint(); } }
  }

  async function loadPublications() {
    const target = capture();
    const episodeId = target.ctx.episodeId;
    if (!episodeId) { publications = []; publicationsLoaded = true; repaint(); return; }
    if (publicationsLoading) return;
    publicationsLoading = true;
    try {
      const result = await api(`/api/episodes/${encodeURIComponent(episodeId)}/publications`);
      if (!matches(target, false)) return;
      if (!Array.isArray(result)) throw new Error('게시 기록 응답 형식이 올바르지 않습니다.');
      publications = result; publicationsError = '';
    } catch (error) { if (matches(target, false)) publicationsError = error.message; }
    finally { if (target.lifetime === lifetime) { publicationsLoading = false; publicationsLoaded = true; repaint(); } }
  }

  async function inspectPublication(approvalId) {
    const target = capture();
    const known = publications.find(item => item.id === approvalId);
    if (!known || busy) return;
    busy = true;
    try {
      const result = await api(`/api/publication/approvals/${encodeURIComponent(approvalId)}`);
      if (!matches(target)) return;
      const record = result?.approval || known;
      if (record.id !== approvalId || !record.manifest || !record.fingerprint) throw new Error('전체 서버 승인 manifest가 없어 재개할 수 없습니다.');
      approval = record; previewBinding = target;
      intent = publicationIntent(result);
      publishAttempted = Boolean(intent) || result.status !== 'approved'; intentError = '';
      startPolling();
    } catch (error) { if (matches(target, false)) toast(error.message, true); }
    finally { busy = false; repaint(); }
  }

  // ---- Delegated listeners ----

  async function onClick(event) {
    const button = event.target.closest('[data-pt-action]');
    if (!button) return;
    const action = button.dataset.ptAction;
    if (busy && !['close-import', 'close-rights', 'close-attach', 'close-card', 'close-disconnect'].includes(action)) return;
    if (action.startsWith('open-')) dialogFocus = { action, id: button.dataset.id, index: button.dataset.index };
    if (action.startsWith('close-')) {
      clearDialogTarget(action.slice(6)); repaint();
      restoreDialogFocus();
      return;
    }
    if (action === 'inspect-publication') { await inspectPublication(button.dataset.id); return; }
    if (action === 'reload-publications') { await loadPublications(); return; }
    if (action === 'upload') { root.querySelector('#pt-upload-file')?.click(); return; }
    if (action === 'open-import') { importTarget = search.items[Number(button.dataset.index)] || null; importAcknowledged = false; repaint(); return; }
    if (action === 'confirm-import') { await doImport(button); return; }
    if (action === 'open-rights') { rightsTarget = button.dataset.id; repaint(); await checkRights(rightsTarget); return; }
    if (action === 'open-attach') { attachTarget = button.dataset.id; repaint(); return; }
    if (action === 'open-card') { cardTarget = true; repaint(); return; }
    if (action === 'reload-uploads') { uploadsLoaded = false; await loadUploads(); return; }
    if (action === 'reload-oauth') { await loadOauth(); return; }
    if (action === 'authorize') { await doAuthorize(); return; }
    if (action === 'open-disconnect') { disconnectOpen = true; repaint(); return; }
    if (action === 'confirm-disconnect') { await doDisconnect(); return; }
    if (action === 'refresh-intent') { await doRefreshIntent(); return; }
    if (action === 'resume-intent') { await doResume(); return; }
    if (action === 'publish-approval') { await doPublish(); return; }
  }

  function onChange(event) {
    onInput(event);
    const target = event.target;
    if (target.id === 'pt-upload-file') { handleUploadFile(target); return; }
    if (target.name === 'useAs' && target.closest('#pt-import-dialog')) { importUseAs = target.value; return; }
    if (target.id === 'pt-import-ack') { importAcknowledged = target.checked; const confirmButton = root.querySelector('[data-pt-action="confirm-import"]'); if (confirmButton) confirmButton.disabled = !(importAcknowledged && importTarget?.supported); return; }
    if (target.name === 'sceneId' && target.closest('#pt-attach-form')) { refreshSlotOptions(target.value); return; }
  }

  function rememberApproval(form) {
    if (!form) return;
    approvalDraft = Object.fromEntries(new FormData(form));
  }

  function onInput(event) {
    if (!event.target.closest('#pt-approval-form') || publishAttempted) return;
    rememberApproval(event.target.closest('form'));
    invalidatePreview();
    root?.querySelector('[aria-label="서버 게시 미리보기"]')?.remove();
  }

  async function onSubmit(event) {
    const form = event.target;
    if (!form.matches('#pt-search-form, #pt-rights-form, #pt-attach-form, #pt-card-form, #pt-channel-form, #pt-approval-form')) return;
    event.preventDefault();
    if (busy) return;
    if (form.id === 'pt-search-form') { await submitSearch(form); return; }
    if (form.id === 'pt-rights-form') { await submitRights(form); return; }
    if (form.id === 'pt-attach-form') { await submitAttach(form); return; }
    if (form.id === 'pt-card-form') { await submitCard(form); return; }
    if (form.id === 'pt-channel-form') { await submitChannel(form); return; }
    if (form.id === 'pt-approval-form') { await submitApproval(form); return; }
  }

  function mount() {
    syncContext();
    bindings?.abort();
    root = findRoot();
    if (!root) return;
    bindings = new AbortController();
    const { signal } = bindings;
    root.addEventListener('click', onClick, { signal });
    root.addEventListener('change', onChange, { signal });
    root.addEventListener('input', onInput, { signal });
    root.addEventListener('submit', onSubmit, { signal });
    for (const dialog of root.querySelectorAll('dialog[data-pt-dialog]')) {
      dialog.addEventListener('cancel', event => { event.preventDefault(); clearDialogTarget(dialog.dataset.ptDialog); dialog.close(); restoreDialogFocus(); }, { signal });
    }
    reopenDialogs();
    const form = root.querySelector('#pt-approval-form');
    if (form && Object.keys(approvalDraft).length) {
      for (const control of form.elements) {
        if (!control.name) continue;
        if (['radio', 'checkbox'].includes(control.type)) control.checked = approvalDraft[control.name] === control.value;
        else if (control.name in approvalDraft) control.value = approvalDraft[control.name];
      }
    }
    if (mode === 'source' && !uploadsLoaded && !uploadsLoading) loadUploads();
    if (mode === 'delivery') {
      if (!oauthLoaded && !oauthLoading) loadOauth();
      if (!publicationsLoaded && !publicationsLoading) loadPublications();
    }
  }

  function destroy() {
    rememberApproval(root?.querySelector('#pt-approval-form'));
    bindings?.abort();
    bindings = null;
    stopPolling();
    root = null;
    lifetime += 1;
    oauthLoading = false; publicationsLoading = false; uploadsLoading = false; search.loading = false;
    for (const [id, value] of uploadRights) if (value.state === 'checking') uploadRights.delete(id);
  }

  function getStatus() {
    syncContext();
    return { mode, episodeId: capture().ctx.episodeId ?? null, channelId: capture().ctx.channelId ?? null,
      busy, sourceStatus: search.status, approvalId: approval?.id ?? null, fingerprint: approval?.fingerprint ?? null,
      intentId: intent?.id ?? null, publicationStatus: intent?.status ?? (publishAttempted ? 'unknown' : null) };
  }

  return Object.freeze({ html, mount, destroy, getStatus });
}
