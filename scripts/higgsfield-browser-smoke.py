"""Verify an already-generated test asset over production HTTPS without generating again.

Reads private test identities from ops/live-higgsfield-job.json and the session secret
from .env. Creates one preservation-only workflow for that test episode, renders it,
and leaves the result awaiting human review. No generation submission or publication.
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ENV = dict(line.split('=', 1) for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines()
           if '=' in line and not line.lstrip().startswith('#'))
BASE = (os.environ.get('STUDIO_URL') or ENV['PUBLIC_ORIGIN']).rstrip('/')
assert urlparse(BASE).scheme == 'https', 'This verification requires the actual HTTPS service'
TOKEN = os.environ.get('LOGIN_TOKEN') or ENV['LOGIN_TOKEN']
PRIVATE = json.loads((ROOT / 'ops/live-higgsfield-job.json').read_text(encoding='utf-8'))
PROVIDER_RECEIPT = json.loads((ROOT / 'artifacts/higgsfield-live-smoke.json').read_text(encoding='utf-8'))
EPISODE_ID, SCENE_ID, GENERATION_ID = PRIVATE['episodeId'], PRIVATE['sceneId'], PRIVATE['generationId']
SHOTS = ROOT / 'docs/assets/higgsfield-live'
SHOTS.mkdir(parents=True, exist_ok=True)
OUTPUT = ROOT / 'artifacts/higgsfield-browser-smoke.json'
READ_ONLY = os.environ.get('HIGGSFIELD_BROWSER_READ_ONLY') == '1'
RERUN_EXISTING = os.environ.get('HIGGSFIELD_BROWSER_RERUN') == '1'
assert not RERUN_EXISTING or READ_ONLY, 'Rerun mode must reuse the recorded workflow'
PRIOR = json.loads(OUTPUT.read_text(encoding='utf-8')) if READ_ONLY else None
result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'base': BASE,
          'scope': 'Existing paid test generation; preservation-only render; no new generation or review approval',
          'checks': {}, 'screenshots': []}
if READ_ONLY:
    result.update({key: PRIOR[key] for key in ['workflowId', 'runId']})

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1080}, device_scale_factor=1)
    context.set_default_timeout(20000)
    page = context.new_page()
    errors, generation_submissions = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: generation_submissions.append(request.url) if request.method == 'POST' and '/episodes/' in request.url and request.url.endswith('/generations') else None)

    def api(route, body=None):
        response = context.request.post(BASE + route, data=body) if body is not None else context.request.get(BASE + route)
        assert response.ok, f'{route}: HTTP {response.status}'
        return response.json()

    def check(name, condition=True):
        assert condition, name
        result['checks'][name] = True
        print(name, flush=True)

    def shot(name, locator=None):
        page.locator('#toast').wait_for(state='hidden', timeout=12000)
        if locator:
            locator.screenshot(path=str(SHOTS / name))
        else:
            page.screenshot(path=str(SHOTS / name), full_page=True)
        result['screenshots'].append(f'docs/assets/higgsfield-live/{name}')

    def play(selector):
        media = page.locator(selector)
        media.scroll_into_view_if_needed()
        page.wait_for_function('(selector)=>{const v=document.querySelector(selector);return v && v.readyState>=1 && v.videoWidth>0 && v.videoHeight>0 && Number.isFinite(v.duration) && v.duration>0}', arg=selector)
        duration = media.evaluate('v=>v.duration')
        media.evaluate('async v=>{v.muted=true;await v.play()}')
        page.wait_for_function('(selector)=>document.querySelector(selector).currentTime>0.15', arg=selector)
        advanced = media.evaluate('v=>v.currentTime')
        media.evaluate('v=>{v.pause();v.currentTime=Math.min(1.1,v.duration/2)}')
        page.wait_for_function('(selector)=>{const v=document.querySelector(selector);return !v.seeking && v.readyState>=2}', arg=selector)
        return {'duration': duration, 'advancedTo': advanced, 'played': advanced > 0.15,
                'videoWidth': media.evaluate('v=>v.videoWidth'), 'videoHeight': media.evaluate('v=>v.videoHeight')}

    def metrics():
        return page.evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth})')

    try:
        page.goto(BASE, wait_until='networkidle')
        page.locator('input[name="token"]').fill(TOKEN)
        page.locator('#login-form button[type="submit"],#login-form button:not([type])').click()
        expect(page.locator('[data-action="channel"]').first).to_be_visible()
        cookie = next(item for item in context.cookies() if item['name'] == 'frameforge_session')
        check('httpsSecureSessionCookie', cookie['secure'] and cookie['httpOnly'] and cookie['sameSite'] == 'Strict')
        if READ_ONLY:
            result['deployedAssetSha256'] = {}
            for filename in ['app.js', 'workflow.js', 'workflow.css', 'history.js']:
                response = context.request.get(BASE + '/' + filename)
                digest = hashlib.sha256(response.body()).hexdigest()
                assert response.ok and digest == hashlib.sha256((ROOT / 'public' / filename).read_bytes()).hexdigest(), f'Deployed {filename} differs from checked source'
                result['deployedAssetSha256'][filename] = digest
            check('latestFrontendServedOverHttps')
        state = api('/api/state')
        episode = next(item for item in state['episodes'] if item['id'] == EPISODE_ID)
        generation = api('/api/generations/' + GENERATION_ID)
        check('paidGenerationPersistedAfterRebuild', generation['status'] == 'completed' and generation['applied'])
        output = generation['outputs'][0]
        scene = next(item for item in episode['scenes'] if item['id'] == SCENE_ID)
        check('importedAssetStillAttached', scene['kind'] == 'video' and scene['assetUrl'] == output['url'])
        media_response = context.request.get(BASE + output['url'])
        check('importedAssetHashMatches', media_response.ok and hashlib.sha256(media_response.body()).hexdigest() == output['sha256'])
        original = output.get('original', output)
        original_response = context.request.get(BASE + original['url'])
        check('originalProviderAssetPreserved', original_response.ok and hashlib.sha256(original_response.body()).hexdigest() == PROVIDER_RECEIPT['asset']['sha256'] == original['sha256'])
        check('browserCompatibleNormalizedVideo', output.get('normalized') and output.get('codecName') == 'h264' and output.get('pixelFormat') == 'yuv420p')
        history = api(f'/api/episodes/{EPISODE_ID}/history')
        applied_entry = next(item for item in history if item['reason'] == f'generation:{GENERATION_ID}' and any(scene.get('assetUrl') == output['url'] for scene in item['snapshot']['scenes']))
        before_entry = next(item for item in history if item['version'] == applied_entry['version'] - 1)
        check('generationApplyHasBeforeAfterHistory', before_entry['snapshot']['scenes'][0].get('assetUrl') != output['url'] and applied_entry['snapshot']['scenes'][0]['assetUrl'] == output['url'])
        page.locator(f'[data-action="channel"][data-id="{episode["channelId"]}"]').click()
        page.locator(f'[data-action="episode"][data-id="{EPISODE_ID}"]').click()
        index = next(i for i, item in enumerate(episode['scenes']) if item['id'] == SCENE_ID)
        page.locator(f'[data-action="scene"][data-index="{index}"]').click()
        result['importedPlayback'] = play('#preview video')
        check('importedGeneratedVideoActuallyPlays', result['importedPlayback']['played'])
        shot('paper-city-frame.png', page.locator('#preview'))
        page.evaluate('window.scrollTo(0,0)')
        shot('editor-desktop.png')
        page.locator('[data-action="view"][data-view="history"]').click()
        page.locator('[data-action="history-version"][data-version="' + str(before_entry['version']) + '"]').click()
        expect(page.locator('[data-testid="episode-history-comparison"]')).to_contain_text('이미지 / 영상')
        check('generationBeforeAfterReadableInHistory')
        page.evaluate('window.scrollTo(0,0)')
        shot('generation-history-desktop.png')

        # A new, bounded workflow preserves the existing paid output. It has no generate node.
        types = ['script', 'storyboard', 'render', 'review']
        labels = ['저장된 생성 결과', '장면 편집 유지', 'MP4 조립', '최종 영상 검토']
        nodes = [{'id': f'paid-proof-{kind}', 'type': kind, 'label': labels[i], 'x': 60 + i % 2 * 285, 'y': 80 + i // 2 * 230,
                  'config': {'agent': 'existing', 'prompt': ''} if kind == 'script' else {}} for i, kind in enumerate(types)]
        workflow = next(item for item in api('/api/workflows') if item['id'] == PRIOR['workflowId']) if READ_ONLY else api('/api/workflows', {'name': 'Higgsfield 실생성 검증 · 저장된 영상 유지', 'nodes': nodes,
                                        'edges': [{'id': f'paid-proof-edge-{i}', 'source': nodes[i]['id'], 'target': nodes[i+1]['id']} for i in range(3)]})
        page.locator('[data-action="view"][data-view="workflow"]').click()
        page.locator('#wf-select').select_option(workflow['id'])
        page.locator('#wf-episode').select_option(EPISODE_ID)
        page.locator(f'.wf-node-header[data-id="{nodes[0]["id"]}"]').click()
        expect(page.locator('#wf-agent')).to_have_value('existing')
        if READ_ONLY and not RERUN_EXISTING:
            run = next(item for item in api(f'/api/workflows/{workflow["id"]}/runs') if item['id'] == PRIOR['runId'])
            page.locator(f'[data-wf-action="select-run"][data-id="{run["id"]}"]').click()
        else:
            with page.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith(f'/api/workflows/{workflow["id"]}/run')) as started:
                page.locator('[data-wf-action="run"]').click()
            assert started.value.status == 202
            run = started.value.json()
        result.update(workflowId=workflow['id'], runId=run['id'])
        deadline = monotonic() + 150
        while monotonic() < deadline:
            run = next(item for item in api(f'/api/workflows/{workflow["id"]}/runs') if item['id'] == run['id'])
            if run['status'] in {'awaiting_review', 'failed', 'cancelled'}:
                break
            page.wait_for_timeout(1000)
        check('preservationWorkflowRenderedWithoutGeneration', run['status'] == 'awaiting_review' and not any(node['type'] == 'generate' for node in run['nodeRuns']))
        expect(page.locator('[data-testid="review-video"]')).to_be_visible(timeout=20000)
        result['renderPlayback'] = play('[data-testid="review-video"]')
        check('finalRenderActuallyPlays', result['renderPlayback']['played'])
        render = next(node['output'] for node in run['nodeRuns'] if node['type'] == 'render')
        render_response = context.request.get(BASE + render['outputUrl'])
        render_hash = hashlib.sha256(render_response.body()).hexdigest()
        check('finalRenderHashMatches', render_response.ok and render_hash == render['sha256'])
        after = next(item for item in api('/api/state')['episodes'] if item['id'] == EPISODE_ID)
        check('savedAssetAndSceneIdsPreservedByRerender', after['scenes'] == episode['scenes'])
        for tab in ['settings', 'history', 'results']:
            page.locator(f'[data-wf-action="inspector-tab"][data-tab="{tab}"]').click()
            expect(page.locator(f'[data-wf-action="inspector-tab"][data-tab="{tab}"]')).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#wf-inspector')).to_contain_text('실행 당시 워크플로우')
        check('selectedNodeTabsWorkOnProduction')
        page.locator('[data-wf-action="fit"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('workflow-desktop.png')
        result['desktopViewport'] = metrics()
        check('desktopNoOverflow', result['desktopViewport']['documentWidth'] == 1440)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('[data-wf-action="fit"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('workflow-mobile.png')
        result['mobileViewport'] = metrics()
        check('mobileNoOverflow', result['mobileViewport']['documentWidth'] == 390)
        page.locator('[data-action="view"][data-view="history"]').click()
        page.locator('[data-action="history-version"][data-version="' + str(before_entry['version']) + '"]').click()
        page.evaluate('window.scrollTo(0,0)')
        shot('generation-history-mobile.png')
        check('mobileHistoryNoOverflow', metrics()['documentWidth'] == 390)
        persisted = next(item for item in api(f'/api/workflows/{workflow["id"]}/runs') if item['id'] == run['id'])
        check('awaitingReviewNotApproved', persisted['status'] == 'awaiting_review' and not persisted.get('review'))
        check('noNewGenerationSubmission', not generation_submissions)
        check('zeroPageErrors', not errors)
        result.update(status='passed', secureCookie=True, episodeId=EPISODE_ID, generationJobId=GENERATION_ID,
                      workflowId=workflow['id'], runId=run['id'], generationAppliedVersion=applied_entry['version'],
                      renderedVersion=run['episodeVersion'], assetSha256=output['sha256'], originalAssetSha256=original['sha256'], renderSha256=render_hash,
                      renderUrl=render['outputUrl'], reviewState='awaiting_review', newGenerationSubmissions=0, readOnlyReverification=READ_ONLY and not RERUN_EXISTING, preservationOnlyRerun=RERUN_EXISTING)
    except Exception as error:
        result.update(status='failed', failure=str(error)[:1800])
        page.screenshot(path=str(SHOTS / 'failure.png'), full_page=True)
        raise
    finally:
        result['pageErrors'] = errors
        OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
