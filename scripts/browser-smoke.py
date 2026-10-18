"""Optional E2E/visual verification; uses the already-installed Playwright runtime."""
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
env = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
base = os.environ.get('STUDIO_URL', 'https://desktop-qrf3t5t.taila2003e.ts.net')
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1080}, device_scale_factor=1)
    context.set_default_timeout(15000)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base, wait_until='networkidle')
    page.get_by_role('textbox', name='접근 토큰', exact=True).fill(env['LOGIN_TOKEN'])
    page.get_by_role('button', name='스튜디오 열기 →', exact=True).click()
    page.locator('[data-action="channel"]').filter(has_text='확인해봄').click()
    session_cookie = next(c for c in context.cookies() if c['name'] == 'frameforge_session')
    assert session_cookie['httpOnly'] and session_cookie['sameSite'] == 'Strict'
    assert not base.startswith('https:') or session_cookie['secure']
    caption = '출처를 확인하고\n기록을 남깁니다'
    page.get_by_role('textbox', name='화면 텍스트', exact=True).fill(caption)
    page.get_by_role('button', name='변경 저장', exact=True).click()
    expect(page.locator('#toast')).to_contain_text('새 버전으로 저장했습니다')
    state = context.request.get(base + '/api/state').json()
    assert any(e['scenes'][0]['text'] == caption for e in state['episodes'])
    page.locator('#toast').wait_for(state='hidden')
    page.screenshot(path=str(ROOT / 'docs/assets/studio-desktop.png'), full_page=True)
    page.locator('[data-action="view"][data-view="workflow"]').click()
    expect(page.locator('#workflow-canvas')).to_be_visible()
    page.get_by_role('button', name='자동 배치', exact=True).click()
    page.locator('.wf-connection-list > div').filter(has_text='트렌드 수집 → 리서치 정리').locator('button').click()
    assert '실행 가능한 연결입니다' not in page.locator('#wf-validation').inner_text()
    page.get_by_role('combobox', name='연결 출발 노드').select_option('trend')
    page.get_by_role('combobox', name='연결 도착 노드').select_option('research')
    page.get_by_role('button', name='연결 추가 →', exact=True).click()
    expect(page.locator('#wf-validation')).to_contain_text('실행 가능한 연결입니다')
    page.get_by_role('button', name='전체 보기', exact=True).click()
    header = page.locator('.wf-node-header').filter(has_text='대본 작성')
    header.click()
    expect(page.locator('#wf-agent')).to_have_value('codex')
    box = header.bounding_box()
    page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)
    page.mouse.down()
    page.mouse.move(box['x'] + box['width']/2 + 12, box['y'] + box['height']/2 + 12, steps=5)
    page.mouse.up()
    expect(page.locator('#wf-agent')).to_have_value('codex')
    page.get_by_role('button', name='워크플로우 저장', exact=True).click()
    expect(page.locator('#toast')).to_contain_text('워크플로우를 저장했습니다')
    page.locator('#toast').wait_for(state='hidden')
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.screenshot(path=str(ROOT / 'docs/assets/workflow-desktop.png'), full_page=True)
    context.set_default_timeout(15000)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.locator('#workflow-canvas').focus()
    page.screenshot(path=str(ROOT / 'docs/assets/workflow-mobile.png'), full_page=True)
    metrics = page.evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth})')
    assert metrics['documentWidth'] <= metrics['width'] + 1, metrics
    page.set_viewport_size({'width': 1440, 'height': 1080})
    page.get_by_role('button', name='연결 & 설정', exact=True).click()
    expect(page.locator('#command-list')).to_contain_text('Aside 명령 수신 연결 검증')
    page.locator('#command-message').fill('브라우저 명령 접수 실동작 검증')
    page.locator('#command-form button[type="submit"]').click()
    expect(page.locator('#command-list')).to_contain_text('브라우저 명령 접수 실동작 검증')
    assert not errors, errors
    result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'base': base, 'login': True, 'secureCookie': session_cookie['secure'], 'sceneEditPersisted': True, 'workflowEdgeDisconnectReconnect': True, 'nodeDragAndSave': True, 'mobileViewport': metrics, 'asideCommandReceived': True, 'webCommandSubmitted': True, 'pageErrors': errors}
    (ROOT / 'artifacts/browser-smoke.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result, indent=2))
    browser.close()
