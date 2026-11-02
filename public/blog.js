import { hasVerifiedReferenceEvidence } from './blog-reference-policy.js';

const $ = (selector) => document.querySelector(selector);
const accountOrder = ['naver-banggujin', 'naver-jelly_ggumi', 'naver-jennie_p', 'tistory', 'github-jellyggumi'];
const roleNames = { hermes: 'Hermes', aside: 'Aside', jeopi: 'jeopi', codex: 'Codex', antigravity: 'Antigravity' };
const fallbackRoles = { hermes: '원본 규칙 · 리서치 검토', aside: '계정 연결 · 게시 실행', jeopi: 'Jev API 작업 라우팅', codex: '구현 · 글 초안 작성', antigravity: '독립 검토' };
const buffers = new Map();
let state = { accounts: [], briefs: [], references: [], drafts: [], runs: [], schedules: [], approvals: [], agents: [], routing: {}, workspace: {} };
let activeId = '';
let session = { authenticated: false, canMutate: false };
let loading = false;
let refreshPending = false;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = (value) => String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const dateText = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST' : '시각 확인 안 됨';
const account = (id = activeId) => state.accounts.find((item) => item.id === id);
const draft = (id) => state.drafts.find((item) => item.id === id);
const latestBrief = (id) => state.briefs.filter((item) => item.accountId === id && item.accountVersion === account(id)?.version && item.workspaceVersion === state.workspace.version).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
const currentBrief = (id, view) => view.brief?.accountId === id && view.brief.accountVersion === account(id)?.version && view.brief.workspaceVersion === state.workspace.version ? { briefId: view.brief.id } : {};
function currentReference(id = activeId) {
  const selected = account(id);
  const category = selected?.nextMenu?.name || selected?.menus?.[selected?.menuCursor] || '';
  return state.references.find((item) => item.accountId === id && item.current === true && item.category === category && item.workspaceVersion === state.workspace.version && hasVerifiedReferenceEvidence(item)) || null;
}
const referenceFor = (id) => currentReference(id) ? { referenceId: currentReference(id).id } : {};
const draftReferenceCurrent = (item) => Boolean(item && currentReference(item.accountId)?.id === item.referenceId && currentReference(item.accountId)?.fingerprint === item.referenceFingerprint);
const configOf = (item) => ({ persona: item.persona || '', keywords: (item.keywords || []).join('\n'), menus: (item.menus || []).join('\n'), publicUrl: item.publicUrl || '', editorUrl: item.editorUrl || '' });
const contentOf = (item) => ({ title: item?.title || '', body: item?.body || '' });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const contentSignature = (value) => JSON.stringify([value.title, value.body]);
const safeUrl = (value) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

function buffer(id = activeId) {
  if (!buffers.has(id)) {
    const item = account(id);
    buffers.set(id, { config: configOf(item), configVersion: item.version, configDirty: false, schedule: null, scheduleDirty: false, query: '', agent: 'jeopi', brief: latestBrief(id), referenceInput: { profileUrl: '', postUrls: '' }, referenceDirty: false, selectedDraft: '', editors: new Map(), pending: false, notice: '', error: false, conflict: false });
  }
  return buffers.get(id);
}

function editor(view = buffer()) {
  if (!view.editors.has(view.selectedDraft)) {
    const item = draft(view.selectedDraft);
    view.editors.set(view.selectedDraft, { ...contentOf(item), version: item?.version, dirty: false, revision: 0, preview: null, approval: null, approvalBlocked: false, gitPlan: null, gitConsent: null });
  }
  return view.editors.get(view.selectedDraft);
}

function notify(message, error = false, id = activeId) {
  if (id && buffers.has(id)) Object.assign(buffer(id), { notice: message, error });
  if (!id || activeId === id) {
    $('#blog-notice').textContent = message;
    $('#blog-notice').dataset.kind = error ? 'error' : 'info';
  }
}

function invalidate(view, message = '편집이 바뀌어 이전 미리보기와 승인이 무효입니다. 저장 후 다시 검토하세요.') {
  for (const item of view.editors.values()) { item.preview = null; item.approval = null; item.approvalBlocked = true; item.gitPlan = null; item.gitConsent = null; }
  if (view === buffers.get(activeId)) {
    $('#blog-preview').hidden = true;
    $('#blog-approve-check').checked = false;
    $('#blog-format-check').checked = false;
    $('#blog-git-consent').checked = false;
    $('#blog-git-proposal').textContent = '편집 또는 원본 변경으로 Git 게시 계획과 동의가 무효입니다. 본문 재승인 후 정확한 계획을 다시 확인하세요.';
    $('#blog-preview-meta').textContent = message;
  }
}

