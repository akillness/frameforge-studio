"""Focused workflow minimap and overlay regression checks on disposable loopback servers.

Uses only the browser-facing workflow surface. The workflow run list is intercepted with
an in-memory progression fixture, so no provider, agent, render, paid generation, or
publication work is invoked. Run with WORKFLOW_STUDIO_URL=http://127.0.0.1:4328 (or 4329).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("WORKFLOW_STUDIO_URL", "http://127.0.0.1:4328").rstrip("/")
parsed = urlparse(BASE)
assert parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port in {4328, 4329} and parsed.path in {"", "/"}, "Only disposable loopback ports 4328/4329 are permitted"
RECEIPT = ROOT / os.environ.get("WORKFLOW_STUDIO_RECEIPT", "artifacts/workflow-browser-smoke.json")
RECEIPT.parent.mkdir(parents=True, exist_ok=True)
result = {
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
    "base": BASE,
    "checks": {},
    "pageErrors": [],
    "scope": "Workflow minimap and popup overlays; intercepted run polling fixture; no provider or publication",
}


def check(name, condition, detail=None):
    assert condition, detail or name
    result["checks"][name] = True
    print(name, flush=True)


def request(client, path, body=None, method="POST"):
    response = client.fetch(BASE + path, method=method if body is not None else "GET", data=body)
    assert response.ok, f"{method} {path}: {response.status}: {response.text()[:400]}"
    return response.json()


def viewport_signature(page):
    return page.locator("#wf-minimap-viewport").evaluate(
        "el => ({transform: el.style.transform, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height})"
    )


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    context.set_default_timeout(15000)
    page = context.new_page()
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))

    try:
        token = os.environ.get("WORKFLOW_STUDIO_TOKEN")
        if token:
            login = context.request.post(BASE + "/api/login", data={"token": token})
            assert login.ok, f"POST /api/login: {login.status}"

        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        state = request(context.request, "/api/state")
        channel = request(context.request, "/api/channels", {"name": f"Workflow fixture {suffix}", "category": "information", "platform": "youtube"})
        episode = request(context.request, "/api/episodes", {"channelId": channel["id"], "title": f"Workflow episode {suffix}", "topic": "Overlay state stays visible", "category": "information"})
        source = state["workflows"][0]
        nodes = [
            {"id": f"workflow-fixture-{kind}", "type": kind, "x": 70 + index * 285, "y": 100, "config": {"agent": "existing", "prompt": ""} if kind == "script" else ({"model": "seedance_2_5", "prompt": "", "sceneIndex": 0} if kind == "generate" else {})}
            for index, kind in enumerate(["script", "storyboard", "generate", "render", "review"])
        ]
        workflow = request(context.request, "/api/workflows", {
            "name": f"Workflow browser fixture {suffix}",
            "nodes": nodes,
            "edges": [
                {"id": f"workflow-fixture-edge-{index}", "source": nodes[index]["id"], "target": nodes[index + 1]["id"]}
                for index in range(len(nodes) - 1)
            ],
        })
        result.update(channelId=channel["id"], episodeId=episode["id"], workflowId=workflow["id"])

        run_id = f"workflow-fixture-run-{suffix}"
        node_runs = [
            {"nodeId": node["id"], "type": node["type"], "status": "running" if index == 0 else "pending", "output": {}}
            for index, node in enumerate(nodes)
        ]
        running_run = {
            "id": run_id,
            "workflowId": workflow["id"],
            "workflowVersion": workflow["version"],
            "workflowSnapshot": workflow,
            "episodeId": episode["id"],
            "episodeVersion": episode["version"],
            "status": "running",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "nodeRuns": node_runs,
        }
        failed_run = json.loads(json.dumps(running_run))
        failed_run["status"] = "failed"
        failed_run["error"] = "Fixture stage failure; resume is expected"
        failed_run["nodeRuns"][0]["status"] = "failed"
        review_run = json.loads(json.dumps(running_run))
        review_run["status"] = "awaiting_review"
        review_run["nodeRuns"][0]["status"] = "completed"
        review_run["nodeRuns"][1]["status"] = "completed"
        review_run["nodeRuns"][2]["status"] = "completed"
        review_run["nodeRuns"][3]["status"] = "completed"
        review_run["nodeRuns"][4]["status"] = "awaiting_review"
        poll_count = {"runs": 0}
        stage_started = {"value": False}
        resumed = {"value": False}
        hold_next_poll = {"value": False}
        held_poll_route = {"route": None}
        run_posts = []

        def route_runs(route):
            poll_count["runs"] += 1
            if hold_next_poll["value"]:
                hold_next_poll["value"] = False
                held_poll_route["route"] = route
                return
            if not stage_started["value"]:
                route.fulfill(json=[])
            elif resumed["value"]:
                route.fulfill(json=[review_run])
            else:
                route.fulfill(json=[running_run if poll_count["runs"] <= 2 else failed_run])


        def route_start(route):
            body = json.loads(route.request.post_data or "{}")
            run_posts.append(body)
            if body.get("resumeRunId"):
                resumed["value"] = True
                route.fulfill(status=202, json=review_run)
            else:
                stage_started["value"] = True
                route.fulfill(status=202, json=running_run)

        context.route(f"**/api/workflows/{workflow['id']}/runs", route_runs)
        context.route(f"**/api/workflows/{workflow['id']}/run", route_start)
        page.goto(BASE, wait_until="networkidle")
        page.locator('[data-action="view"][data-view="workflow"]').click()
        expect(page.locator("#workflow-canvas")).to_be_visible()
        page.locator("#wf-select").select_option(workflow["id"])
        page.locator("#wf-episode").select_option(episode["id"])
        expect(page.locator("#wf-minimap")).to_be_visible()
        expect(page.locator(".wf-minimap-node[data-id]")).to_have_count(len(nodes))
        check("minimapRendersEveryWorkflowNode", page.locator(".wf-minimap-node[data-id]").count() == len(nodes))

        target_id = nodes[0]["id"]
        page.locator(f"[data-wf-action='select-node'][data-id='{target_id}']").click()
        expect(page.locator(f".wf-node.selected[data-node-id='{target_id}']")).to_be_visible()
        page.locator("#wf-inspector [data-wf-field='label']").fill("Overlay edited script")
        expect(page.locator("#wf-inspector [data-wf-field='label']")).to_have_value("Overlay edited script")
        page.wait_for_function("document.querySelector('#wf-minimap-viewport')?.style.width !== ''")
        initial_viewport = viewport_signature(page)
        page.locator("[data-wf-action='zoom-in']").click()
        page.wait_for_function(
            "previous => JSON.stringify(({transform: document.querySelector('#wf-minimap-viewport').style.transform, left: document.querySelector('#wf-minimap-viewport').style.left, top: document.querySelector('#wf-minimap-viewport').style.top, width: document.querySelector('#wf-minimap-viewport').style.width, height: document.querySelector('#wf-minimap-viewport').style.height})) !== JSON.stringify(previous)",
            arg=initial_viewport,
        )
        zoomed_viewport = viewport_signature(page)
        check("minimapViewportTracksZoom", zoomed_viewport != initial_viewport)

        minimap = page.locator("#wf-minimap")
        minimap.focus()
        minimap.press("ArrowLeft")
        page.wait_for_function(
            "previous => JSON.stringify(({transform: document.querySelector('#wf-minimap-viewport').style.transform, left: document.querySelector('#wf-minimap-viewport').style.left, top: document.querySelector('#wf-minimap-viewport').style.top, width: document.querySelector('#wf-minimap-viewport').style.width, height: document.querySelector('#wf-minimap-viewport').style.height})) !== JSON.stringify(previous)",
            arg=zoomed_viewport,
        )
        panned_viewport = viewport_signature(page)
        check("minimapViewportTracksPan", panned_viewport != zoomed_viewport)

        before_keyboard = viewport_signature(page)
        minimap.press("ArrowRight")

        page.wait_for_function(
            "previous => JSON.stringify(({transform: document.querySelector('#wf-minimap-viewport').style.transform, left: document.querySelector('#wf-minimap-viewport').style.left, top: document.querySelector('#wf-minimap-viewport').style.top, width: document.querySelector('#wf-minimap-viewport').style.width, height: document.querySelector('#wf-minimap-viewport').style.height})) !== JSON.stringify(previous)",
            arg=before_keyboard,
        )
        check("minimapSupportsKeyboardNavigation", viewport_signature(page) != before_keyboard)
        page.locator(f".wf-minimap-node[data-id='{target_id}']").click()
        expect(page.locator(f".wf-node.selected[data-node-id='{target_id}']")).to_be_visible()
        check("minimapClickSelectsNode", True)
        page.locator("[data-wf-action='save']").click()
        expect(page.locator("#wf-save-status")).to_contain_text("저장됨")
        workflow = next(item for item in request(context.request, "/api/workflows") if item["id"] == workflow["id"])
        for fixture_run in [running_run, failed_run, review_run]:
            fixture_run["workflowVersion"] = workflow["version"]
            fixture_run["workflowSnapshot"] = workflow
        check("editedWorkflowSavedBeforeStageRun", True)
        page.locator("[data-wf-action='open-stage-overlay']").click()
        stage_status = page.locator("#wf-stage-status")
        expect(stage_status).to_be_visible()
        expect(stage_status).to_have_attribute("aria-live", "polite")
        expect(stage_status).to_have_attribute("data-stage-state", "idle")
        expect(stage_status).to_contain_text("선택한 단계부터")
        check("stageOverlayShowsSelectedRunnableStage", True)

        with page.expect_request(lambda req: req.method == "POST" and req.url.endswith(f"/api/workflows/{workflow['id']}/run")) as started:
            page.locator("#wf-stage-start").click()
        start_body = json.loads(started.value.post_data or "{}")
        assert start_body.get("episodeId") == episode["id"], start_body
        assert start_body.get("expectedWorkflowVersion") == workflow["version"], start_body
        assert start_body.get("expectedEpisodeVersion") == episode["version"], start_body
        assert start_body.get("selectedStages") == [target_id], start_body
        assert start_body.get("startStage") == target_id, start_body
        assert "resumeRunId" not in start_body, start_body
        check("stageStartSendsSelectedStagePayload", True)
        expect(stage_status).to_have_attribute("data-stage-state", "running")
        page.keyboard.press("Escape")
        expect(stage_status).not_to_be_visible()
        page.locator("[data-wf-action='open-results']").click()
        results = page.locator("#wf-results-dialog")
        expect(results).to_be_visible()
        expect(results).to_contain_text("실행 중")
        results.locator("[data-wf-action='close-overlay']").click()
        expect(results).not_to_be_visible()
        check("runningStageVisibleInResultsOverlay", True)

        page.locator("[data-wf-action='refresh-runs']").click()
        page.locator("[data-wf-action='open-stage-overlay']").click()
        expect(stage_status).to_be_visible()
        expect(stage_status).to_have_attribute("data-stage-state", "blocked", timeout=10000)
        resume = page.locator("[data-wf-action='resume-stage']")
        expect(resume).to_be_visible()
        with page.expect_request(lambda req: req.method == "POST" and req.url.endswith(f"/api/workflows/{workflow['id']}/run")) as resumed_request:
            resume.click()
        resume_body = json.loads(resumed_request.value.post_data or "{}")
        assert resume_body.get("episodeId") == episode["id"], resume_body
        assert resume_body.get("resumeRunId") == run_id, resume_body
        assert resume_body.get("selectedStages") == [target_id], resume_body
        assert resume_body.get("startStage") == target_id, resume_body
        check("stageResumeSendsPriorRunAndSelectedStage", True)
        expect(stage_status).to_have_attribute("data-stage-state", "completed", timeout=10000)
        page.keyboard.press("Escape")
        expect(stage_status).not_to_be_visible()
        storyboard_id = nodes[1]["id"]
        render_id = nodes[3]["id"]
        page.locator(f"[data-wf-action='select-node'][data-id='{storyboard_id}']").click()
        page.locator("[data-wf-action='open-stage-overlay']").click()
        storyboard_status = page.locator("#wf-stage-status")
        expect(storyboard_status).to_be_visible()
        with page.expect_request(lambda req: req.method == "POST" and req.url.endswith(f"/api/workflows/{workflow['id']}/run")) as storyboard_request:
            page.locator("#wf-stage-start").click()
        storyboard_body = json.loads(storyboard_request.value.post_data or "{}")
        assert storyboard_body.get("selectedStages") == [storyboard_id], storyboard_body
        assert storyboard_body.get("startStage") == storyboard_id, storyboard_body
        assert storyboard_body.get("resumeRunId") == run_id, storyboard_body
        check("storyboardStageReusesTerminalScriptRun", True)
        page.keyboard.press("Escape")
        expect(storyboard_status).not_to_be_visible()

        page.locator(f"[data-wf-action='select-node'][data-id='{render_id}']").click()
        page.locator("[data-wf-action='open-stage-overlay']").click()
        render_status = page.locator("#wf-stage-status")
        expect(render_status).to_be_visible()
        assert render_status.get_attribute("data-stage-state") in {"idle", "completed"}, render_status.get_attribute("data-stage-state")
        expect(page.locator("#wf-stage-start")).to_be_enabled()
        with page.expect_request(lambda req: req.method == "POST" and req.url.endswith(f"/api/workflows/{workflow['id']}/run")) as render_request:
            page.locator("#wf-stage-start").click()
        render_body = json.loads(render_request.value.post_data or "{}")
        assert render_body.get("selectedStages") == [render_id], render_body
        assert render_body.get("startStage") == render_id, render_body
        assert render_body.get("resumeRunId") == run_id, render_body
        assert page.locator("#wf-confirm-dialog").count() == 0 or not page.locator("#wf-confirm-dialog").is_visible(), "Render-only stage must not open generation consent"
        check("renderOnlyStageDoesNotOpenGenerationConsent", True)
        page.keyboard.press("Escape")
        expect(render_status).not_to_be_visible()

        page.locator(f"[data-wf-action='select-node'][data-id='{target_id}']").click()
        page.locator("[data-wf-action='open-tools']").click()
        tools = page.locator("#wf-tools-dialog")
        expect(tools).to_be_visible()
        tools.locator("[data-wf-action='inspector-tab'][data-tab='settings']").click()
        check("toolsOverlayOpens", True)
        expect(tools.locator("[data-wf-field='label']")).to_have_value("Overlay edited script")
        tools.locator("[data-wf-action='close-overlay']").click()
        expect(tools).not_to_be_visible()
        page.locator("[data-wf-action='open-tools']").click()
        expect(tools).to_be_visible()
        expect(tools.locator("[data-wf-field='label']")).to_have_value("Overlay edited script")
        expect(page.locator(f".wf-node.selected[data-node-id='{target_id}']")).to_be_visible()
        check("toolsOverlayCloseReopenPreservesEditAndSelection", True)
        page.keyboard.press("Escape")
        expect(tools).not_to_be_visible()
        expect(page.locator("[data-wf-action='open-tools']")).to_be_focused()
        check("toolsOverlayEscapeClosesAndRestoresFocus", True)
        page.locator("[data-wf-action='open-tools']").click()
        expect(tools).to_be_visible()
        tools.locator("[data-wf-action='close-overlay']").click()

        page.locator("[data-wf-action='open-results']").click()
        expect(results).to_be_visible()
        expect(results).to_contain_text("사람의 검토 대기")
        expect(page.locator(f".wf-node.selected[data-node-id='{target_id}']")).to_be_visible()
        expect(page.locator("#wf-inspector [data-wf-field='label']")).to_have_value("Overlay edited script")
        run_select = results.locator("#wf-inspector-run")
        expect(run_select).to_be_visible()
        run_select.focus()
        page.locator("[data-wf-action='refresh-runs']").dispatch_event("click")
        expect(run_select).to_be_focused()
        check("resultsPollingPreservesFocusedRunSelector", True)
        check("pollingKeepsRunVisibleAcrossOverlayCloseAndReopen", True)
        page.keyboard.press("Escape")
        expect(results).not_to_be_visible()
        expect(page.locator("[data-wf-action='open-results']")).to_be_focused()
        check("resultsOverlayEscapeClosesAndRestoresFocus", True)

        poll_before_disposal = poll_count["runs"]
        hold_next_poll["value"] = True
        with page.expect_request(lambda req: req.method == "GET" and f"/api/workflows/{workflow['id']}/runs" in req.url):
            page.locator("[data-wf-action='refresh-runs']").click()
        expect(page.locator("#workflow-canvas")).to_be_visible()
        page.locator('[data-action="view"][data-view="studio"]').click()
        expect(page.locator("#workflow-canvas")).not_to_be_visible()
        assert held_poll_route["route"] is not None, "delayed poll request was not held"
        held_poll_route["route"].fulfill(json=[review_run])
        page.wait_for_timeout(2400)
        assert poll_count["runs"] == poll_before_disposal + 1, poll_count
        check("delayedPollDoesNotRecreateAfterWorkflowDisposal", True)

        check("noBrowserPageErrors", not result["pageErrors"], result["pageErrors"])
        result["pollResponses"] = poll_count["runs"]
        result["status"] = "passed"
    except Exception as error:
        result["status"] = "failed"
        result["failure"] = str(error)
        raise
    finally:
        RECEIPT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        browser.close()
        print(json.dumps({"status": result.get("status"), "checks": len(result["checks"]), "failure": result.get("failure"), "receipt": str(RECEIPT)}, ensure_ascii=False), flush=True)
