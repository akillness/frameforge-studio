"""Run hermetic-provider UI regressions against a disposable loopback server.

WHITE_STUDIO_URL selects the server; WHITE_STUDIO_TOKEN optionally logs in first.
Only uniquely named fixture records are created. Provider requests are intercepted,
all generation-create requests are blocked, and only stale workflow runs reach the
real server. No accepted workflow run, paid provider call, or publication is allowed.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("WHITE_STUDIO_URL", "http://127.0.0.1:4328").rstrip("/")
assert urlparse(BASE).hostname in {"127.0.0.1", "localhost"}, "Use a disposable local test server"
RECEIPT = ROOT / os.environ.get("WHITE_STUDIO_RECEIPT", "artifacts/white-studio-browser-smoke.json")
SHOTS = ROOT / os.environ.get("WHITE_STUDIO_SHOTS", "docs/assets/white-studio")
RECEIPT.parent.mkdir(parents=True, exist_ok=True)
SHOTS.mkdir(parents=True, exist_ok=True)
result = {
    "verifiedAt": datetime.now(timezone.utc).isoformat(), "base": BASE,
    "scope": "Disposable fixture records, real UI and persistence/version rejection; stubbed provider catalog/quotes/recovery/apply; no accepted run or provider spend",
    "checks": {}, "screenshots": [], "pageErrors": [],
}
generation_posts, estimate_posts, run_posts, run_responses = [], [], [], []
recovery_posts, apply_posts = [], []
result["requests"] = {"generationCreates": generation_posts, "estimates": estimate_posts,
                      "workflowRunAttempts": run_posts, "workflowRunResponses": run_responses,
                      "recoveryPosts": recovery_posts, "applyPosts": apply_posts}


def check(name, condition, detail=None):
    assert condition, detail or name
    result["checks"][name] = True
    print(name, flush=True)


def json_request(client, route, body=None, method="POST"):
    response = client.fetch(BASE + route, method=method if body is not None else "GET", data=body)
    assert response.ok, f"{method} {route}: {response.status}: {response.text()[:400]}"
    return response.json()


def screenshot(page, name):
    path = SHOTS / name
    page.screenshot(path=str(path), full_page=True)
    result["screenshots"].append(str(path.relative_to(ROOT)))


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    context.set_default_timeout(15000)
    page = context.new_page()
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))
    estimate_fails = False
    permit_stale_run = False

    def capture_request(request):
        if request.method != "POST":
            return
        path = urlparse(request.url).path
        entry = {"path": path, "body": request.post_data_json or {}}
        if path == "/api/generation/estimate":
            estimate_posts.append(entry["body"])
        elif re.fullmatch(r"/api/episodes/[^/]+/generations", path):
            generation_posts.append(entry)
        elif re.fullmatch(r"/api/workflows/[^/]+/run", path):
            run_posts.append(entry)
        elif path.endswith("/recover") and path.startswith("/api/generations/"):
            recovery_posts.append(entry)
        elif path.endswith("/apply") and path.startswith("/api/generations/"):
            apply_posts.append(entry)

    def capture_response(response):
        path = urlparse(response.url).path
        if response.request.method == "POST" and re.fullmatch(r"/api/workflows/[^/]+/run", path):
            run_responses.append({"path": path, "status": response.status, "boundary": response.headers.get("x-white-studio-boundary", "server"), "body": response.json()})

    page.on("request", capture_request)
    page.on("response", capture_response)

    def provider_fixture(route):
        path = urlparse(route.request.url).path
        if path.endswith("/estimate"):
            if estimate_fails:
                route.fulfill(status=503, json={"error": "Fixture quote unavailable"})
            else:
                route.fulfill(json={"credits": 1.5, "usd": 0.094})
        elif path.endswith("/status"):
            route.fulfill(json={"provider": "higgsfield", "transport": "api", "configured": True,
                                "available": True, "authenticated": "configured", "authentication": "configured",
                                "detail": "Fixture account configured, availability not verified"})
        elif urlparse(route.request.url).query:
            route.fulfill(json={"id": "fixture-api-model", "type": "image", "inputMode": "prompt-only", "parameters": [
                {"name": "aspect_ratio", "type": "string", "enum": ["1:1", "9:16"]},
                {"name": "duration", "type": "integer", "minimum": 4, "maximum": 30}]})
        else:
            route.fulfill(json=[{"id": "fixture-api-model", "name": "Fixture API model", "type": "image", "transport": "api"}])

    def block_create(route):
        route.fulfill(status=503, json={"error": "Browser regression forbids generation creation"})

    def run_boundary(route):
        if permit_stale_run:
            route.continue_()
        else:
            route.fulfill(status=409, headers={"x-white-studio-boundary": "fixture"}, json={"error": "Fixture safety boundary: execution intentionally rejected"})

    page.route("**/api/generation/**", provider_fixture)
    page.route(re.compile(r"/api/episodes/[^/?]+/generations$"), block_create)
    page.route(re.compile(r"/api/workflows/[^/?]+/run$"), run_boundary)
    page.route("**/api/integrations", lambda route: route.fulfill(json={"higgsfield": {
        "name": "Higgsfield fixture", "available": True, "status": "configured", "authentication": "configured"}}))

    def settle():
        page.wait_for_load_state("networkidle")

    def view(name):
        page.locator(f'[data-action="view"][data-view="{name}"]').first.click()
        settle()

    def saved_workflow(workflow_id):
        return next(item for item in json_request(context.request, "/api/workflows") if item["id"] == workflow_id)

    def saved_episode():
        return next(item for item in json_request(context.request, "/api/state")["episodes"] if item["id"] == episode["id"])

    def select_workflow(workflow_id, generate_id=None):
        page.locator("#wf-select").select_option(workflow_id)
        settle()
        page.locator("#wf-episode").select_option(episode["id"])
        if generate_id:
            page.locator(f"[data-wf-action='select-node'][data-id='{generate_id}']").click()
            page.locator("[data-wf-action='inspector-tab'][data-tab='settings']").click()
            expect(page.locator('[data-wf-param="aspect_ratio"]')).to_have_count(1)
            settle()

    def save_workflow():
        page.locator("[data-wf-action='save']").click()
        settle()
        expect(page.locator("#wf-save-status")).to_contain_text("저장됨")
        return saved_workflow(page.locator("#wf-select").input_value())

    def open_quote():
        count = len(estimate_posts)
        page.locator('[data-wf-action="run"]').click()
        settle()
        expect(page.locator("#wf-confirm-dialog")).to_be_visible()
        assert len(estimate_posts) == count + 1, estimate_posts

    def cancel_quote():
        before = (len(run_posts), len(generation_posts))
        page.locator('[data-wf-action="close-dialog"]').click()
        settle()
        expect(page.locator("#wf-confirm-dialog")).not_to_be_visible()
        assert before == (len(run_posts), len(generation_posts))

    try:
        token = os.environ.get("WHITE_STUDIO_TOKEN")
        if token:
            login = context.request.post(BASE + "/api/login", data={"token": token})
            assert login.ok, f"POST /api/login: {login.status}"
        result["authenticatedFixture"] = bool(token)
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        channel = json_request(context.request, "/api/channels", {"name": f"White studio fixture {suffix}", "category": "information", "platform": "youtube"})
        episode = json_request(context.request, "/api/episodes", {"channelId": channel["id"], "title": f"White studio episode {suffix}", "topic": "Fixture topic", "category": "information"})
        scene = dict(episode["scenes"][0], title="Fixture scene one", text="Preserve scene one")
        scene_two = dict(scene, id=scene["id"] + "-two", title="Fixture scene two", text="Preserve scene two")
        episode = json_request(context.request, f"/api/episodes/{episode['id']}", {"expectedVersion": episode["version"], "scenes": [scene, scene_two]}, "PUT")
        types = ["trend", "research", "script", "storyboard", "generate", "render", "review"]
        nodes = [{"id": f"fixture-{kind}", "type": kind, "x": 50 + index % 3 * 285, "y": 65 + index // 3 * 230,
                  "config": {"agent": "studio", "prompt": ""} if kind == "script" else
                  {"model": "fixture-api-model", "prompt": "fixture generation", "params": {"duration": 5}, "sceneIndex": 0} if kind == "generate" else {}}
                 for index, kind in enumerate(types)]
        unsafe = json_request(context.request, "/api/workflows", {"name": f"White unsafe studio fixture {suffix}", "nodes": nodes,
            "edges": [{"id": f"fixture-edge-{index}", "source": nodes[index]["id"], "target": node["id"]} for index, node in enumerate(nodes[1:])]})
        result.update(channelId=channel["id"], episodeId=episode["id"], unsafeWorkflowId=unsafe["id"])
        page.goto(BASE, wait_until="networkidle")
        page.locator(f'[data-action="channel"][data-id="{channel["id"]}"]').click()
        settle()
        view("workflow")
        select_workflow(unsafe["id"])

        view("settings")
        page.locator('[data-action="refresh-integrations"]').click()
        settle()
        # State refreshes may replace integrations between view switches. Refresh
        # the explicit fixture immediately before asserting its rendered badge.
        for width in [1440, 1024, 768, 390, 320]:
            page.set_viewport_size({"width": width, "height": 900 if width >= 768 else 844})
            for name in ["studio", "workflow", "trends", "templates", "history", "knowledge", "settings"]:
                view(name)
                dimensions = page.evaluate("({width:innerWidth, documentWidth:document.documentElement.scrollWidth, bodyWidth:document.body.scrollWidth})")
                check(f"{name}NoOverflow{width}", dimensions["documentWidth"] <= width + 1 and dimensions["bodyWidth"] <= width + 1, dimensions)
                surfaces = page.evaluate("[document.body,document.querySelector('.workspace'),document.querySelector('.main')].filter(Boolean).map(n=>getComputedStyle(n).backgroundColor)")
                check(f"{name}LightSurface{width}", any((lambda values: len(values) >= 3 and sum(values[:3]) / 3 >= 180)([float(v) for v in re.findall(r'\d+(?:\.\d+)?', color)]) for color in surfaces), surfaces)
                if width in (1440, 390):
                    screenshot(page, f"{name}-{width}.png")
        page.locator('[data-action="refresh-integrations"]').click()
        expect(page.locator(".status-grid .badge")).to_have_text("설정됨 · 확인 필요")
        check("settingsConfiguredIsNotVerified", page.locator(".status-grid .badge").all_text_contents() == ["설정됨 · 확인 필요"])
        page.set_viewport_size({"width": 1440, "height": 1000})
        view("studio")
        page.locator('[data-action="new-episode"]').last.click()
        expect(page.locator("#modal")).to_be_visible()
        check("newEpisodeDialogHasTitleLabel", page.locator("#modal label").filter(has_text="에피소드 제목").count() == 1)
        page.locator("#modal-cancel").focus()
        page.keyboard.press("Tab")
        focus = page.evaluate("(()=>{const n=document.activeElement,s=getComputedStyle(n);return {visible:n.matches(':focus-visible'),outline:s.outlineStyle,width:parseFloat(s.outlineWidth),shadow:s.boxShadow}})()")
        check("keyboardFocusVisible", focus["visible"] and ((focus["outline"] != "none" and focus["width"] > 0) or focus["shadow"] != "none"), focus)
        page.locator("#modal-cancel").click()
        expect(page.locator("#modal")).not_to_be_visible()
        page.locator('[data-scene="text"]').fill("Saved white studio copy")
        page.locator("#save-button").click()
        settle()
        view("history")
        expect(page.locator("[data-testid='episode-history-comparison']")).to_contain_text("Saved white studio copy")
        history = json_request(context.request, f"/api/episodes/{episode['id']}/history")
        check("saveHistoryPreservesScenes", history[0]["version"] > history[-1]["version"] and [s["text"] for s in history[0]["snapshot"]["scenes"]] == ["Saved white studio copy", "Preserve scene two"])

        view("studio")
        page.locator('[data-action="add-scene"]').click()
        page.locator('[data-scene="text"]').fill("Unsaved appended scene identity")
        page.locator('[data-action="open-generation"]').click()
        settle()
        expect(page.locator('[data-wf-config="sceneIndex"]')).to_have_value("3")
        check("unsavedAppendedSceneSelectedWithoutSpend", not generation_posts and not run_posts and len(saved_episode()["scenes"]) == 2)
        check("unsafeStudioWorkflowNotReused", page.locator("#wf-select").input_value() == "")
        expect(page.locator("#wf-node-type")).to_have_text("GENERATE")
        expect(page.locator(".generation-connection").first).to_contain_text("설정됨 · 확인 필요")
        check("configuredAvailableDoesNotClaimVerified", "사용 가능" not in page.locator(".generation-connection").first.inner_text())
        prompt = page.locator('[data-wf-config="prompt"]')
        check("generationPromptHasVisibleLabel", "생성 지시문" in prompt.locator("xpath=ancestor::label[1]").inner_text())
        prompt.fill("quote fixture")
        page.locator("details.generation-advanced > summary").click()
        page.locator('[data-wf-param="duration"]').fill("7")
        page.locator('[data-wf-param="aspect_ratio"]').select_option("9:16")
        safe = save_workflow()
        result["workflowId"] = safe["id"]
        generate_id = next(n["id"] for n in safe["nodes"] if n["type"] == "generate")
        expected_input = {"model": "fixture-api-model", "prompt": "quote fixture", "params": {"duration": 7, "aspect_ratio": "9:16"}}
        config = next(n["config"] for n in safe["nodes"] if n["type"] == "generate")
        check("generationModelPromptParamsPersist", {k: config[k] for k in expected_input} == expected_input, config)
        check("safeExistingScriptTrendFreeFiveNodeDraft", [n["type"] for n in safe["nodes"]] == ["script", "storyboard", "generate", "render", "review"] and next(n for n in safe["nodes"] if n["type"] == "script")["config"]["agent"] == "existing" and len(safe["edges"]) == 4)
        check("unsafeSavedWorkflowUnchanged", saved_workflow(unsafe["id"])["nodes"] == unsafe["nodes"])
        open_quote()
        expect(page.locator(".generation-quote")).to_contain_text("1.5 크레딧")
        expect(page.locator(".generation-quote")).to_contain_text("USD 0.0940")
        check("successQuoteExactInputWithoutUnavailableAck", estimate_posts[-1] == expected_input and page.locator('[data-wf-action="estimate-ack"]').count() == 0, estimate_posts[-1])
        screenshot(page, "generation-quote-1440.png")
        cancel_quote()
        check("successfulQuoteCancellationCreatesNoRun", not generation_posts and not run_posts)
        page.locator('[data-wf-config="prompt"]').fill("quote changed after consent cancellation")
        expected_input["prompt"] = "quote changed after consent cancellation"
        save_workflow()
        open_quote()
        check("changedPromptFetchesFreshExactQuote", estimate_posts[-1] == expected_input, estimate_posts[-1])
        cancel_quote()

        estimate_fails = True
        open_quote()
        ack = page.locator('[data-wf-action="estimate-ack"]')
        expect(ack).to_be_visible()
        expect(page.locator('[data-wf-action="confirm-generation-run"]')).to_be_disabled()
        ack.check()
        expect(page.locator('[data-wf-action="confirm-generation-run"]')).to_be_enabled()
        cancel_quote()
        check("failedEstimateRequiresAckThenCancellationNoRun", not generation_posts and not run_posts)
        estimate_fails = False

        # The workflow and episode conflicts reach the REAL server. Both must reject
        # before it creates a run; every non-conflict run is intercepted defensively.
        for changed_kind in ["workflow", "episode"]:
            view("workflow")
            select_workflow(safe["id"], generate_id)
            open_quote()
            quoted_workflow, quoted_episode = saved_workflow(safe["id"]), saved_episode()
            if changed_kind == "workflow":
                json_request(context.request, f"/api/workflows/{safe['id']}", {**quoted_workflow, "name": f"Cross-tab fixture {suffix}", "expectedVersion": quoted_workflow["version"]}, "PUT")
            else:
                json_request(context.request, f"/api/episodes/{episode['id']}", {"title": f"Cross-tab episode fixture {suffix}", "expectedVersion": quoted_episode["version"]}, "PUT")
            before_runs = json_request(context.request, f"/api/workflows/{safe['id']}/runs")
            permit_stale_run = True
            with page.expect_response(lambda response: urlparse(response.url).path == f"/api/workflows/{safe['id']}/run") as rejected:
                page.locator('[data-wf-action="confirm-generation-run"]').click()
            permit_stale_run = False
            settle()
            check(f"stale{changed_kind.title()}QuoteRejected409", rejected.value.status == 409 and json_request(context.request, f"/api/workflows/{safe['id']}/runs") == before_runs, rejected.value.text())
            body = run_posts[-1]["body"]
            check(f"stale{changed_kind.title()}QuoteSentExactVersions", body == {"episodeId": episode["id"], "allowGeneration": True, "expectedWorkflowVersion": quoted_workflow["version"], "expectedEpisodeVersion": quoted_episode["version"]}, body)
            page.reload(wait_until="networkidle")
            view("workflow")
            select_workflow(safe["id"], generate_id)

        # Meaningful new legal edge, not an existing edge or a self-link.
        form = page.locator("#wf-connect-form")
        expect(form).to_have_count(1)
        form.locator("xpath=ancestor::details[1]/summary").click()
        live = saved_workflow(safe["id"])
        script_id = next(n["id"] for n in live["nodes"] if n["type"] == "script")
        review_id = next(n["id"] for n in live["nodes"] if n["type"] == "review")
        assert not any(e["source"] == script_id and e["target"] == review_id for e in live["edges"])
        before_url, before_edges = page.url, form.locator(".wf-connection-list > div").count()
        form.locator('[name="source"]').select_option(script_id)
        form.locator('[name="target"]').select_option(review_id)
        form.locator('button[type="submit"]').click()
        settle()
        check("connectionSubmitAddsEdgeWithoutNavigation", page.url == before_url and page.locator("#wf-connect-form .wf-connection-list > div").count() == before_edges + 1)
        connected = save_workflow()
        check("connectionNewLegalEdgePersisted", any(e["source"] == script_id and e["target"] == review_id for e in connected["edges"]))

        # Stable scene identity follows a LOCAL reorder while editor is mounted.
        view("studio")
        page.locator('[data-action="scene"][data-index="2"]').click()
        page.locator('[data-action="open-generation"]').click()
        settle()
        view("studio")
        page.locator('[data-action="move-left"]').click()
        view("workflow")
        open_quote()
        before = len(run_posts)
        with page.expect_response(lambda response: urlparse(response.url).path == f"/api/workflows/{safe['id']}/run"):
            page.locator('[data-wf-action="confirm-generation-run"]').click()
        settle()
        reordered = saved_episode()
        target = next(s for s in reordered["scenes"] if s["text"] == "Unsaved appended scene identity")
        current = saved_workflow(safe["id"])
        check("liveReorderedSceneUpdatesPersistedGenerateIndex", len(run_posts) == before + 1 and reordered["scenes"][1]["id"] == target["id"] and next(n for n in current["nodes"] if n["type"] == "generate")["config"]["sceneIndex"] == 1)
        check("reorderRunRejectedByFixtureBeforeSpend", run_responses[-1]["status"] == 409 and not generation_posts)
        view("studio")
        page.locator('[data-action="delete-scene"]').click()
        view("workflow")
        before = (len(run_posts), len(estimate_posts))
        page.locator('[data-wf-action="run"]').click()
        settle()
        expect(page.locator("#toast")).to_contain_text("장면을 다시 선택")
        check("deletedStableTargetBlocksBeforeQuoteOrPaidRun", before == (len(run_posts), len(estimate_posts)) and not generation_posts)
        view("studio")

        # Recovery is entirely a provider-boundary fake, linked by the public run
        # output.generationJobId contract. Assert real rendered controls and requests.
        current_episode = saved_episode()
        fixture_job = {"id": "fixture-generation-recovery", "episodeId": episode["id"], "episodeVersion": current_episode["version"],
                       "sceneId": current_episode["scenes"][0]["id"], "model": "fixture-api-model", "providerRequestId": "fixture-provider-request",
                       "status": "polling_failed", "applied": False, "outputs": [], "error": "Fixture polling interrupted"}
        fixture_run = {"id": "fixture-run", "workflowId": safe["id"], "workflowVersion": current["version"], "episodeId": episode["id"],
                       "episodeVersion": current_episode["version"], "status": "failed", "createdAt": datetime.now(timezone.utc).isoformat(),
                       "workflowSnapshot": current, "nodeRuns": [{"nodeId": generate_id, "type": "generate", "status": "failed", "output": {"generationJobId": fixture_job["id"]}}]}

        def recovery_fixture(route):
            path = urlparse(route.request.url).path
            if route.request.method == "POST" and path == f"/api/generations/{fixture_job['id']}/recover":
                fixture_job.update(status="completed", outputs=[{"url": "/api/exports/fixture.mp4", "type": "video"}], error="")
            elif route.request.method == "POST" and path == f"/api/generations/{fixture_job['id']}/apply":
                fixture_job["applied"] = True
            route.fulfill(json=fixture_job)

        page.route("**/api/generations/fixture-generation-recovery**", recovery_fixture)
        page.route(f"**/api/workflows/{safe['id']}/runs", lambda route: route.fulfill(json=[fixture_run]))
        view("workflow")
        select_workflow(safe["id"], generate_id)
        page.locator("[data-wf-action='inspector-tab'][data-tab='results']").click()
        recovery = page.locator("[data-wf-action='recover-generation-job']")
        expect(recovery).to_have_count(1)
        expect(recovery).to_be_visible()
        before = (len(run_posts), len(generation_posts))
        recovery.click()
        apply = page.locator("[data-wf-action='apply-generation-job']")
        expect(apply).to_have_count(1)
        expect(apply).to_be_visible()
        check("recoveryExactlyOnceUsesExistingRequest", recovery_posts == [{"path": f"/api/generations/{fixture_job['id']}/recover", "body": {}}] and before == (len(run_posts), len(generation_posts)), recovery_posts)
        expect(page.locator("[data-testid='generation-recovery']")).to_contain_text("fixture-provider-request")
        apply.click()
        settle()
        expect(page.locator("[data-testid='generation-recovery']")).to_contain_text("적용되었습니다")
        check("applyExactlyOnceUsesCurrentSceneAndVersion", apply_posts == [{"path": f"/api/generations/{fixture_job['id']}/apply", "body": {"expectedVersion": saved_episode()["version"], "sceneId": current_episode["scenes"][0]["id"]}}], apply_posts)
        check("recoveryApplyRetainsOutputWithoutNewSpend", fixture_job["outputs"] == [{"url": "/api/exports/fixture.mp4", "type": "video"}] and before == (len(run_posts), len(generation_posts)) and len(recovery_posts) == 1)
        screenshot(page, "generation-recovery-1440.png")
        check("noGenerationCreateRequests", not generation_posts, generation_posts)
        check("noAcceptedWorkflowRuns", len(run_posts) == len(run_responses) and all(r["status"] == 409 for r in run_responses), run_responses)
        final_state = json_request(context.request, "/api/state")
        check("serverCreatedNoGenerationJobsOrRunsForFixture", not any(job["episodeId"] == episode["id"] for job in final_state["generationJobs"]) and not any(run["episodeId"] == episode["id"] for run in final_state["workflowRuns"]))
        check("noUncaughtBrowserErrors", not result["pageErrors"], result["pageErrors"])
        result["status"] = "passed"
    except Exception as error:
        result["status"] = "failed"
        result["failure"] = str(error)[:2000]
        screenshot(page, "failure.png")
        raise
    finally:
        result["checkCount"] = len(result["checks"])
        RECEIPT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        browser.close()
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
