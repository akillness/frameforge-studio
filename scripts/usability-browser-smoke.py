"""Exercise local disposable UX data without provider generation or channel publication.

Uses the already-installed Python Playwright. The target must be a local test server.
Only newly-created test channel/episode/workflow records are modified.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('UX_STUDIO_URL', 'http://127.0.0.1:4322').rstrip('/')
assert urlparse(BASE).hostname in {'127.0.0.1', 'localhost'}, 'Use a disposable local test server'
SHOTS = ROOT / 'docs/assets/usability'
SHOTS.mkdir(parents=True, exist_ok=True)
RECEIPT = ROOT / 'artifacts/usability-browser-smoke.json'
result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'base': BASE,
          'scope': 'Disposable local test records; no generation submission or publication', 'checks': {}}

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1080}, device_scale_factor=1)
    context.set_default_timeout(15000)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def request(route, body=None, method='POST'):
        response = context.request.fetch(BASE + route, method=method if body is not None else 'GET', data=body)
        assert response.ok, f'{method} {route}: {response.status}: {response.text()[:400]}'
        return response.json()

    def check(name, condition=True):
        assert condition, name
        result['checks'][name] = True
        print(name, flush=True)

    def shot(name, full=True):
        page.screenshot(path=str(SHOTS / name), full_page=full)

    def metrics():
        return page.evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth})')

    try:
        channel = request('/api/channels', {'name': '사용성 검증 스튜디오', 'category': 'information', 'platform': 'youtube'})
        episode = request('/api/episodes', {'channelId': channel['id'], 'title': '도시의 아침을 바꾸는 작은 습관', 'topic': '출근 전 하루를 정리하는 작은 습관', 'category': 'information'})
        scene = dict(episode['scenes'][0], text='아침 5분, 오늘의 우선순위를 적어보세요.', narration='아침 5분으로 오늘의 할 일을 정리해 보세요.', duration=1)
        episode = request('/api/episodes/' + episode['id'], {'expectedVersion': 1, 'scenes': [scene], 'notes': '짧고 차분하게 전달'}, 'PUT')
        graph = request('/api/workflows')[0]
        nodes = [dict({key: node[key] for key in ['id', 'type', 'x', 'y']}, config={'agent': 'existing', 'prompt': ''} if node['type'] == 'script' else {}) for node in graph['nodes'] if node['type'] in {'script', 'storyboard', 'render', 'review'}]
        graph = request('/api/workflows', {'name': '사용성 검증 · 저장본 제작', 'nodes': nodes, 'edges': [{'id': 'ux-edge-' + str(i), 'source': nodes[i]['id'], 'target': nodes[i+1]['id']} for i in range(len(nodes)-1)]})
        result.update(episodeId=episode['id'], workflowId=graph['id'])
        page.goto(BASE, wait_until='networkidle')
        page.locator(f'[data-action="channel"][data-id="{channel["id"]}"]').click()
        page.locator(f'[data-action="episode"][data-id="{episode["id"]}"]').click()
        page.locator('[data-action="view"][data-view="history"]').click()
        page.locator('[data-action="history-version"][data-version="1"]').click()
        expect(page.locator('[data-testid="episode-history-comparison"]')).to_contain_text('아침 5분')
        check('episodeReadableComparison')
        shot('history-desktop.png')
        page.locator('[data-action="restore-episode"]').click()
        expect(page.locator('#modal')).to_be_visible()
        page.locator('#modal-form button[type="submit"]').click()
        expect(page.locator('#modal')).not_to_be_visible()
        history = request(f'/api/episodes/{episode["id"]}/history')
        check('episodeRestoreCreatesVersionAndPreservesHistory', len(history) == 3 and history[0]['version'] == 3 and history[-1]['version'] == 1)
        page.locator('[data-action="view"][data-view="studio"]').click()
        page.locator('[data-scene="text"]').fill('수정한 문장은 다음 화면으로 이동해도 안전하게 저장됩니다.')
        expect(page.locator('#save-status')).to_contain_text('저장되지 않은 변경')
        page.locator('[data-action="view"][data-view="history"]').click()
        history = request(f'/api/episodes/{episode["id"]}/history')
        check('episodeNavigationSavesDraft', history[0]['snapshot']['scenes'][0]['text'].startswith('수정한 문장'))
        page.locator('[data-action="view"][data-view="workflow"]').click()
        page.locator('#wf-select').select_option(graph['id'])
        page.locator('#wf-episode').select_option(episode['id'])
        script_id = next(node['id'] for node in nodes if node['type'] == 'script')
        page.locator(f'.wf-node-header[data-id="{script_id}"]').click()
        label = page.locator('[data-wf-field="label"]')
        label.fill('원고 확인')
        label.press('End')
        label.press_sequentially(' · 최종')
        expect(label).to_be_focused()
        expect(page.locator(f'[data-node-id="{script_id}"] .wf-node-label')).to_have_text('원고 확인 · 최종')
        page.locator('[data-wf-field="notes"]').fill('검증된 원고와 음성을 보존해 주세요.')
        check('nodeEditsPreserveFocusAndCanvas')
        expect(page.locator('[data-wf-action="restore-workflow"]')).to_be_disabled()
        check('dirtyWorkflowBlocksRestore')
        page.locator('[data-wf-action="undo"]').click()
        expect(page.locator('[data-wf-field="notes"]')).to_have_value('')
        page.locator('[data-wf-action="redo"]').click()
        expect(page.locator('[data-wf-field="notes"]')).to_have_value('검증된 원고와 음성을 보존해 주세요.')
        check('nodeUndoRedo')
        page.locator('[data-wf-action="save"]').click()
        expect(page.locator('#wf-save-status')).to_contain_text('버전 2 · 저장됨')
        check('nodeFieldsSaved')
        page.locator('[data-wf-action="inspector-tab"][data-tab="history"]').click()
        page.locator('#wf-node-history-version').select_option('1')
        expect(page.locator('#wf-inspector')).to_contain_text('원고 확인 · 최종')
        check('nodeHistoryComparison')
        shot('workflow-history-desktop.png')
        page.locator('[data-wf-action="restore-node"]').click()
        expect(page.locator('[data-wf-field="label"]')).to_have_value('')
        expect(page.locator('[data-wf-action="undo"]')).to_be_enabled()
        page.locator('[data-wf-action="save"]').click()
        expect(page.locator('#wf-save-status')).to_contain_text('버전 3 · 저장됨')
        check('nodeHistoryRestoreAsDraftThenSave')
        page.locator('[data-wf-action="history-version"][data-version="2"]').click()
        page.locator('[data-wf-action="restore-workflow"]').click()
        expect(page.locator('#wf-confirm-dialog')).to_be_visible()
        page.locator('[data-wf-action="confirm-restore"]').click()
        expect(page.locator('#wf-save-status')).to_contain_text('버전 4 · 저장됨')
        expect(page.locator('[data-wf-field="label"]')).to_have_value('원고 확인 · 최종')
        check('workflowRestoreCreatesNewVersion')
        page.locator('[data-wf-action="run"]').click()
        expect(page.locator('#wf-runs')).to_contain_text('사람의 검토 대기', timeout=90000)
        page.locator('[data-wf-action="inspector-tab"][data-tab="results"]').click()
        expect(page.locator('#wf-inspector')).to_contain_text('실행 당시 워크플로우 v4')
        expect(page.locator('#wf-inspector')).to_contain_text('저장된 장면')
        check('selectedNodeReadableRunInputsAndOutputs')
        shot('workflow-results-desktop.png')
        page.locator('#wf-add-type').select_option('generate')
        page.locator('[data-wf-action="add-node"]').click()
        expect(page.locator('#wf-generation-model')).to_be_visible()
        expect(page.locator('[data-wf-param="aspect_ratio"]')).to_be_visible(timeout=30000)
        expect(page.locator('.generation-connection')).to_contain_text('연결됨')
        page.locator('[data-wf-param="aspect_ratio"]').select_option('9:16')
        page.locator('[data-wf-config="prompt"]').fill('차분한 아침 책상, 창가의 자연광, 손으로 하루 계획을 적는 장면')
        check('unsupportedReferenceInputsHidden', page.locator('[data-wf-param="image_references"],[data-wf-param="start_image"]').count() == 0)
        check('higgsfieldSchemaControlsAndConnection')
        generation_id = page.locator('.wf-node.selected').get_attribute('data-node-id')
        storyboard_id = next(node['id'] for node in nodes if node['type'] == 'storyboard')
        render_id = next(node['id'] for node in nodes if node['type'] == 'render')
        for source, target in [(storyboard_id, generation_id), (generation_id, render_id)]:
            page.get_by_text('노드 연결 편집', exact=True).click()
            page.locator('#wf-connect-form [name="source"]').select_option(source)
            page.locator('#wf-connect-form [name="target"]').select_option(target)
            page.locator('#wf-connect-form button[type="submit"]').click()
        expect(page.locator('#wf-validation')).to_contain_text('실행 가능한 연결')
        page.locator('[data-wf-action="save"]').click()
        expect(page.locator('#wf-save-status')).to_contain_text('버전 5 · 저장됨')
        check('generationNodeConnectionsAndSettingsPersist')
        page.locator('[data-wf-action="run"]').click()
        expect(page.locator('#wf-confirm-dialog')).to_contain_text('비용')
        page.locator('[data-wf-action="close-dialog"]').click()
        check('generationRequiresExplicitConfirmationWithoutSubmission')
        page.locator('[data-wf-action="fit"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('generation-desktop.png')
        result['desktopViewport'] = metrics()
        check('desktopNoHorizontalOverflow', result['desktopViewport']['documentWidth'] <= 1441)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('[data-wf-action="fit"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('generation-mobile.png')
        result['mobileViewport'] = metrics()
        check('mobileNoHorizontalOverflow', result['mobileViewport']['documentWidth'] <= 391)
        page.locator('[data-wf-action="discard"]').click()
        page.locator('[data-action="view"][data-view="history"]').click()
        page.locator('[data-action="history-version"][data-version="1"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('history-mobile.png')
        check('historyMobileNoHorizontalOverflow', metrics()['documentWidth'] <= 391)
        # UI contract fixtures: no provider account, generation request, or recovery mutation.
        fixture_model = 'higgsfield-ai/soul/standard'
        invalid_schema_requests = []

        def generation_fixture(route):
            parsed = urlparse(route.request.url)
            if parsed.path.endswith('/status'):
                payload = {'configured': True, 'available': True, 'authentication': 'configured', 'transport': 'api'}
            elif not parsed.query:
                payload = [{'id': fixture_model, 'name': 'Direct API fixture', 'type': 'image', 'transport': 'api'}]
            elif 'seedance_2_5' in parsed.query:
                invalid_schema_requests.append(parsed.query)
                route.fulfill(status=400, json={'error': 'The CLI identifier is not an API model'})
                return
            else:
                payload = {'id': fixture_model, 'type': 'image', 'inputMode': 'prompt-only', 'parameters': [{'name': 'aspect_ratio', 'type': 'string', 'enum': ['1:1', '9:16'], 'default': '1:1'}]}
            route.fulfill(json=payload)

        page.route('**/api/generation/**', generation_fixture)
        page.set_viewport_size({'width': 1440, 'height': 1080})
        page.reload(wait_until='networkidle')
        page.locator('[data-action="view"][data-view="workflow"]').click()
        page.locator('#wf-select').select_option(graph['id'])
        page.locator(f'.wf-node-header[data-id="{generation_id}"]').click()
        expect(page.locator('#wf-generation-model')).to_have_value('seedance_2_5')
        expect(page.locator(f'#wf-generation-model option[value="{fixture_model}"]')).to_have_count(1)
        expect(page.locator('.generation-connection')).to_contain_text('설정됨 · 검증 필요')
        page.locator('#wf-generation-model').select_option(fixture_model)
        expect(page.locator('[data-wf-param="aspect_ratio"]')).to_be_visible()
        check('directApiCatalogFixtureKeepsSelectableModelsAfterInvalidSavedModel', not invalid_schema_requests)
        check('configuredApiFixtureIsNotClaimedAuthenticated')

        live_graph = next(item for item in request('/api/workflows') if item['id'] == graph['id'])
        live_episode = next(item for item in request('/api/state')['episodes'] if item['id'] == episode['id'])
        export = next(item for item in request('/api/state')['jobs'] if item['episodeId'] == episode['id'] and item['status'] == 'completed')
        recovery_job = {'id': 'fixture-generation', 'episodeId': episode['id'], 'episodeVersion': live_episode['version'], 'sceneId': live_episode['scenes'][0]['id'], 'model': fixture_model, 'providerRequestId': 'fixture-request-existing', 'status': 'polling_failed', 'applied': False, 'outputs': [], 'error': 'Fixture: status polling interrupted'}
        recovery_calls = []
        apply_calls = []
        fixture_run = {'id': 'fixture-run', 'workflowId': graph['id'], 'workflowVersion': live_graph['version'], 'workflowSnapshot': live_graph, 'episodeId': episode['id'], 'episodeVersion': live_episode['version'], 'status': 'failed', 'createdAt': datetime.now(timezone.utc).isoformat(), 'nodeRuns': [{'nodeId': generation_id, 'type': 'generate', 'status': 'failed', 'output': {'generationJobId': recovery_job['id']}}]}
        page.route(f'**/api/workflows/{graph["id"]}/runs', lambda route: route.fulfill(json=[fixture_run]))

        def recovery_fixture(route):
            if route.request.method == 'POST' and route.request.url.endswith('/recover'):
                recovery_calls.append(route.request.post_data_json)
                recovery_job.update(status='completed', error='', outputs=[{'url': export['outputUrl'], 'type': 'video'}])
            elif route.request.method == 'POST' and route.request.url.endswith('/apply'):
                apply_calls.append(route.request.post_data_json)
                if len(apply_calls) == 1:
                    route.fulfill(status=409, json={'error': 'Episode changed: fixture stale version'})
                    return
                recovery_job['applied'] = True
            route.fulfill(json=recovery_job)

        page.route('**/api/generations/fixture-generation**', recovery_fixture)
        page.reload(wait_until='networkidle')
        page.locator('[data-action="view"][data-view="workflow"]').click()
        page.locator('#wf-select').select_option(graph['id'])
        page.locator(f'.wf-node-header[data-id="{generation_id}"]').click()
        page.locator('[data-wf-field="notes"]').fill('복구 중에도 보존할 노드 편집')
        page.locator('[data-wf-action="inspector-tab"][data-tab="results"]').click()
        expect(page.locator('[data-wf-action="recover-generation-job"]')).to_be_visible()
        page.locator('[data-wf-action="recover-generation-job"]').click()
        expect(page.locator('[data-wf-action="apply-generation-job"]')).to_be_visible()
        expect(page.locator('[data-testid="generation-recovery"] video')).to_be_visible()
        page.locator('[data-wf-action="apply-generation-job"]').click()
        expect(page.locator('#toast')).to_contain_text('편집을 보존')
        expect(page.locator('#wf-save-status')).to_contain_text('저장되지 않은 변경')
        check('generationRecoveryFixtureStaleApplyPreservesDraft')
        page.locator('[data-wf-action="apply-generation-job"]').click()
        expect(page.locator('[data-testid="generation-recovery"]')).to_contain_text('장면에 적용되었습니다')
        check('generationRecoveryFixtureUsesExistingIdAndAppliesCompletedOutput', recovery_calls == [{}] and len(apply_calls) == 2 and apply_calls[0]['sceneId'] == recovery_job['sceneId'] and apply_calls[0]['expectedVersion'] == live_episode['version'])
        shot('generation-recovery-fixture.png')
        result['fixtureScope'] = 'Direct API catalog and paid-output recovery controls used intercepted browser HTTP fixtures. Actual provider generation/recovery was not invoked.'
        check('zeroPageErrors', not errors)
        result['status'] = 'passed'
    except Exception as error:
        result['status'] = 'failed'
        result['failure'] = str(error)[:1600]
        shot('failure.png')
        raise
    finally:
        result['pageErrors'] = errors
        RECEIPT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