function capture() {
  if (!activeId || !buffers.has(activeId)) return;
  const view = buffer();
  view.query = $('#blog-query').value;
  view.agent = $('#blog-agent').value || view.agent;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      session = { authenticated: false, canMutate: false };
      $('#blog-auth').hidden = false;
      controls();
    }
    const error = new Error(data.error || data.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function upsert(collection, item) {
  if (!item?.id) return;
  const index = state[collection].findIndex((entry) => entry.id === item.id);
  if (index < 0) state[collection].unshift(item);
  else state[collection][index] = item;
}

function mergeVersions(current, incoming = []) {
  const entries = new Map(incoming.map((item) => [item.id, item]));
  for (const item of current) {
    const remote = entries.get(item.id);
    if (!remote || Number(item.version) > Number(remote.version)) entries.set(item.id, item);
  }
  return [...entries.values()];
}

async function loadState() {
  const [next, auth] = await Promise.all([api('/api/blog/state'), api('/api/session')]);
  const previous = state;
  state = { ...next, accounts: mergeVersions(previous.accounts, next.accounts), briefs: next.briefs || [], references: next.references || [], drafts: mergeVersions(previous.drafts, next.drafts), runs: next.runs || [], schedules: mergeVersions(previous.schedules, next.schedules), approvals: mergeVersions(previous.approvals, next.approvals), agents: next.agents || [], workspace: next.workspace || {}, routing: next.routing || {} };
  session = auth;
  $('#blog-auth').hidden = Boolean(auth.authenticated);
  for (const [id, view] of buffers) {
    const current = account(id);
    if (!current) continue;
    if (previous.workspace.version !== state.workspace.version || previous.accounts.find((item) => item.id === id)?.version !== current.version) invalidate(view, '계정 또는 원본 버전이 바뀌었습니다. 최신 근거로 다시 검토하세요.');
    if (previous.references.find((item) => item.accountId === id && item.current === true)?.id !== currentReference(id)?.id) invalidate(view, '레퍼런스가 바뀌었거나 최신 자격 근거가 없습니다. 새 분석 계획을 초안에 저장하고 다시 검토하세요.');
    if (!view.configDirty) { view.config = configOf(current); view.configVersion = current.version; }
    if (!view.scheduleDirty) view.schedule = null;
    if (!view.brief || view.brief.accountVersion !== current.version || view.brief.workspaceVersion !== state.workspace.version) view.brief = latestBrief(id);
    for (const [draftId, value] of view.editors) {
      const saved = draft(draftId);
      if (saved && value.version !== saved.version) {
        value.approval = null; value.preview = null; value.gitPlan = null; value.gitConsent = null;
        if (!value.dirty) Object.assign(value, contentOf(saved), { version: saved.version });
      }
    }
  }
  if (!account(activeId)) activeId = state.accounts.find((item) => accountOrder.includes(item.id))?.id || state.accounts[0]?.id || '';
}

function evidenceHtml(evidence) {
  if (!evidence?.length) return '<p class="hint">출처 근거가 없습니다. 원본 경로 설정과 파일 존재 여부를 확인하세요.</p>';
  return evidence.map((item) => typeof item === 'string' ? `<div class="blog-evidence-item">${escapeHtml(item)}</div>` : `<div class="blog-evidence-item"><strong>${escapeHtml(item.id || item.label || item.source || '출처')}</strong><span>${escapeHtml(item.status || '상태 미확인')}</span><span class="blog-version">${escapeHtml(item.sha256 || item.hash || item.version || '해시 없음')}</span>${item.modifiedAt ? `<span>${escapeHtml(dateText(item.modifiedAt))}</span>` : ''}</div>`).join('');
}

function renderSources() {
  const workspace = state.workspace;
  $('#blog-source-state').textContent = workspace.latest === true ? '현재 원본 로드됨' : '최신 여부 미확인';
  $('#blog-source-version').textContent = workspace.version || '원본 버전 없음';
  $('#blog-source-time').textContent = `읽은 시각: ${dateText(workspace.refreshedAt)} · 선택 계정: ${sourceReady() ? '차단 근거 없음 (연결·본문 승인 별도)' : '원본 해결 필요'}`;
  const blockers = [...(workspace.blockedReasons || []), ...(workspace.sourceConflicts || []).map((item) => typeof item === 'string' ? item : item.detail || item.reason || JSON.stringify(item))];
  $('#blog-blocked-reasons').innerHTML = blockers.length ? `<ul class="blog-blocked">${blockers.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : '';
  $('#blog-source-evidence').innerHTML = evidenceHtml([...(workspace.sourceEvidence || []), ...(account()?.sourceEvidence || [])]);
}

function renderRoles() {
  const routing = state.routing;
  $('#blog-routing').innerHTML = `<p><strong>${escapeHtml(routing.profile || 'jeopi')} · ${escapeHtml(routing.backend || 'api')}</strong></p><p class="badge">${escapeHtml(routing.status || '미확인')}</p><p class="hint">${escapeHtml(routing.detail || 'Jev jeopi API 설정과 API 키를 확인하세요. 다른 프로필을 사용하지 않습니다.')}</p>${routing.receipt ? `<details><summary>실제 라우팅 영수증</summary><pre>${escapeHtml(JSON.stringify(routing.receipt, null, 2))}</pre></details>` : '<p class="hint">실제 API 라우팅 영수증 없음</p>'}`;
  $('#blog-roles').innerHTML = Object.entries(roleNames).map(([id, name]) => {
    const item = state.agents.find((entry) => String(entry.id || '').toLowerCase() === id);
    const observed = (value, yes, no) => value === true ? yes : value === false ? no : '미관찰';
    return `<div class="blog-role"><h3>${name} <small>· ${escapeHtml(item?.status || '확인 안 됨')}</small></h3><p>${escapeHtml(item?.role || fallbackRoles[id])}</p><small>설치 ${observed(item?.installed, '확인', '사용 불가')} · 설정 ${observed(item?.configured, '확인', '미설정')} · 실행 ${observed(item?.exercised, '검증됨', '미검증')}</small><p>${escapeHtml(item?.detail || '상태 응답에 이 에이전트의 실제 연결 근거가 없습니다.')}</p></div>`;
  }).join('');
}

function renderReferences() {
  const view = buffer(), eligible = currentReference();
  const reference = eligible || state.references.filter((item) => item.accountId === activeId).sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))[0];
  $('#blog-reference-profile').value = view.referenceInput.profileUrl;
  $('#blog-reference-posts').value = view.referenceInput.postUrls;
  $('#blog-reference-status').textContent = eligible ? '같은 주제 · 1만+ 공개 팬/이웃 · 분야·대표글 측정 검증됨' : reference ? '이전 분석 · 재검증 필요' : '검증한 레퍼런스 없음';
  if (!reference) { $('#blog-reference-result').innerHTML = '<p class="hint">프로필과 대표 글을 실제로 검사한 뒤 자동 초안 작성과 최종 승인을 진행할 수 있습니다. 수동 메모 초안은 별도로 저장할 수 있습니다.</p>'; return; }
  const metric = reference.metricEvidence || {};
  const kind = { fans: '공개 팬', neighbors: '공개 이웃', followers: '공개 팔로워', subscribers: '공개 구독자' }[metric.kind] || '지표 미확인';
  const metricUrl = safeUrl(metric.url);
  const plans = Object.entries({ layout: '실측 레이아웃 · 도입/섹션/마무리', images: '이미지 위치 · 비율 계획', formatting: '제목 · 문단 길이 · 서식', adaptation: '우리 페르소나에 적용할 구조' }).map(([key, title]) => `<section class="blog-reference-plan"><h3>${title}</h3>${Array.isArray(reference.analysis?.[key]) && reference.analysis[key].length ? `<ul>${reference.analysis[key].map((item) => `<li>${escapeHtml(item.guidance)}<small>관찰 근거: ${escapeHtml((item.basedOn || []).join(', ') || '근거 없음')}</small>${(item.sourceUrls || []).filter(safeUrl).map((url) => `<small><a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">관찰 원문 ↗</a></small>`).join('')}</li>`).join('')}</ul>` : '<p class="hint">관찰 가능한 측정 계획이 없습니다.</p>'}</section>`).join('');
  $('#blog-reference-result').innerHTML = `<p><strong>${escapeHtml(reference.category || '주제 미확인')}</strong> · ${eligible ? '현재 계정·메뉴·원본과 일치하는 분석' : '이전 계정·메뉴·원본의 관찰 기록입니다. 현재 글에는 사용하지 않습니다.'}</p><dl class="blog-reference-metric"><dt>공개 지표 종류</dt><dd>${kind} (방문·조회·좋아요 아님)</dd><dt>관찰한 인원 수</dt><dd>${Number.isFinite(Number(metric.count)) ? (Number(metric.count).toLocaleString('ko-KR') + (metric.precision === 'displayed-lower-bound' ? ' 이상 (표시 반올림 하한)' : '')) : '미확인'}</dd><dt>검증 출처</dt><dd>${metricUrl ? `<a href="${escapeHtml(metricUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(metricUrl)} ↗</a>` : '검증 가능한 URL 없음'}</dd><dt>관찰 시각</dt><dd>${escapeHtml(dateText(metric.observedAt || reference.observedAt))}</dd><dt>지표 근거</dt><dd>${escapeHtml(metric.excerpt || '근거 없음')}</dd><dt>원문 SHA256</dt><dd class="blog-version">${escapeHtml(metric.sha256 || '해시 없음')}</dd><dt>분석 지문</dt><dd class="blog-version">${escapeHtml(reference.fingerprint || '지문 없음')}</dd></dl>${plans}<details><summary>작성자·주제 근거와 측정값 · 원본 레지스트리</summary><pre>${escapeHtml(JSON.stringify({ references: reference.references, sourceRegistry: reference.sourceRegistry, contextFingerprint: reference.contextFingerprint, rightsStatement: reference.rightsStatement }, null, 2))}</pre></details>`;
}

function renderResearch() {
  const brief = buffer().brief;
  if (!brief) { $('#blog-research-result').innerHTML = '<p class="hint">실제 조사 결과가 여기에 표시됩니다. 자료 조사 후 출처를 열어 확인하세요.</p>'; return; }
  const sources = [...(brief.articles || []), ...(brief.trends || []), ...(brief.items || []), ...(brief.sources || [])];
  $('#blog-research-result').innerHTML = `<h3>${escapeHtml(brief.query || brief.title || '조사 결과')}</h3>${brief.summary ? `<p>${escapeHtml(brief.summary)}</p>` : ''}${sources.length ? `<ul>${sources.map((item) => `<li>${safeUrl(item.url || item.link) ? `<a href="${escapeHtml(safeUrl(item.url || item.link))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline || item.title || item.keyword || item.name || item.url)} ↗</a>` : `<strong>${escapeHtml(item.headline || item.title || item.keyword || item.name || '출처')}</strong>`}${item.summary || item.description ? `<p class="hint">${escapeHtml(item.summary || item.description)}</p>` : ''}</li>`).join('')}</ul>` : ''}<details><summary>원본 리서치 응답 · 출처 근거</summary><pre>${escapeHtml(JSON.stringify(brief, null, 2))}</pre></details>`;
}

function renderRuns() {
  const runs = state.runs.filter((item) => item.accountId === activeId).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  $('#blog-runs').innerHTML = runs.length ? runs.slice(0, 12).map((item) => `<div class="blog-run"><strong>${escapeHtml(item.kind)} · ${escapeHtml(item.status)}</strong><time datetime="${escapeHtml(item.startedAt || '')}">${escapeHtml(dateText(item.startedAt))}</time><p>${escapeHtml(item.detail || '상세 기록 없음')}</p>${item.output ? `<details><summary>실행 영수증</summary><pre>${escapeHtml(JSON.stringify(item.output, null, 2))}</pre></details>` : ''}</div>`).join('') : '<p class="hint">이 계정의 실행 기록이 없습니다.</p>';
}

function renderEditor() {
  const view = buffer(), value = editor(view), saved = draft(view.selectedDraft);
  const items = state.drafts.filter((item) => item.accountId === activeId);
  $('#blog-draft-select').innerHTML = '<option value="">새 수동 초안</option>' + items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title || '제목 없음')} · v${escapeHtml(item.version)} · ${escapeHtml(item.status || 'draft')}</option>`).join('');
  $('#blog-draft-select').value = view.selectedDraft;
  $('#blog-title').value = value.title;
  $('#blog-body').value = value.body;
  $('#blog-draft-version').textContent = saved ? `v${saved.version} · ${saved.status || 'draft'}` : '새 수동 초안';
  $('#blog-format-review').textContent = saved?.formatReview ? `형식 검토: ${saved.formatReview.status} · ${saved.formatReview.detail || '렌더링된 레이아웃·이미지 배치·권리 검토가 별도로 필요합니다.'}` : '렌더링된 레이아웃·이미지 배치·권리 검토는 아직 확인하지 않았습니다. 구조 계획의 전달만으로 검증 완료로 표시하지 않습니다.';
  $('#blog-applied-formatting').hidden = !saved?.appliedFormattingPlan;
  $('#blog-applied-formatting-data').textContent = saved?.appliedFormattingPlan ? JSON.stringify({ referenceId: saved.referenceId, referenceFingerprint: saved.referenceFingerprint, appliedFormattingPlan: saved.appliedFormattingPlan, formatReview: saved.formatReview || null }, null, 2) : '';
  $('#blog-preview').hidden = !value.preview;
  $('#blog-preview-title').textContent = value.preview ? value.title : '';
  $('#blog-preview-body').textContent = value.preview ? value.body : '';
  $('#blog-preview-plan').textContent = value.preview ? value.preview.planSignature : '';
  $('#blog-format-check').checked = Boolean(value.preview?.formatConfirmed);
  $('#blog-approve-check').checked = Boolean(value.preview?.confirmed);
  $('#blog-preview-meta').textContent = value.preview ? value.preview.label : '초안을 저장한 뒤 전체 본문을 열어 확인하세요.';
  $('#blog-git-publish').hidden = activeId !== 'github-jellyggumi';
  const plan = value.gitPlan?.plan;
  $('#blog-git-proposal').innerHTML = plan ? `<p class="hint">다음 계획을 확인한 뒤 Git 권한을 별도로 선택하세요.</p><pre>${escapeHtml(JSON.stringify(plan, null, 2))}</pre>` : '<p class="hint">아직 Git 게시 계획을 읽지 않았습니다. 본문을 승인한 뒤 정확한 저장소·브랜치·파일·효과를 확인하세요.</p>';
  $('#blog-git-consent').checked = Boolean(plan && value.gitConsent === plan.planHash);
  controls();
}

