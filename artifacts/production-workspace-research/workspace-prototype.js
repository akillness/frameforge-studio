(() => {
  'use strict';

  // Throwaway, dependency-free design artifact. No storage, app imports or execution paths.
  const scenes = [
    { id: 'hook', title: '훅', note: '세 뉴스를 여는 도입', number: '01' },
    { id: 'news-1', title: '뉴스 1', note: '첫 번째 뉴스 슬롯 · 기사 미선정', number: '02' },
    { id: 'news-2', title: '뉴스 2', note: '두 번째 뉴스 슬롯 · 기사 미선정', number: '03' },
    { id: 'news-3', title: '뉴스 3', note: '세 번째 뉴스 슬롯 · 기사 미선정', number: '04' },
    { id: 'closing', title: '마무리', note: '세 뉴스를 닫는 마무리', number: '05' }
  ];
  const nodes = [
    { id: 'topic', role: 'trend', title: '키워드', detail: 'AI 뉴스라는 주제만 정해졌습니다. 실제 키워드 조사나 최신 뉴스 수집은 실행하지 않습니다.', input: '확인해봄 · AI 뉴스 · 45초 Shorts', result: '검색 키워드 및 조사 결과 없음' },
    ...[1, 2, 3].map(number => ({ id: `source-${number}`, role: 'news', title: `뉴스 ${number} 소스`, scene: `news-${number}`, detail: '실제 뉴스 소스와 재사용 가능한 원본 영상을 먼저 확인합니다. 공개된 URL은 사용 허가가 아닙니다. 적절한 영상이 없으면 기사는 유지하고 권리 확인된 이미지 카드, 없으면 원본 텍스트 카드를 사용합니다.', input: `뉴스 ${number} 슬롯 · 실제 기사 미선정`, result: '기사·영상·이미지 및 이용 권리 증거 없음' })),
    { id: 'evidence', role: 'research', title: '근거 확인', detail: '실제 소스와 사실 근거, 영상의 진정성, 이용 권리, 편집 적합성을 서로 구분해 확인합니다. 기사 썸네일·og:image도 독립적인 권리 확인이 필요합니다.', input: '뉴스 1·2·3 소스', result: '검증된 근거·소스 기록 없음' },
    { id: 'script', role: 'script', title: '시나리오', detail: '45초 전체 안에 훅, 뉴스 세 항목, 마무리를 구성합니다. 실제 뉴스 문안이나 개별 장면 길이는 아직 정하지 않았습니다.', input: '확인된 뉴스와 소스 근거', result: '훅 / 뉴스 1 / 뉴스 2 / 뉴스 3 / 마무리 구조만 합의' },
    { id: 'storyboard', role: 'storyboard', title: '스토리보드', detail: '다섯 장면과 각 소스를 한 영상 문맥에서 연결합니다. 이 후보에서는 장면 선택과 미리보기만 동기화합니다.', input: '45초 브리프 · 다섯 장면', result: '실제 장면 자산·타이밍·내레이션 없음' },
    { id: 'edit', role: 'layout', title: '편집 · 배치', detail: '원본 소스 영상과 뉴스 카드·자막을 함께 배치하는 방향입니다. 아래 모니터는 직접 작성한 타이포그래피 배치 예시이며 렌더된 영상이 아닙니다.', input: '장면 · 소스 · 채널 스타일', result: '레이아웃 예시만 있음 · 실제 편집/렌더 없음' },
    ...[1, 2, 3].map(number => ({ id: `generation-${number}`, role: 'generate', title: `뉴스 ${number} 선택 생성`, scene: `news-${number}`, optional: true, detail: '장면별 선택 가능한 보조 생성 노드입니다. 원본 영상 부재가 자동 생성의 동의는 아니며, 실제 사건의 증거를 만들지 않습니다. 실제 사용 시 정확한 입력·비용 동의와 장면별 작업/멱등성 ID가 필요합니다.', input: `뉴스 ${number} 장면 · 생성 여부 미결정`, result: '생성 미실행 · 비용/작업/결과 없음' })),
    { id: 'render', role: 'render', title: '최종 출력', detail: '전체 장면을 하나의 정확한 출력 후보로 묶습니다. 브라우저 배치 미리보기와 실제 렌더 결과는 다릅니다.', input: '선택된 장면 자산·구간·레이아웃', result: '렌더 작업·파일·해시 없음' },
    { id: 'review', role: 'review', title: '최종 검토', detail: '장면마다 게시 승인하지 않고 전체 후보를 검토합니다. 자산·권리·대상 채널·시청 대상·AI 공개 결정과 정확한 출력을 함께 바인딩해야 합니다.', input: '정확한 출력 및 전체 게시 명세', result: '검토 증거·승인 기록 없음' },
    { id: 'publish', role: 'publish', title: '공개 게시', detail: '새 공식 OAuth/API 구현이 필요합니다. 비공개 업로드 후 동일 영상의 정확한 채널·명세·처리를 읽기 확인하고 공개 변경 뒤 다시 확인해야 합니다. Studio 자동화는 사용하지 않습니다.', input: '한 번의 전체 후보 최종 승인', result: 'OAuth/API 미연결 · 업로드/공개 실행 불가' }
  ];
  const candidates = {
    A: { title: '편집 중심', description: '소스 빈 → 프로그램 모니터 → 타임라인. 전체 제작 경로는 상단에 유지합니다.' },
    B: { title: '노드 캔버스 중심', description: '반복 역할과 장면별 선택 생성을 먼저 읽고, 선택한 입력·결과를 옆에서 확인합니다.' },
    C: { title: '스토리보드 중심', description: '다섯 장면의 이야기·소스 결정을 먼저 읽고, 전체 제작 경로를 곁에 둡니다.' }
  };
  const initialUrl = new URL(window.location.href);
  const state = { variant: Object.hasOwn(candidates, initialUrl.searchParams.get('variant')) ? initialUrl.searchParams.get('variant') : 'A', scene: 'news-1', node: 'source-1' };
  const candidate = document.getElementById('candidate');
  const dialog = document.getElementById('approval-dialog');
  const announcement = document.getElementById('announcement');
  let reviewOpener = null;

  const sceneButton = (scene, kind = 'bin-scene') => `<button type="button" class="${kind}${state.scene === scene.id ? ' selected' : ''}" data-scene="${scene.id}" aria-pressed="${state.scene === scene.id}"><span class="scene-number">${scene.number}</span><span class="scene-button-copy"><strong>${scene.title}</strong><small>${scene.note}</small></span><span class="scene-state">미첨부</span></button>`;
  const nodeButton = (node, kind = 'node') => `<button type="button" class="${kind}${state.node === node.id ? ' selected' : ''}${node.optional ? ' optional' : ''}" data-node="${node.id}" aria-pressed="${state.node === node.id}"><span class="node-role">${node.role}<span>${node.optional ? '선택' : '설계'}</span></span><strong>${node.title}</strong><small>${node.id}</small></button>`;
  const panelHeading = (label, subtitle) => `<div class="panel-heading"><h3>${label}</h3><span>${subtitle}</span></div>`;

  function workflowStrip(kind = 'workflow-strip') {
    const groups = [
      { label: '키워드', ids: ['topic'] }, { label: '소스', ids: ['source-1', 'source-2', 'source-3', 'evidence'] },
      { label: '구성', ids: ['script', 'storyboard'] }, { label: '편집', ids: ['edit', 'generation-1', 'generation-2', 'generation-3'] },
      { label: '검토', ids: ['render', 'review'] }, { label: '게시', ids: ['publish'] }
    ];
    return `<section class="panel workflow-panel">${panelHeading('전체 제작 경로', '프로젝트 전용 워크플로 · 실행 상태 아님')}<div class="${kind}">${groups.map((group, index) => `<div class="stage-group"><h4><span>${String(index + 1).padStart(2, '0')}</span>${group.label}</h4><div>${group.ids.map(id => nodeButton(nodes.find(node => node.id === id), 'stage-node')).join('')}</div></div>`).join('')}</div><p class="panel-note">같은 역할도 고유 ID로 구분합니다. 점선 generate는 장면별 선택 보조이며 자동 실행·필수 단계가 아닙니다.</p></section>`;
  }

  function monitor() {
    const scene = scenes.find(item => item.id === state.scene);
    return `<section class="panel monitor">${panelHeading('프로그램 모니터', '9:16 · 정지 배치 예시')}<div class="monitor-stage"><div class="monitor-caption">SELF-AUTHORED LAYOUT EXAMPLE</div><div class="news-layout"><div class="card-brand">확인해봄<span>AI NEWS</span></div><div class="card-middle"><span class="card-index">${scene.number} / 05</span><div class="card-rule"></div><strong>${scene.title}</strong><p>실제 뉴스가 아닌<br>뉴스 카드 배치 예시</p><div class="card-policy">원본 영상 우선<br>권리 확인 이미지 또는<br>직접 작성한 텍스트 카드</div></div><div class="card-bottom"><span>뉴스 문안·미디어 없음</span><span>LAYOUT ONLY</span></div></div></div><div class="monitor-footer"><strong>${scene.title}</strong><span>영상 재생·렌더 결과 아님</span></div></section>`;
  }

  function inspector() {
    const node = nodes.find(item => item.id === state.node);
    const scene = scenes.find(item => item.id === state.scene);
    return `<section class="panel inspector">${panelHeading('선택 항목', '노드 / 장면')}<div class="inspector-body"><span class="eyebrow">SELECTED NODE</span><h3>${node.title}</h3><div class="identity"><code>${node.id}</code><span class="badge">${node.role}${node.optional ? ' · 선택' : ''}</span></div><p>${node.detail}</p><dl class="inspector-fields"><div><dt>입력 문맥</dt><dd>${node.input}</dd></div><div><dt>결과 / 증거</dt><dd>${node.result}</dd></div><div><dt>선택 장면</dt><dd>${scene.number} · ${scene.title}<small>장면 타이밍 미배정 · 전체 브리프 45초</small></dd></div></dl><details class="policy-details"><summary>소스·권리 확인 기준</summary><p>소스 URL, 라이선스 증거, 출처 표기, 취득 시각, 파일 해시와 영상 사용 구간을 기록해야 합니다. 현재 어느 자료도 첨부·검증되지 않았습니다.</p><p>이미지도 독립적으로 권리를 확인합니다. 허가된 이미지가 없으면 직접 작성한 텍스트 카드. 생성물은 실제 사건의 증거가 아닙니다.</p></details><button type="button" class="review-trigger inspector-review">최종 승인 항목 보기</button></div></section>`;
  }

  function bin() {
    return `<section class="panel source-bin">${panelHeading('소스 / 장면 빈', '프로젝트 안에서 유지')}<div class="bin-context"><span class="eyebrow">KEYWORD</span><strong>AI 뉴스</strong><span>실제 조사·기사 선택 전</span></div><div class="bin-scenes">${scenes.map(scene => sceneButton(scene)).join('')}</div><div class="source-policy"><strong>소스 선택 원칙</strong><ol><li>재사용 허가된 실제 영상</li><li>권리 확인된 이미지 카드</li><li>직접 작성한 텍스트 카드</li></ol><p>영상이 없어도 기사는 유지.<br>실제 자산·권리 기록 없음.</p></div></section>`;
  }

  function timeline() {
    return `<section class="panel timeline">${panelHeading('장면 순서 / 타임라인', '45초 목표 · 장면별 길이 미정')}<div class="timeline-content"><div class="timeline-ruler"><span>시작</span><span>구조만 합의 · 시간 비례 아님</span><span>45초 목표</span></div><div class="timeline-scenes">${scenes.map(scene => sceneButton(scene, 'timeline-scene')).join('')}</div><p>장면 순서 탐색만 가능합니다. 독립 영상·오디오 트랙, 파형, 프레임 단위 편집을 나타내지 않습니다.</p></div></section>`;
  }

  function graph() {
    const row = (label, ids, rowClass = '') => `<div class="graph-row ${rowClass}"><span class="graph-row-label">${label}</span><div class="graph-nodes">${ids.map(id => nodeButton(nodes.find(node => node.id === id))).join('')}</div></div>`;
    return `<section class="panel node-canvas">${panelHeading('프로젝트 워크플로 캔버스', '고유 노드 선택 · 실행/연결 편집 안 됨')}<div class="graph-surface"><p class="graph-key"><span class="connector-sample" aria-hidden="true"></span>제안된 입력 흐름 <span class="optional-key">점선 = 선택 보조</span></p>${row('01 · 주제', ['topic'])}${row('02 · 반복 소스 역할', ['source-1', 'source-2', 'source-3'], 'branch-row')}${row('03 · 근거 → 구성 → 편집', ['evidence', 'script', 'storyboard', 'edit'])}<div class="branch-note">각 뉴스 장면의 선택 경로 · 미사용 시 직접 최종 출력으로</div>${row('04 · 장면별 선택 생성', ['generation-1', 'generation-2', 'generation-3'], 'branch-row optional-row')}${row('05 · 하나의 후보 → 최종 승인 → 공개', ['render', 'review', 'publish'])}</div><p class="panel-note">역할은 반복 가능하도록 설계했습니다. 실제 엔진의 반복 역할 지원·그래프 실행 구현을 뜻하지 않습니다.</p></section>`;
  }

  function storyboard() {
    return `<section class="panel storyboard">${panelHeading('스토리보드', '5개 장면 · 전체 45초 브리프')}<div class="storyboard-columns" aria-hidden="true"><span>장면 / 이야기</span><span>소스와 대체 경로</span></div><div class="storyboard-rows">${scenes.map(scene => `<button type="button" class="story-row${state.scene === scene.id ? ' selected' : ''}" data-scene="${scene.id}" aria-pressed="${state.scene === scene.id}"><span class="story-number">${scene.number}</span><span class="story-copy"><strong>${scene.title}</strong><small>${scene.note}</small><span class="story-duration">장면 길이 미정</span></span><span class="story-source"><strong>${scene.id.startsWith('news-') ? '실제 소스 영상 우선' : '구성 슬롯 · 문안 미정'}</strong><small>권리 확인 이미지 → 원본 텍스트 카드</small><span class="evidence-tag">자산·권리 증거 없음</span></span></button>`).join('')}</div><div class="storyboard-summary"><strong>이야기는 유지하고, 표현 수단을 바꿉니다.</strong><p>적절한 소스 영상이 없다는 이유로 기사를 교체하거나 생성 영상을 자동 요청하지 않습니다. 이 화면에는 실제 뉴스 사실·영상이 없습니다.</p></div></section>`;
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', state.variant);
    // Some file:// browsers disallow replaceState. Hash-free file navigation is the fallback.
    try { window.history.replaceState(null, '', url.href); }
    catch { if (window.location.href !== url.href) window.location.replace(url.href); }
  }

  function render() {
    const focusKey = document.activeElement?.dataset;
    const focusNode = focusKey?.node;
    const focusScene = focusKey?.scene;
    const focusClass = document.activeElement?.className;
    const focusInspector = candidate.contains(document.activeElement)
      ? document.activeElement.closest('.policy-details > summary, .review-trigger')
      : null;
    const info = candidates[state.variant];
    document.getElementById('candidate-letter').textContent = state.variant;
    document.getElementById('candidate-title').textContent = info.title;
    document.getElementById('candidate-description').textContent = info.description;
    candidate.className = `candidate variant-${state.variant}`;
    if (state.variant === 'A') candidate.innerHTML = `${workflowStrip()}<div class="editing-grid">${bin()}${monitor()}${inspector()}${timeline()}</div>`;
    if (state.variant === 'B') candidate.innerHTML = `<div class="canvas-grid">${graph()}<div class="canvas-side">${monitor()}${inspector()}</div></div>${timeline()}`;
    if (state.variant === 'C') candidate.innerHTML = `<div class="story-grid">${storyboard()}<div class="story-side">${monitor()}${inspector()}</div>${workflowStrip('workflow-rail')}</div>`;
    document.querySelectorAll('[data-variant]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variant === state.variant)));
    if (focusNode || focusScene) {
      const matching = [...candidate.querySelectorAll('button')].filter(button => focusNode ? button.dataset.node === focusNode : button.dataset.scene === focusScene);
      (matching.find(button => button.className.split(' ')[0] === focusClass?.split(' ')[0]) || matching[0])?.focus({ preventScroll: true });
    }
    else if (focusInspector) {
      const selector = focusInspector.matches('summary') ? '.policy-details > summary' : '.review-trigger';
      (candidate.querySelector(selector) || document.querySelector('[data-variant][aria-pressed="true"]'))?.focus({ preventScroll: true });
    }
  }

  function setVariant(variant) {
    if (!Object.hasOwn(candidates, variant)) variant = 'A';
    if (variant === state.variant) return;
    state.variant = variant;
    updateUrl();
    render();
    announcement.textContent = `${variant} · ${candidates[variant].title}. 장면과 노드 선택은 유지되었습니다.`;
  }

  function cycleVariant(direction) {
    const variants = Object.keys(candidates);
    setVariant(variants[(variants.indexOf(state.variant) + direction + variants.length) % variants.length]);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.scene) {
      state.scene = button.dataset.scene;
      render();
      announcement.textContent = `${scenes.find(scene => scene.id === state.scene).title} 장면 선택. 미리보기와 검사 패널이 갱신되었습니다.`;
    } else if (button.dataset.node) {
      state.node = button.dataset.node;
      const node = nodes.find(item => item.id === state.node);
      if (node.scene) state.scene = node.scene;
      render();
      announcement.textContent = `${node.title} 노드 선택. 입력과 결과 증거를 확인할 수 있습니다.`;
    } else if (button.dataset.variant) setVariant(button.dataset.variant);
    else if (button.id === 'previous-variant') cycleVariant(-1);
    else if (button.id === 'next-variant') cycleVariant(1);
    else if (button.classList.contains('review-trigger')) {
      reviewOpener = button;
      dialog.showModal();
      document.getElementById('close-review').focus();
    } else if (button.id === 'close-review' || button.id === 'back-to-workspace') dialog.close();
  });

  document.addEventListener('keydown', event => {
    if (dialog.open || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest('input, select, textarea') || event.target.isContentEditable) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      cycleVariant(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  dialog.addEventListener('close', () => {
    if (reviewOpener?.isConnected) reviewOpener.focus({ preventScroll: true });
    else document.querySelector('.project-heading .review-trigger').focus({ preventScroll: true });
  });
  window.addEventListener('popstate', () => {
    const value = new URL(window.location.href).searchParams.get('variant');
    state.variant = Object.hasOwn(candidates, value) ? value : 'A';
    updateUrl();
    render();
  });
  updateUrl();
  render();
})();
