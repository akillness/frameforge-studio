"""Real HTTPS UI smoke: narration -> saved edit workflow -> human review record.

Requires installed Playwright/Chromium, local .env, and production-smoke receipt.
Mutates only the receipt's test episode/workflow. Never publishes a channel video.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ENV = dict(
    line.split("=", 1) for line in (ROOT / ".env").read_text(encoding="utf8").splitlines()
    if "=" in line and not line.lstrip().startswith("#")
)
BASE = os.environ.get("STUDIO_URL") or ENV.get("PUBLIC_ORIGIN") or "https://desktop-qrf3t5t.taila2003e.ts.net"
BASE = BASE.rstrip("/")
RECEIPT = json.loads((ROOT / "artifacts/production-smoke.json").read_text(encoding="utf8"))
EPISODE_ID, WORKFLOW_ID = RECEIPT["episodeId"], RECEIPT["workflowId"]
NOTES = "자동 브라우저 검증: 음성 생성·영상 재생·검토 기록의 영속성을 확인한 수정 요청입니다. 소유자의 승인이나 채널 게시가 아닙니다."


def checkpoint(message):
    print(message, flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
    context.set_default_timeout(20000)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def api(route):
        response = context.request.get(BASE + route)
        assert response.ok, f"GET {route}: {response.status}"
        return response.json()

    def wait_for_record(route, record_id, terminal, timeout=180):
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            value = api(route)
            records = value.get("narrationJobs", []) if isinstance(value, dict) else value
            record = next((item for item in records if item["id"] == record_id), None)
            if record and record["status"] in terminal:
                return record
            page.wait_for_timeout(1000)
        raise AssertionError(f"Timed out waiting for record {record_id}")

    def select_workflow():
        page.locator('[data-action="view"][data-view="workflow"]').click()
        expect(page.locator("#workflow-canvas")).to_be_visible()
        page.locator("#wf-select").select_option(WORKFLOW_ID)
        expect(page.locator("#wf-select")).to_have_value(WORKFLOW_ID)
        page.locator("#wf-episode").select_option(EPISODE_ID)

    def viewport_metrics():
        return page.evaluate("({width:innerWidth,documentWidth:document.documentElement.scrollWidth})")

    page.goto(BASE, wait_until="networkidle")
    page.locator('input[name="token"]').fill(ENV["LOGIN_TOKEN"])
    page.locator('#login-form button[type="submit"], #login-form button:not([type])').click()
    expect(page.locator('[data-action="channel"]').first).to_be_visible()
    cookie = next(item for item in context.cookies() if item["name"] == "frameforge_session")
    assert cookie["httpOnly"] and cookie["sameSite"] == "Strict"
    assert not BASE.startswith("https:") or cookie["secure"]
    state = api("/api/state")
    episode = next(item for item in state["episodes"] if item["id"] == EPISODE_ID)
    channel = next(item for item in state["channels"] if item["id"] == episode["channelId"])
    assert channel.get("sample"), "The receipt must point to a sample channel"
    page.locator(f'[data-action="channel"][data-id="{channel["id"]}"]').click()
    page.locator(f'[data-action="episode"][data-id="{EPISODE_ID}"]').click()
    previous_job = next(item for item in state["narrationJobs"] if item["episodeId"] == EPISODE_ID)
    assert previous_job["status"] == "completed"
    expect(page.locator("#narration-status")).to_contain_text(f'저장 버전 {previous_job["resultVersion"]}')
    expect(page.locator('[data-testid="narrate-scene"]')).to_be_enabled()
    checkpoint(f'Latest narration displayed correctly: v{previous_job["resultVersion"]}')

    with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/api/episodes/{EPISODE_ID}/narration")) as generated:
        page.locator('[data-testid="narrate-scene"]').click()
    assert generated.value.status == 202
    narration = generated.value.json()
    expect(page.locator('[data-testid="narrate-all"]')).to_be_disabled()
    narration = wait_for_record("/api/state", narration["id"], {"completed", "failed"})
    assert narration["status"] == "completed", narration.get("error")
    expect(page.locator("#narration-status")).to_contain_text(f'저장 버전 {narration["resultVersion"]}', timeout=20000)
    expect(page.locator('[data-testid="narrate-scene"]')).to_be_enabled()
    audio = page.locator("#scene-audio-preview")
    expect(audio).to_be_visible()
    page.wait_for_function("() => {const a=document.querySelector('#scene-audio-preview');return a && a.readyState>=1 && Number.isFinite(a.duration) && a.duration>0;}")
    audio_duration = audio.evaluate("a=>a.duration")
    audio.evaluate("async a=>{await a.play();}")
    page.wait_for_function("() => document.querySelector('#scene-audio-preview')?.currentTime > 0.05")
    assert audio.evaluate("a=>a.currentTime") > 0
    audio.evaluate("a=>{a.pause();a.currentTime=0;}")
    page.locator("#toast").wait_for(state="hidden")
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(ROOT / "docs/assets/narration-desktop.png"), full_page=True)
    checkpoint(f"Narration generated and played: {audio_duration:.3f}s")

    select_workflow()
    page.locator('.wf-node-header').filter(has_text="대본 작성").click()
    page.locator("#wf-agent").select_option("existing")
    expect(page.locator("#wf-agent")).to_have_value("existing")
    with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/api/workflows/{WORKFLOW_ID}/run")) as started:
        page.locator('[data-wf-action="run"]').click()
    assert started.value.status == 202
    run = started.value.json()
    run = wait_for_record(f"/api/workflows/{WORKFLOW_ID}/runs", run["id"], {"awaiting_review", "failed", "cancelled"})
    assert run["status"] == "awaiting_review", run.get("error")
    expect(page.locator('[data-testid="review-approve"]')).to_be_enabled(timeout=20000)
    video = page.locator('[data-testid="review-video"]')
    video.scroll_into_view_if_needed()
    page.wait_for_function("() => {const v=document.querySelector('[data-testid=review-video]');return v && v.readyState>=1 && Number.isFinite(v.duration) && v.duration>0;}")
    video_duration = video.evaluate("v=>v.duration")
    video.evaluate("async v=>{v.muted=true;await v.play();}")
    page.wait_for_function("() => document.querySelector('[data-testid=review-video]')?.currentTime > 0.05")
    assert video.evaluate("v=>v.currentTime") > 0
    video.evaluate("v=>{v.pause();v.currentTime=0.1;}")
    page.locator("#wf-review-notes").fill(NOTES)
    with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/runs/{run['id']}/review")) as reviewed:
        page.locator('[data-testid="review-changes"]').click()
    assert reviewed.value.ok
    reviewed_run = reviewed.value.json()
    assert reviewed_run["status"] == "changes_requested"
    assert reviewed_run["review"]["notes"] == NOTES
    checkpoint(f"Video playable and automated changes requested: {video_duration:.3f}s")

    page.reload(wait_until="networkidle")
    select_workflow()
    page.locator(f'[data-wf-action="select-run"][data-id="{run["id"]}"]').click()
    expect(page.locator(".wf-review-decision")).to_contain_text(NOTES)
    persisted = next(item for item in api(f"/api/workflows/{WORKFLOW_ID}/runs") if item["id"] == run["id"])
    assert persisted["review"] == reviewed_run["review"]
    assert len(persisted["review"]["sha256"]) == 64
    video = page.locator('[data-testid="review-video"]')
    video.scroll_into_view_if_needed()
    video.evaluate("v=>{v.currentTime=0.1;}")
    page.wait_for_timeout(300)
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(ROOT / "docs/assets/review-desktop.png"), full_page=True)
    desktop = viewport_metrics()
    assert desktop["documentWidth"] <= desktop["width"] + 1, desktop
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator('[data-wf-action="fit"]').click()
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=str(ROOT / "docs/assets/review-mobile.png"), full_page=True)
    mobile = viewport_metrics()
    assert mobile["documentWidth"] <= mobile["width"] + 1, mobile
    assert not errors, errors
    result = {
        "verifiedAt": datetime.now(timezone.utc).isoformat(), "base": BASE,
        "episodeId": EPISODE_ID, "workflowId": WORKFLOW_ID, "runId": run["id"],
        "narrationJobId": narration["id"], "previousNarrationVersion": previous_job["resultVersion"],
        "narrationVersion": narration["resultVersion"], "renderVersion": run["episodeVersion"],
        "latestNarrationDisplayed": True, "narrationButtonsRecover": True,
        "audioDuration": audio_duration, "audioPlayed": True,
        "videoDuration": video_duration, "videoPlayed": True,
        "existingScenesMode": True, "reviewDecision": "changes_requested",
        "reviewMeaning": "Automated browser verification, not owner acceptance or publication",
        "reviewPersistedAfterReload": True, "reviewSha256": persisted["review"]["sha256"],
        "secureCookie": cookie["secure"], "desktopViewport": desktop,
        "mobileViewport": mobile, "pageErrors": errors,
    }
    (ROOT / "artifacts/production-browser-smoke.json").write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result, indent=2), flush=True)
    browser.close()