function renderAccount() {
  const current = account();
  $('#blog-account-panel').hidden = !current;
  $('#blog-empty').hidden = Boolean(current);
  if (!current) { controls(); return; }
  const view = buffer();
  $('#blog-account-panel').setAttribute('aria-labelledby', `blog-tab-${current.id}`);
  $('#blog-account-name').textContent = current.label || current.accountId || current.id;
  $('#blog-account-version').textContent = `${current.platform || ''} · ${current.accountId || current.id} · 계정 버전 ${current.version}`;
  $('#blog-connection-status').textContent = current.connection?.status || '미확인';
  $('#blog-connection-detail').textContent = current.connection?.detail || '실제 계정 연결은 아직 확인되지 않았습니다. 원본 설정과 해당 계정의 로그인 증거를 확인하세요.';
  $('#blog-account-links').innerHTML = [['공개 블로그', current.publicUrl], ['글쓰기 화면', current.editorUrl]].map(([label, url]) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<span class="hint">${label} URL 미확인 · 계정 규칙에서 확인한 주소를 저장하세요.</span>`).join('');
  for (const [key, value] of Object.entries(view.config)) $(`#blog-${key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())}`).value = value;
  const menus = current.menus || [];
  const cursor = Number.isInteger(current.menuCursor) && current.menuCursor >= 0 ? current.menuCursor : null;
  $('#blog-menu-rotation').textContent = current.nextMenu ? `다음 메뉴: ${current.nextMenu.name} · 카테고리 ${current.nextMenu.categoryNo}${cursor !== null && menus.length ? ` · ${cursor + 1}/${menus.length}` : ''}. 공개 게시 확인 후에만 다음 메뉴로 이동합니다.` : '다음 게시 메뉴를 확인하지 못했습니다. 최신 원본의 순환 상태와 숫자 카테고리 ID를 확인하세요. 메뉴 이름만으로 카테고리를 추측하지 않습니다.';
  if (current.latestRecord) $('#blog-menu-rotation').textContent += ` 최근 원본 기록: ${current.latestRecord.date || '날짜 미확인'} · ${current.latestRecord.status || '상태 미확인'} (현재 로그인 증거 아님).`;
  $('#blog-query').value = view.query;
  $('#blog-reference-profile').value = view.referenceInput.profileUrl;
  $('#blog-reference-posts').value = view.referenceInput.postUrls;
  const agentOptions = Object.entries(roleNames).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  $('#blog-agent').innerHTML = agentOptions;
  $('#blog-agent').value = view.agent;
  $('#blog-schedule-agent').innerHTML = agentOptions;
  const savedSchedule = state.schedules.find((item) => item.accountId === activeId);
  if (!view.schedule || !view.scheduleDirty) view.schedule = { cron: savedSchedule?.cron || '', timezone: 'Asia/Seoul', enabled: savedSchedule?.enabled === true, agent: savedSchedule?.agent || 'jeopi', accountVersion: current.version };
  $('#blog-cron').value = view.schedule.cron;
  $('#blog-schedule-agent').value = view.schedule.agent;
  $('#blog-schedule-enabled').checked = view.schedule.enabled;
  $('#blog-schedule-state').textContent = savedSchedule ? `저장된 설정: ${savedSchedule.enabled ? '활성' : '비활성'} · 초안 전용 · v${savedSchedule.version}. 실행기 연결과 실행 증거는 별도 확인합니다.` : '저장된 예약 없음 · 기본 비활성';
  renderSources(); renderRoles(); renderReferences(); renderResearch(); renderRuns(); renderEditor();
  notify(view.notice || '탭 이동은 저장하지 않습니다. 수정 후 저장 버튼을 사용하세요.', view.error);
}

function renderTabs() {
  const accounts = [...state.accounts].sort((a, b) => accountOrder.indexOf(a.id) - accountOrder.indexOf(b.id));
  $('#blog-account-tabs').innerHTML = accounts.map((item) => `<button type="button" role="tab" id="blog-tab-${escapeHtml(item.id)}" data-account-id="${escapeHtml(item.id)}" aria-controls="blog-account-panel" aria-selected="${item.id === activeId}" tabindex="${item.id === activeId ? '0' : '-1'}"><strong>${escapeHtml(item.accountId || item.label || item.id)}</strong><small>${escapeHtml(item.platform || '')}</small></button>`).join('');
}

function metadataSatisfied(message, id = activeId) {
  const current = account(id);
  return (current?.metadataRequirements || []).some(({ field, detail }) => ['persona', 'menus'].includes(field) && (current.overrides || []).includes(field) && current[field]?.length && message === `${id}: ${detail}`);
}

function sourceReady(id = activeId) {
  const problems = [...(state.workspace.blockedReasons || []), ...(state.workspace.sourceConflicts || [])];
  const relevant = problems.filter((message) => (!accountOrder.some((other) => message.startsWith(`${other}:`)) || message.startsWith(`${id}:`)) && !metadataSatisfied(message, id));
  return relevant.length === 0 && (state.workspace.latest === true || problems.length > 0);
}

function approvalValid() {
  if (!activeId) return false;
  const view = buffer(), value = editor(view), saved = draft(view.selectedDraft), approval = value.approval;
  const recorded = approval && state.approvals.find((item) => item.id === approval.id);
  if (approval?.formatReviewed !== true || recorded?.formatReviewed !== true || approval.referenceId !== saved?.referenceId || approval.referenceFingerprint !== saved?.referenceFingerprint) return false;
  return Boolean(saved && approval && draftReferenceCurrent(saved) && !view.referenceDirty && recorded?.status === 'active' && recorded.version === approval.version && sourceReady() && saved.accountVersion === account().version && saved.workspaceVersion === state.workspace.version && !value.approvalBlocked && !view.configDirty && !value.dirty && !view.conflict && value.preview?.confirmed && value.preview.formatConfirmed && value.preview.planSignature === JSON.stringify(saved.appliedFormattingPlan, null, 2) && value.preview.referenceFingerprint === saved.referenceFingerprint && value.preview.signature === contentSignature(value) && approval.status === 'active' && approval.draftId === saved.id && approval.draftVersion === saved.version && approval.accountVersion === account().version && approval.workspaceVersion === state.workspace.version);
}

function gitPlanCurrent() {
  const value = editor(), binding = value.gitPlan, plan = binding?.plan;
  return Boolean(approvalValid() && plan?.planHash && plan.repository && plan.branch && plan.artifactSha256 && Array.isArray(plan.files) && plan.files.length && binding.draftVersion === value.version && binding.accountVersion === account().version && binding.signature === contentSignature(value) && plan.workspaceVersion === state.workspace.version);
}

function gitConsentValid() {
  return activeId !== 'github-jellyggumi' || (gitPlanCurrent() && editor().gitConsent === editor().gitPlan.plan.planHash);
}

function controls() {
  const view = activeId && buffers.has(activeId) ? buffer() : null;
  const value = view ? editor(view) : null;
  const canWrite = Boolean(session.authenticated && view && !view.pending && !loading && !refreshPending);
  for (const node of document.querySelectorAll('#blog-account-panel button, #blog-account-panel input, #blog-account-panel select, #blog-account-panel textarea')) node.disabled = !canWrite;
  $('#blog-refresh').disabled = !session.authenticated || loading || refreshPending || [...buffers.values()].some((item) => item.pending);
  $('#blog-retry').disabled = loading || refreshPending;
  if (!view) return;
  const canInspect = Boolean(session.authenticated && !view.pending && !loading && !refreshPending);
  $('#blog-draft-select').disabled = !canInspect;
  $('#blog-preview-button').disabled = !canInspect;
  for (const node of [$('#blog-title'), $('#blog-body')]) { node.disabled = !session.authenticated; node.readOnly = !canWrite; }
  const saved = draft(view.selectedDraft);
  const clean = saved && draftReferenceCurrent(saved) && !view.referenceDirty && sourceReady() && saved.accountVersion === account().version && saved.workspaceVersion === state.workspace.version && !value.dirty && !view.configDirty && !view.conflict && same(contentOf(saved), contentOf(value)) && value.version === saved.version;
  const previewCurrent = clean && value.preview?.signature === contentSignature(value) && value.preview.accountVersion === account().version && value.preview.workspaceVersion === state.workspace.version && value.preview.referenceFingerprint === saved.referenceFingerprint && value.preview.planSignature === JSON.stringify(saved.appliedFormattingPlan, null, 2);
  $('#blog-approve-check').disabled = !canWrite || !previewCurrent;
  $('#blog-format-check').disabled = !canWrite || !previewCurrent;
  $('#blog-approve-button').disabled = !canWrite || !previewCurrent || !value.preview?.confirmed || !value.preview?.formatConfirmed;
  $('#blog-git-plan-button').disabled = !canWrite || !approvalValid();
  $('#blog-git-consent').disabled = !canWrite || !gitPlanCurrent();
  $('#blog-deploy-button').disabled = !canWrite || !approvalValid() || !gitConsentValid();
  $('#blog-platform-login').disabled = !canWrite || view.configDirty || view.conflict;
  $('#blog-create-draft').disabled = !canWrite || view.configDirty || view.referenceDirty || view.conflict || !currentReference();
  $('#blog-analyze-reference').disabled = !canWrite || view.configDirty || view.conflict;
  $('#blog-research-form button').disabled = !canWrite || view.configDirty || view.conflict;
  $('#blog-approve-check').checked = Boolean(value.preview?.confirmed);
  $('#blog-format-check').checked = Boolean(value.preview?.formatConfirmed);
  $('#blog-git-consent').checked = activeId === 'github-jellyggumi' && gitConsentValid();
  $('#blog-config-state').textContent = view.configDirty ? `미저장 · 편집 시작 버전 ${view.configVersion}` : '저장된 규칙';
  $('#blog-draft-state').textContent = value.dirty ? '미저장 편집 있음' : saved ? '저장된 초안' : '수동 작성 가능';
  $('#blog-dirty-state').textContent = view.pending ? '요청 처리 중…' : view.conflict ? '버전 충돌 · 편집 보존됨' : view.configDirty || view.referenceDirty || view.scheduleDirty || [...view.editors.values()].some((item) => item.dirty) ? '이 계정에 미저장 변경 있음' : '저장 상태';
  $('#blog-approval-state').textContent = approvalValid() ? `유효한 승인 ${value.approval.id} · 초안 v${saved.version} · 레퍼런스 ${saved.referenceId}. 배포는 별도 실행입니다.` : !currentReference() || view.referenceDirty ? '같은 주제·공개 1만+ Naver 팬/이웃과 분야·대표글 측정 근거를 갖춘 현재 레퍼런스 분석을 먼저 완료하세요. 수동 메모 저장은 가능하지만 승인·배포는 불가합니다.' : saved && !draftReferenceCurrent(saved) ? '초안에 현재 레퍼런스 구조 계획을 명시적으로 다시 저장한 뒤 전체 본문을 재검토하세요.' : saved && (saved.accountVersion !== account().version || saved.workspaceVersion !== state.workspace.version) ? '초안이 이전 계정·원본 버전을 참조합니다. 본문을 확인하고 명시적으로 다시 저장한 뒤 재검토하세요.' : !sourceReady() ? '이 계정의 최신 원본을 확인하지 못해 승인·배포가 차단되었습니다. 원본 충돌과 누락 근거를 확인하세요.' : '유효한 승인 없음 · 저장된 전체 본문을 다시 검토하고 승인하세요.';
  $('#blog-account-panel').setAttribute('aria-busy', String(view.pending));
}

async function perform(id, message, action) {
  const view = buffer(id);
  if (view.pending || loading || refreshPending) return;
  if (!session.authenticated) { notify('로그인 후 실행할 수 있습니다.', true, id); return; }
  view.pending = true; controls(); notify(message, false, id);
  try { await action(view); view.conflict = false; }
  catch (error) {
    if (error.status === 409) {
      view.conflict = true; invalidate(view);
    }
    if (error.status !== 401) {
      try { await loadState(); } catch { /* Preserve local edits and the original error when state recovery is unavailable. */ }
    }
    notify(`${error.status === 409 ? '버전 충돌 (409). 현재 편집은 보존했습니다. 최신 원본·실행 기록을 확인하고, 편집 내용을 복사해 새 수동 초안으로 저장하거나 최신 초안을 선택해 비교하세요. ' : ''}${error.message}`, true, id);
  } finally {
    view.pending = false;
    if (activeId === id) { renderTabs(); renderAccount(); }
    else controls();
  }
}

$('#blog-account-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-account-id]');
  if (!tab) return;
  capture(); activeId = tab.dataset.accountId; renderTabs(); renderAccount();
  document.getElementById(`blog-tab-${activeId}`)?.focus();
});
$('#blog-account-tabs').addEventListener('keydown', (event) => {
  const tabs = [...$('#blog-account-tabs').querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
  if (next >= 0) { event.preventDefault(); tabs[next].click(); }
});

$('#blog-config-form').addEventListener('input', () => {
  const view = buffer();
  view.config = { persona: $('#blog-persona').value, keywords: $('#blog-keywords').value, menus: $('#blog-menus').value, publicUrl: $('#blog-public-url').value, editorUrl: $('#blog-editor-url').value };
  view.configDirty = !same(view.config, configOf(account()));
  invalidate(view); controls();
});
$('#blog-config-form').addEventListener('submit', (event) => {
  event.preventDefault(); const id = activeId;
  perform(id, '계정 규칙을 저장하는 중입니다…', async (view) => {
    const payload = { ...view.config, expectedVersion: view.configVersion, keywords: lines(view.config.keywords), menus: lines(view.config.menus) };
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
    upsert('accounts', result.account); view.configDirty = false; view.config = configOf(result.account); view.configVersion = result.account.version;
    view.brief = latestBrief(id);
    for (const reference of state.references) if (reference.accountId === id) reference.current = false;
    await loadState();
    invalidate(view); notify('계정 규칙을 저장했습니다. 기존 승인은 무효이며 전체 본문 재검토가 필요합니다.', false, id);
  });
});
$('#blog-reference-form').addEventListener('input', () => {
  const view = buffer(); view.referenceInput = { profileUrl: $('#blog-reference-profile').value, postUrls: $('#blog-reference-posts').value }; view.referenceDirty = true; invalidate(view); controls();
});
$('#blog-reference-form').addEventListener('submit', (event) => {
  event.preventDefault(); const id = activeId, version = account().version;
  perform(id, '공개 인원 지표·주제·작성자 관계와 대표 글의 실제 구조를 검사하는 중입니다…', async (view) => {
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}/references`, { method: 'POST', body: { expectedVersion: version, profileUrl: view.referenceInput.profileUrl.trim(), postUrls: lines(view.referenceInput.postUrls) } });
    upsert('references', result.reference); upsert('runs', result.run); view.referenceDirty = false; invalidate(view);
    await loadState(); notify('레퍼런스의 공개 지표와 측정 구조를 분석했습니다. 우리 페르소나에 적용할 계획을 확인하고 초안을 새로 작성하거나 명시적으로 다시 저장하세요. 원본 문장·이미지는 복사하지 않습니다.', false, id);
  });
});
$('#blog-query').addEventListener('input', () => { buffer().query = $('#blog-query').value; });
$('#blog-agent').addEventListener('change', () => { buffer().agent = $('#blog-agent').value; });
$('#blog-research-form').addEventListener('submit', (event) => {
  event.preventDefault(); capture(); const id = activeId, version = account().version;
  perform(id, '실제 키워드·뉴스 출처를 조사하는 중입니다…', async (view) => {
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}/research`, { method: 'POST', body: { expectedVersion: version, ...(view.query.trim() ? { query: view.query.trim() } : {}) } });
    view.brief = result.brief; upsert('briefs', result.brief); upsert('runs', result.run); notify('리서치를 불러왔습니다. 출처와 원문을 확인하세요.', false, id);
  });
});
$('#blog-create-draft').addEventListener('click', () => {
  capture(); const id = activeId, version = account().version;
  const current = editor();
  if (current.dirty && !window.confirm('현재 미저장 편집은 계정의 초안 목록에 보존됩니다. 새 에이전트 초안을 여시겠습니까?')) return;
  perform(id, 'Jev API 라우팅 후 실제 에이전트 초안을 요청하는 중입니다…', async (view) => {
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}/drafts`, { method: 'POST', body: { expectedVersion: version, agent: view.agent, ...currentBrief(id, view), ...referenceFor(id) } });
    upsert('drafts', result.draft); upsert('runs', result.run); view.selectedDraft = result.draft.id; editor(view);
    notify('에이전트 초안을 저장했습니다. 본문과 출처 검토 후 소유자가 승인하세요.', false, id);
    await loadState();
  });
});
$('#blog-draft-select').addEventListener('change', () => {
  const view = buffer(); view.selectedDraft = $('#blog-draft-select').value; view.conflict = false; renderEditor();
});
for (const selector of ['#blog-title', '#blog-body']) $(selector).addEventListener('input', () => {
  const view = buffer(), value = editor(view);
  value.title = $('#blog-title').value; value.body = $('#blog-body').value; value.revision++;
  value.dirty = !same(contentOf(value), contentOf(draft(view.selectedDraft)));
  invalidate(view); controls();
});
$('#blog-draft-form').addEventListener('submit', (event) => {
  event.preventDefault(); const id = activeId, view = buffer(), selected = view.selectedDraft, value = editor(view), revision = value.revision;
  const payload = { ...contentOf(value), expectedVersion: selected ? value.version : account().version, ...referenceFor(id), ...(selected ? {} : { agent: view.agent, ...currentBrief(id, view) }) };
  perform(id, '초안을 저장하는 중입니다…', async (target) => {
    const result = await api(selected ? `/api/blog/drafts/${encodeURIComponent(selected)}` : `/api/blog/accounts/${encodeURIComponent(id)}/drafts`, { method: selected ? 'PUT' : 'POST', body: payload });
    upsert('drafts', result.draft); upsert('runs', result.run);
    value.version = result.draft.version;
    if (value.revision === revision) { Object.assign(value, contentOf(result.draft)); value.dirty = false; }
    if (!selected) { target.editors.delete(''); target.editors.set(result.draft.id, value); target.selectedDraft = result.draft.id; }
    invalidate(target); notify('초안을 저장했습니다. 전체 본문을 열어 검토한 뒤 별도 승인하세요.', false, id);
  });
});
$('#blog-preview-button').addEventListener('click', () => {
  const view = buffer(), value = editor(view);
  if (!value.title.trim() || !value.body.trim()) { notify('제목과 전체 본문을 입력하세요.', true); return; }
  const saved = draft(view.selectedDraft);
  value.preview = { signature: contentSignature(value), planSignature: JSON.stringify(saved?.appliedFormattingPlan, null, 2) || '현재 레퍼런스의 적용 구조 계획 없음 · 수동 메모는 최종 승인할 수 없습니다.', referenceFingerprint: saved?.referenceFingerprint, accountVersion: account().version, workspaceVersion: state.workspace.version, confirmed: false, formatConfirmed: false, label: `${account().accountId || account().label} · ${view.selectedDraft ? `초안 v${value.version}` : '미저장 초안'} · 레퍼런스 ${saved?.referenceId || '없음'} · ${state.workspace.version || '원본 미확인'}` };
  renderEditor(); $('#blog-preview').focus();
});
$('#blog-approve-check').addEventListener('change', () => {
  const value = editor(); if (value.preview) value.preview.confirmed = $('#blog-approve-check').checked; controls();
});
$('#blog-format-check').addEventListener('change', () => {
  const value = editor(); if (value.preview) value.preview.formatConfirmed = $('#blog-format-check').checked; controls();
});
$('#blog-approve-button').addEventListener('click', () => {
  const id = activeId, view = buffer(), value = editor(view), draftId = view.selectedDraft;
  if ($('#blog-approve-button').disabled || !draftId || !value.preview?.confirmed || !value.preview.formatConfirmed) return;
  perform(id, '검토한 정확한 본문 버전의 승인을 기록하는 중입니다…', async () => {
    const result = await api(`/api/blog/drafts/${encodeURIComponent(draftId)}/approval`, { method: 'POST', body: { expectedVersion: value.version, approved: true, formatReviewed: value.preview.formatConfirmed === true } });
    value.approval = result.approval; value.approvalBlocked = false; upsert('approvals', result.approval);
    notify('정확한 버전을 승인했습니다. 아직 게시하지 않았습니다. 배포 버튼은 별도입니다.', false, id);
  });
});
$('#blog-git-plan-button').addEventListener('click', () => {
  if (!approvalValid() || activeId !== 'github-jellyggumi') return;
  const id = activeId, view = buffer(), value = editor(view), draftId = view.selectedDraft;
  perform(id, '승인 초안과 일치하는 실제 Git 게시 계획을 읽는 중입니다. commit·push는 실행하지 않습니다…', async () => {
    const result = await api(`/api/blog/drafts/${encodeURIComponent(draftId)}/deploy-plan`, { method: 'POST', body: { expectedVersion: value.version } });
    value.gitPlan = { plan: result.plan, draftVersion: value.version, accountVersion: account(id).version, signature: contentSignature(value) };
    value.gitConsent = null;
    notify('정확한 Git 게시 계획을 읽었습니다. 저장소·브랜치·파일·효과를 검토하고 Git 권한을 별도로 선택하세요. 아직 commit·push하지 않았습니다.', false, id);
  });
});
$('#blog-git-consent').addEventListener('change', () => {
  const value = editor(); value.gitConsent = $('#blog-git-consent').checked && gitPlanCurrent() ? value.gitPlan.plan.planHash : null; controls();
});
$('#blog-deploy-button').addEventListener('click', () => {
  if (!approvalValid() || !gitConsentValid()) return;
  const id = activeId, view = buffer(), value = editor(view), draftId = view.selectedDraft;
  const gitConsent = id === 'github-jellyggumi' ? { approved: true, planHash: value.gitConsent } : undefined;
  const gitEffects = gitConsent ? ` Git 저장소 ${value.gitPlan.plan.repository}, 브랜치 ${value.gitPlan.plan.branch}, 파일 ${value.gitPlan.plan.files.join(', ')}에 commit·push를 실행합니다.` : '';
  if (!window.confirm(`${account().accountId || account().label} 계정으로 승인된 초안 v${value.version}을 실제 공개 배포합니다.${gitEffects} 진행하시겠습니까?`)) return;
  perform(id, '검증된 게시 스크립트로 승인 버전을 배포하는 중입니다. 중복 실행하지 마세요…', async () => {
    const approvalId = value.approval.id;
    value.approval = null; value.approvalBlocked = true;
    let result;
    try { result = await api(`/api/blog/drafts/${encodeURIComponent(draftId)}/deploy`, { method: 'POST', body: { expectedVersion: value.version, approvalId, ...(gitConsent ? { gitConsent } : {}) } }); }
    catch (error) { error.message += ' 배포를 자동 재시도하지 않습니다. 결과가 불명확하면 공개 페이지와 실행 기록을 먼저 확인하세요.'; throw error; }
    upsert('drafts', result.draft); upsert('runs', result.run);
    notify(`배포 실행 상태: ${result.run?.status || result.draft?.status || '확인 필요'}. 실제 게시 결과와 실행 영수증을 확인하세요.`, false, id);
    await loadState();
  });
});
$('#blog-platform-login').addEventListener('click', () => {
  const id = activeId, version = account().version;
  if (!window.confirm(`${account().accountId || account().label} 전용 브라우저 프로필의 현재 계정과 작업 탭을 검증합니다. 자동 로그인·계정 전환은 하지 않습니다. 해당 프로필에서 직접 로그인·MFA를 완료했습니까?`)) return;
  perform(id, '전용 프로필의 현재 계정과 작업 탭을 MyInfo 스크립트로 검증하는 중입니다…', async () => {
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}/login`, { method: 'POST', body: { expectedVersion: version } });
    upsert('runs', result.run); await loadState(); notify(`로그인 검증 상태: ${result.run?.status || '확인 필요'}. 현재 계정·작업 탭의 실제 검증 근거를 확인하세요. 자동 로그인은 하지 않았습니다.`, false, id);
  });
});
$('#blog-schedule-form').addEventListener('input', () => {
  const view = buffer(); view.schedule = { ...view.schedule, cron: $('#blog-cron').value, enabled: $('#blog-schedule-enabled').checked, agent: $('#blog-schedule-agent').value }; view.scheduleDirty = true; controls();
});
$('#blog-schedule-form').addEventListener('submit', (event) => {
  event.preventDefault(); const id = activeId, view = buffer();
  const payload = { expectedVersion: view.schedule.accountVersion, cron: view.schedule.cron, timezone: 'Asia/Seoul', enabled: view.schedule.enabled, agent: view.schedule.agent };
  perform(id, '초안 전용 예약 설정을 저장하는 중입니다…', async (target) => {
    const result = await api(`/api/blog/accounts/${encodeURIComponent(id)}/schedule`, { method: 'PUT', body: payload });
    upsert('schedules', result.schedule); target.scheduleDirty = false; target.schedule = null; invalidate(target);
    await loadState(); notify('초안 전용 예약 설정을 저장했습니다. 공개 게시 권한이나 OS 스케줄러 설치는 포함하지 않습니다.', false, id);
  });
});

async function reload(latest = false) {
  if (loading || refreshPending || [...buffers.values()].some((item) => item.pending)) return;
  capture(); loading = true; refreshPending = latest; controls();
  const requestedId = activeId;
  try {
    if (latest) await api('/api/blog/refresh', { method: 'POST', body: {} });
    await loadState(); renderTabs(); renderAccount();
    notify(latest ? '최신 원본을 다시 읽었습니다. 미저장 편집은 보존했으며 변경된 원본의 승인은 다시 필요합니다.' : '실제 상태를 다시 읽었습니다. 미저장 편집은 덮어쓰지 않았습니다.', false, requestedId || activeId);
  } catch (error) {
    $('#blog-empty').hidden = Boolean(activeId);
    notify(`${error.message}${error.status === 401 ? ' 스튜디오 접근 토큰으로 인증하세요.' : ' 서버 연결과 원본 경로 설정을 확인한 뒤 다시 시도하세요.'}`, true, requestedId);
  } finally { loading = false; refreshPending = false; controls(); }
}
$('#blog-retry').addEventListener('click', () => reload());
$('#blog-refresh').addEventListener('click', () => reload(true));
$('#blog-login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const token = $('#blog-token').value; $('#blog-token').value = ''; $('#blog-login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { token } });
    await reload();
  } catch (error) { $('#blog-login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
window.addEventListener('beforeunload', (event) => {
  if ([...buffers.values()].some((view) => view.configDirty || view.referenceDirty || view.scheduleDirty || view.pending || [...view.editors.values()].some((value) => value.dirty))) { event.preventDefault(); event.returnValue = ''; }
});
await reload();
