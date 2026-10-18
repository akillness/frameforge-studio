"""Real Chromium workspace gate on disposable loopback 4328 or parent Docker 4329.

Creates only its own fixtures. Layout actions must issue zero API writes; existing
navigation autosave is exercised in a separate phase and may PUT only our episode.
No generation, narration, rendering or agent execution is allowed. This gate does
not replace the existing 101-check browser gate and is not provider evidence.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("WORKSPACE_STUDIO_URL", "http://127.0.0.1:4328").rstrip("/")
parsed = urlparse(BASE)
assert parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port in {4328, 4329} and parsed.path in {"", "/"}, "Only disposable loopback ports 4328/4329 are permitted"
KEY = "frameforge.workspace.v1"
RECEIPT = ROOT / "artifacts/workspace-browser-smoke.json"
SHOTS = ROOT / "docs/assets/workspace"
RECEIPT.parent.mkdir(parents=True, exist_ok=True)
SHOTS.mkdir(parents=True, exist_ok=True)
result = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "base": BASE,
          "checks": {}, "screenshots": [], "requests": [], "fixtureRequests": [],
          "pageErrors": [], "geometry": [], "phase": "initial-navigation",
          "scope": "Actual Chromium with real own server fixtures; no fixture-provider proof, provider/render/agent execution or 101-gate claim"}


def check(name, condition, detail=None):
    assert condition, detail or name
    result["checks"][name] = True
    print(name, flush=True)


def request(client, path, body=None, method="POST"):
    verb = method if body is not None else "GET"
    response = client.fetch(BASE + path, method=verb, data=body)
    assert response.ok, f"{verb} {path}: {response.status}: {response.text()[:400]}"
    if verb != "GET":
        result["fixtureRequests"].append({"method": verb, "path": path, "status": response.status})
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
    pending_chats = []

    def boundary(route):
        req = route.request
        path = urlparse(req.url).path
        if req.method not in {"GET", "HEAD", "OPTIONS"}:
            record = {"method": req.method, "path": path, "body": req.post_data,
                      "phase": result["phase"]}
            result["requests"].append(record)
            if result["phase"] == "intercepted-chat" and req.method == "POST" and path == f'/api/episodes/{episode["id"]}/chat':
                record["disposition"] = "intercepted-success-fixture-never-sent-to-server"
                pending_chats.append(route)
                return
            if result["phase"] == "navigation-autosave" and req.method == "PUT" and path == f'/api/episodes/{episode["id"]}':
                record["disposition"] = "real-own-fixture-autosave"
                route.continue_()
            else:
                record["disposition"] = "blocked-unexpected-write"
                route.fulfill(status=409, json={"error": "Workspace gate forbids this browser write"})
        elif path.startswith("/api/generation/"):
            route.fulfill(status=503, json={"error": "Workspace gate forbids provider discovery"})
        else:
            route.continue_()

    context.route("**/api/**", boundary)

    def settle():
        page.wait_for_load_state("networkidle")

    def select_fixture():
        page.locator(f'[data-action="channel"][data-id="{channel["id"]}"]').click()
        page.locator(f'[data-action="episode"][data-id="{episode["id"]}"]').click()
        expect(page.locator(f'[data-action="episode"][data-id="{episode["id"]}"]')).to_have_class(re.compile("selected"))
        settle()

    def stored():
        return page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)

    def settings():
        page.locator('[data-workspace-action="settings"]').click()
        expect(page.locator("#workspace-settings-dialog")).to_be_visible()

    def close_settings():
        page.locator('[data-workspace-action="close-settings"]').click()
        expect(page.locator("#workspace-settings-dialog")).not_to_be_visible()
        expect(page.locator('[data-workspace-action="settings"]')).to_be_focused()

    def numeric(field, value):
        page.locator(f"#workspace-{field}").fill(str(value))
        page.locator(f"#workspace-{field}").press("Tab")

    def unique_ids(label):
        duplicates = page.locator("[id]").evaluate_all("els => els.map(e => e.id).filter((id, i, ids) => ids.indexOf(id) !== i)")
        check(label, not duplicates, duplicates)

    def no_overflow(label):
        geometry = page.evaluate("""() => [document.documentElement, document.querySelector('#workspace-window'),
            document.querySelector('.workspace-window-content'), ...document.querySelectorAll('.editor-grid, .inspector, .inspector input, .inspector textarea, .inspector select, dialog[open]')]
            .filter(e => e && e.getClientRects().length).map(e => ({name:e.id || e.className || e.tagName, control:['INPUT','SELECT','TEXTAREA'].includes(e.tagName),
            client:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))""")
        # Native inputs/selects scroll their text internally without expanding
        # layout. Their border boxes must fit; containers must also not overflow.
        check(label, all((g["control"] or g["scroll"] <= g["client"] + 1) and g["left"] >= -1 and g["right"] <= page.viewport_size["width"] + 1 for g in geometry), geometry)

    def saved_episode():
        return next(item for item in request(context.request, "/api/state")["episodes"] if item["id"] == episode["id"])

    def assert_local_only(label, baseline):
        settle()
        writes = [r for r in result["requests"] if r["phase"] == "layout"]
        check(label + "ZeroApiWrites", not writes, writes)
        check(label + "EpisodeUnchanged", saved_episode() == baseline)

    def tab_trap(dialog, label):
        targets = dialog.locator('button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], summary').filter(visible=True)
        count = targets.count()
        assert count >= 2
        observations = []
        for key, edge in [("Tab", targets.last), ("Shift+Tab", targets.first)]:
            edge.focus()
            for step in range(count + 2):
                page.keyboard.press(key)
                focus = dialog.evaluate("""e => ({inside:e.contains(document.activeElement), tag:document.activeElement.tagName,
                    id:document.activeElement.id, documentFocused:document.hasFocus(), open:e.open})""")
                observations.append({"key": key, "step": step, **focus})
                assert focus["open"], observations
                if not focus["inside"]:
                    # Native Chromium can hand focus to browser chrome at a tab
                    # boundary. BODY with an unfocused document is not an app
                    # control receiving focus; the next key must reenter modal.
                    assert focus["tag"] == "BODY" and not focus["documentFocused"], observations
                    page.keyboard.press(key)
                    expect(dialog).to_be_visible()
                    assert dialog.evaluate("e => e.contains(document.activeElement)"), observations
                    observations[-1]["reenteredOnNextKey"] = True
        background = page.locator("#workspace-template")
        background.evaluate("e => e.focus()")
        assert not background.evaluate("e => e === document.activeElement"), "Inert background accepted programmatic focus"
        assert dialog.evaluate("e => e.open && e.contains(document.activeElement)"), "Programmatic background focus displaced modal focus"
        result.setdefault("nativeFocusObservations", {})[label] = observations
        result["nativeFocusLimitation"] = "Native showModal may focus browser chrome (BODY, document.hasFocus=false), with next-key modal reentry; strict always-inside DOM wrapping is not claimed and no custom trap is installed."
        check(label + "KeyboardNeverFocusesUnderlyingAppAndReentersModal", all(o["inside"] or o.get("reenteredOnNextKey") for o in observations))
        check(label + "ProgrammaticBackgroundFocusBlocked", True)

    def repaint_with_focus(field, text, label):
        field.fill(text)
        field.focus()
        field.evaluate("e => e.setSelectionRange(3, 10)")
        old = field.element_handle()
        # A real existing GET refresh induces app render without shifting focus to
        # its hidden button. This models an asynchronous repaint while modal.
        with page.expect_response(lambda r: "/api/speech/" in r.url and r.request.method == "GET"):
            page.locator('[data-action="refresh-speech"]').dispatch_event("click")
        page.wait_for_function("old => !old.isConnected", arg=old)
        expect(field).to_have_value(text)
        expect(field).to_be_focused()
        check(label + "CaretRetained", field.evaluate("e => [e.selectionStart,e.selectionEnd]") == [3, 10])
        expect(page.locator("#workspace-tool-dialog")).to_be_visible()
        check(label + "RepaintRetainedOpenDialogAndDraft", True)

    try:
        token = os.environ.get("WORKSPACE_STUDIO_TOKEN")
        if token:
            login = context.request.post(BASE + "/api/login", data={"token": token})
            assert login.ok, f"POST /api/login: {login.status}"
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        channel = request(context.request, "/api/channels", {"name": f"Workspace fixture {suffix}", "category": "information", "platform": "youtube"})
        episode = request(context.request, "/api/episodes", {"channelId": channel["id"], "title": f"Workspace episode {suffix}", "topic": "Layout changes stay browser-local", "category": "information"})
        first = dict(episode["scenes"][0], title="Workspace scene one", text="Saved scene one")
        second = dict(first, id=first["id"] + "-two", title="Workspace scene two", text="Saved scene two")
        episode = request(context.request, f'/api/episodes/{episode["id"]}', {"expectedVersion": episode["version"], "scenes": [first, second]}, "PUT")
        other_episode = request(context.request, "/api/episodes", {"channelId": channel["id"], "title": f"Workspace other episode {suffix}", "topic": "Clean episode navigation", "category": "information"})
        baseline = episode.copy()
        result.update(channelId=channel["id"], episodeId=episode["id"])
        page.goto(BASE, wait_until="networkidle")
        select_fixture()
        result["phase"] = "layout"
        expect(page.locator("#workspace-template")).to_be_visible()

        for viewport in [320, 390, 768, 1440]:
            page.set_viewport_size({"width": viewport, "height": 1000})
            for preset, width, height, tools in [("auto", None, None, "docked"), ("compact", 1024, 768, "overlay"), ("standard", 1280, 800, "docked"), ("wide", 1600, 900, "docked"), ("focus", 1280, 800, "overlay")]:
                label = f"{viewport}-{preset}"
                page.locator("#workspace-template").select_option(preset)
                expect(page.locator(".personal-workspace")).to_have_attribute("data-workspace-tool-mode", tools)
                layout = stored()["layout"]
                check(label + "DesiredDimensions", [layout["width"], layout["height"]] == [width, height])
                page.wait_for_function("() => document.querySelector('#workspace-dimension-status').textContent.includes('실제')")
                geometry = page.evaluate("""() => {const n=document.querySelector('#workspace-window'),r=n.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,shell:document.querySelector('.personal-workspace').clientWidth,available:parseFloat(n.style.getPropertyValue('--workspace-available-height'))}}""")
                result["geometry"].append({"viewport": viewport, "preset": preset, **geometry, "desiredWidth": width, "desiredHeight": height})
                if width is not None:
                    check(label + "ActualClamp", abs(geometry["width"] - min(width, geometry["shell"])) <= 1 and abs(geometry["height"] - min(height, geometry["available"])) <= 1, geometry)
                else:
                    check(label + "ActualAutoFit", geometry["width"] <= geometry["shell"] + 1 and geometry["width"] > 0, geometry)
                status = page.locator("#workspace-dimension-status").inner_text()
                check(label + "ActualDimensionsAnnounced", f'실제 {round(geometry["width"])} × {round(geometry["height"])}' in status, status)
                no_overflow(label + "NoHorizontalOverflow")
                screenshot(page, label + ".png")
            settings()
            tab_trap(page.locator("#workspace-settings-dialog"), str(viewport) + "Settings")
            no_overflow(str(viewport) + "SettingsNoOverflow")
            page.keyboard.press("Escape")
            expect(page.locator("#workspace-settings-dialog")).not_to_be_visible()
            expect(page.locator('[data-workspace-action="settings"]')).to_be_focused()
            check(str(viewport) + "SettingsEscapeRestoresOpener", True)
            settings()
            close_settings()
        page.locator("#workspace-template").select_option("wide")
        desired_wide = stored()["layout"]
        page.set_viewport_size({"width": 320, "height": 1000})
        page.wait_for_function("() => document.querySelector('#workspace-window').getBoundingClientRect().width < 320")
        narrow_width = page.locator("#workspace-window").bounding_box()["width"]
        check("DesiredWideDimensionsSurviveNarrowViewport", stored()["layout"] == desired_wide)
        page.set_viewport_size({"width": 1440, "height": 1000})
        page.wait_for_function("() => document.querySelector('#workspace-window').getBoundingClientRect().width > 1000")
        check("WideningRestoresActualAreaWithoutChangingDesiredLayout", stored()["layout"] == desired_wide and page.locator("#workspace-window").bounding_box()["width"] > narrow_width)

        page.locator("#workspace-template").select_option("compact")
        settings()
        numeric("width", 1107)
        numeric("height", 631)
        numeric("inspector-width", 361)
        page.locator("#workspace-tools-mode").select_option("docked")
        check("NumericControlsApplyAllDimensions", stored()["layout"] == {"presetId": "custom", "width": 1107, "height": 631, "inspectorWidth": 361, "toolsMode": "docked"})
        close_settings()
        handle = page.locator(".workspace-resize-handle")
        handle.focus()
        handle.press("ArrowRight")
        handle.press("Shift+ArrowDown")
        check("KeyboardResizeUsesFineAndCoarseSteps", [stored()["layout"]["width"], stored()["layout"]["height"]] == [1123, 695])
        handle.scroll_into_view_if_needed()
        before = page.locator("#workspace-window").bounding_box()
        box = handle.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] + box["width"] / 2 + 43, box["y"] + box["height"] / 2 - 29, steps=5)
        page.mouse.up()
        layout = stored()["layout"]
        check("PointerResizeCommitsActualStartPlusDelta", [layout["width"], layout["height"]] == [round(before["width"] + 43), round(before["height"] - 29)], layout)
        screenshot(page, "resized-desktop.png")
        # An untouched axis must retain its desired size even when its rendered
        # area is clamped by a narrow or short viewport.
        for axis, dx, dy, viewport in [("Vertical", 0, -37, {"width": 390, "height": 700}), ("Horizontal", -41, 0, {"width": 1440, "height": 700})]:
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.locator("#workspace-template").select_option("wide")
            desired = stored()["layout"]
            page.set_viewport_size(viewport)
            handle.scroll_into_view_if_needed()
            actual = page.locator("#workspace-window").bounding_box()
            box = handle.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + dx, y + dy, steps=5)
            page.mouse.up()
            updated = stored()["layout"]
            expected = [desired["width"], round(actual["height"] + dy)] if dy else [round(actual["width"] + dx), desired["height"]]
            check(axis + "OnlyPointerResizePreservesOtherDesiredAxisUnderClamp", [updated["width"], updated["height"]] == expected, {"actual": actual, "desired": desired, "updated": updated})
        page.set_viewport_size({"width": 1440, "height": 1000})

        page.locator("#workspace-template").select_option("focus")
        panels = {"inspector": '.right-column .inspector', "narration": '.narration-panel', "assistant": '#chat-form'}
        for tool, selector in panels.items():
            opener = page.locator(f'[data-workspace-tool="{tool}"]')
            panel = page.locator(selector).element_handle()
            if tool == "assistant":
                panel = panel.evaluate_handle("e => e.closest('section.panel')")
            opener.click()
            dialog = page.locator("#workspace-tool-dialog")
            expect(dialog).to_be_visible()
            check(tool + "MovesExistingDomRatherThanClone", panel.evaluate("e => document.querySelector('#workspace-tool-body').contains(e)"))
            unique_ids(tool + "UniqueDomIds")
            tab_trap(dialog, tool)
            screenshot(page, "overlay-" + tool + ".png")
            page.keyboard.press("Escape")
            expect(dialog).not_to_be_visible()
            expect(opener).to_be_focused()
            check(tool + "RestoresOriginalDom", panel.evaluate("e => e.isConnected && !!e.closest('.right-column')"))
            opener.click()
            page.locator('[data-workspace-action="close-tool"]').click()
            expect(opener).to_be_focused()
            check(tool + "CloseButtonRestoresFocus", True)

        page.locator('[data-workspace-tool="narration"]').click()
        narration_refresh = page.locator('[data-action="refresh-speech"]')
        narration_refresh.focus()
        old_narration = page.locator(".narration-panel").element_handle()
        with page.expect_response(lambda r: "/api/speech/" in r.url and r.request.method == "GET"):
            narration_refresh.dispatch_event("click")
        page.wait_for_function("old => !old.isConnected", arg=old_narration)
        expect(page.locator("#workspace-tool-dialog")).to_be_visible()
        narration_focus = page.locator("#workspace-tool-dialog").evaluate("e => ({inside:e.contains(document.activeElement), action:document.activeElement.dataset.action || document.activeElement.dataset.workspaceAction})")
        result["narrationRepaintFocus"] = narration_focus
        # A button has no editable caret to restore. Native modal initial focus
        # may move to Close; it must not move into the underlying application.
        check("NarrationRepaintRetainsOpenModalAndContainedFocus", narration_focus["inside"], narration_focus)
        page.keyboard.press("Escape")
        expect(page.locator("#workspace-tool-dialog")).not_to_be_visible()
        expect(page.locator('[data-workspace-tool="narration"]')).to_be_focused()
        result["narrationCaretScope"] = "Real voice service is unavailable; narration has no enabled text-editable field. Focus/repaint/Escape exercised on its enabled refresh control; caret exercised on inspector and assistant textareas."

        page.locator('[data-workspace-tool="inspector"]').click()
        text = page.locator('[data-scene="text"]')
        text.fill("Local scene draft survives overlays")
        page.keyboard.press("Escape")
        page.locator('[data-workspace-tool="inspector"]').click()
        expect(text).to_have_value("Local scene draft survives overlays")
        repaint_with_focus(text, "Local scene draft survives repaint", "Inspector")
        expect(page.locator("#preview .scene-text")).to_have_text("Local scene draft survives repaint")
        page.keyboard.press("Escape")
        page.locator('[data-workspace-tool="assistant"]').click()
        repaint_with_focus(page.locator('#chat-form textarea[name="message"]'), "Unsubmitted assistant draft retained", "Assistant")
        page.keyboard.press("Escape")
        assert_local_only("DraftAndToolActions", baseline)

        settings()
        page.locator("#workspace-profile-name").fill("  Profile A  ")
        page.locator('[data-workspace-action="save-profile"]').click()
        a = stored()["activeProfileId"]
        layout_a = stored()["layout"]
        close_settings()
        page.locator("#workspace-template").select_option("wide")
        settings()
        numeric("inspector-width", 421)
        page.locator("#workspace-profile-name").fill("Profile B")
        page.locator('[data-workspace-action="save-profile"]').click()
        b = stored()["activeProfileId"]
        layout_b = stored()["layout"]
        page.locator("#workspace-profile-select").select_option(a)
        check("ProfileARestoresIsolatedLayout", stored()["layout"] == layout_a)
        numeric("width", 1391)
        page.locator("#workspace-profile-select").select_option(b)
        check("ProfileBRestoresIsolatedLayout", stored()["layout"] == layout_b)
        page.locator("#workspace-profile-select").select_option(a)
        check("EditingSelectedProfileDidNotMutateSnapshot", stored()["layout"] == layout_a)
        payload = '<img src=x onerror=alert(1)>'
        page.evaluate("() => {window.__workspaceXss = false; window.alert = () => {window.__workspaceXss = true}}")
        page.locator("#workspace-profile-name").fill(payload)
        page.locator('[data-workspace-action="save-profile"]').click()
        expect(page.locator("#workspace-profile-select option").last).to_have_text(payload)
        check("XssProfileRenderedAsTextNotMarkupOrExecution", page.locator("#workspace-settings-dialog img").count() == 0 and not page.evaluate("window.__workspaceXss"))
        page.locator("#workspace-profile-select").select_option(b)
        close_settings()
        assert_local_only("Profiles", baseline)
        # Reload is not a layout action; real beforeunload is accepted to discard
        # only this gate's unsaved scene draft, never someone else's work.
        page.on("dialog", lambda dialog: dialog.accept() if dialog.type == "beforeunload" else dialog.dismiss())
        page.reload(wait_until="networkidle")
        select_fixture()
        settings()
        check("ProfileSelectionSurvivesReload", stored()["activeProfileId"] == b and stored()["layout"] == layout_b)
        expect(page.locator("#workspace-profile-select")).to_have_value(b)
        page.locator('[data-workspace-action="reset"]').click()
        check("ResetKeepsBothNamedProfiles", [p["name"] for p in stored()["profiles"]][:2] == ["Profile A", "Profile B"] and stored()["activeProfileId"] is None)
        expect(page.locator("#workspace-template")).to_have_value("auto")
        page.locator("#workspace-profile-select").select_option(a)
        check("ResetPreservesSelectableProfileSnapshot", stored()["layout"] == layout_a)
        screenshot(page, "profiles.png")
        close_settings()

        saved_storage = page.evaluate("key => localStorage.getItem(key)", KEY)
        page.evaluate("""() => {window.__workspaceSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('workspace quota fixture','QuotaExceededError')}}""")
        try:
            page.locator("#workspace-template").select_option("compact")
            expect(page.locator(".personal-workspace")).to_have_attribute("data-workspace-tool-mode", "overlay")
            settings()
            expect(page.locator("#workspace-storage-status")).to_contain_text("현재 세션")
            check("StorageFailureHasExplicitNoticeAndLiveSession", page.locator("#workspace-template").input_value() == "compact" and page.evaluate("key => localStorage.getItem(key)", KEY) == saved_storage)
            screenshot(page, "storage-failure.png")
            close_settings()
        finally:
            page.evaluate("Storage.prototype.setItem=window.__workspaceSetItem;delete window.__workspaceSetItem")
        page.locator("#workspace-template").select_option("standard")
        assert_local_only("AllLayoutActions", baseline)

        # Clean fixture navigation is independent of dirty-navigation autosave.
        result["phase"] = "clean-navigation"
        for target in [other_episode, episode, other_episode, episode]:
            page.locator(f'[data-action="episode"][data-id="{target["id"]}"]').click()
            expect(page.locator(f'[data-action="episode"][data-id="{target["id"]}"]')).to_have_class(re.compile("selected"))
            expect(page.locator("#preview .scene-text")).to_have_text(target["scenes"][0]["text"])
        check("SwitchingBetweenTwoCleanEpisodesUpdatesPreviewBothDirections", not [r for r in result["requests"] if r["phase"] == "clean-navigation"])

        # Modal backgrounds are inert to real pointer input. Dispatch an actual
        # app navigation event to test teardown when another navigation source
        # acts while open; do not claim a user can click an inert background.
        page.locator('[data-workspace-tool="assistant"]').click()
        page.locator('[data-action="scene"][data-index="1"]').dispatch_event("click")
        expect(page.locator("#workspace-tool-dialog")).not_to_be_visible()
        expect(page.locator('[data-action="scene"][data-index="1"]')).to_have_class(re.compile("selected"))
        check("NavigationWhileModalOpenClosesSafely", True)
        unique_ids("NavigationUniqueDomIds")
        check("CleanModalNavigationMakesNoWrites", not [r for r in result["requests"] if r["phase"] == "clean-navigation"])

        # Existing dirty-navigation autosave is deliberately separate from all
        # layout checks, and its real write can target only our own fixture.
        result["phase"] = "navigation-autosave"
        page.locator('[data-scene="text"]').fill("Own fixture navigation autosave baseline")
        with page.expect_response(lambda r: r.request.method == "PUT" and urlparse(r.url).path == f'/api/episodes/{episode["id"]}') as response:
            page.locator('.nav [data-action="view"][data-view="templates"]').click()
        check("ExistingNavigationAutosaveSucceedsSeparately", response.value.ok)
        expect(page.locator('.personal-workspace')).to_have_attribute("data-workspace-view", "templates")
        autosaves = [r for r in result["requests"] if r["phase"] == "navigation-autosave"]
        check("BaselineAutosaveOnlyTouchesOwnFixture", len(autosaves) == 1 and autosaves[0]["disposition"] == "real-own-fixture-autosave", autosaves)
        check("BaselineAutosavePersistsRealSceneEdit", saved_episode()["scenes"][1]["text"] == "Own fixture navigation autosave baseline")
        select_fixture()

        # A single intercepted success fixture is reused for the three mutually
        # exclusive response states. No /chat request reaches any real agent.
        result["phase"] = "intercepted-chat"
        page.locator("#workspace-template").select_option("focus")
        chat_path = f'/api/episodes/{episode["id"]}/chat'
        chat_message = page.locator('#chat-form textarea[name="message"]')

        def submit_pending_chat(message):
            page.locator('[data-workspace-tool="assistant"]').click()
            chat_message.fill(message)
            with page.expect_request(lambda req: req.method == "POST" and urlparse(req.url).path == chat_path):
                page.locator('#chat-form button[type="submit"]').click()
            page.wait_for_function("() => document.querySelector('#chat-form button[type=submit]').disabled")
            assert len(pending_chats) == 1, "The success fixture must intercept exactly the submitted request"

        def complete_chat(payload):
            pending_chats.pop().fulfill(status=200, json=payload)
            expect(page.locator("#chat-log")).to_contain_text(payload["message"])

        submit_pending_chat("Just submitted message must clear")
        complete_chat({"message": "Intercepted success: submitted message accepted"})
        expect(page.locator("#workspace-tool-dialog")).to_be_visible()
        expect(chat_message).to_have_value("")
        check("SuccessfulOverlayChatClearsOnlyJustSubmittedText", True)
        page.keyboard.press("Escape")

        submit_pending_chat("Earlier submitted message")
        newer_draft = "Newer unsent text survives earlier chat success"
        chat_message.fill(newer_draft)
        chat_message.evaluate("e => e.setSelectionRange(4, 12)")
        complete_chat({"message": "Intercepted success: earlier request finished"})
        expect(page.locator("#workspace-tool-dialog")).to_be_visible()
        expect(chat_message).to_have_value(newer_draft)
        expect(chat_message).to_be_focused()
        check("SuccessfulOverlayChatPreservesNewerUnsentTextAndCaret", chat_message.evaluate("e => [e.selectionStart,e.selectionEnd]") == [4, 12])
        page.keyboard.press("Escape")

        submit_pending_chat("Replace scene identity while inspector is open")
        page.keyboard.press("Escape")
        page.locator('[data-workspace-tool="inspector"]').click()
        old_title = page.locator('[data-scene="title"]').input_value()
        old_text = page.locator('[data-scene="text"]').input_value()
        replacement = saved_episode()
        replacement["version"] += 1
        replacement["scenes"] = [dict(replacement["scenes"][0], id="workspace-fixture-new-scene", title="Fresh response scene identity", text="New preview must match new inspector", narration="New response narration, never old snapshot")]
        complete_chat({"message": "Intercepted success: scene identity replaced", "episode": replacement})
        expect(page.locator("#preview .scene-text")).to_have_text(replacement["scenes"][0]["text"])
        expect(page.locator('.scene-card.selected')).to_have_attribute("data-scene-id", replacement["scenes"][0]["id"])
        expect(page.locator("#workspace-tool-dialog")).not_to_be_visible()
        page.locator('[data-workspace-tool="inspector"]').click()
        expect(page.locator('[data-scene="title"]')).to_have_value(replacement["scenes"][0]["title"])
        expect(page.locator('[data-scene="text"]')).to_have_value(replacement["scenes"][0]["text"])
        expect(page.locator('[data-scene="narration"]')).to_have_value(replacement["scenes"][0]["narration"])
        check("NewSceneIdentityCannotReplayOldInspectorFieldsOverNewPreview", old_title != replacement["scenes"][0]["title"] and old_text != replacement["scenes"][0]["text"])
        unique_ids("SceneReplacementUniqueDomIds")
        screenshot(page, "new-scene-context.png")
        page.keyboard.press("Escape")
        # Combined regression: the submitted assistant request resolves with the same episode
        # identity but new scene IDs while a newer unsent draft and caret are still active.
        combined_submitted = "Assistant request with scene replacement"
        submit_pending_chat(combined_submitted)
        combined_draft = "Newer assistant draft survives scene identity replacement"
        chat_message.fill(combined_draft)
        chat_message.focus()
        chat_message.evaluate("e => e.setSelectionRange(7, 15)")
        combined_replacement = saved_episode()
        combined_replacement["version"] += 2
        combined_replacement["scenes"] = [dict(combined_replacement["scenes"][0], id="workspace-fixture-combined-scene", title="Combined response scene identity", text="Combined response preview must match", narration="Combined response narration, never stale inspector")]
        complete_chat({"message": "Intercepted success: assistant draft and scene identity replaced", "episode": combined_replacement})
        expect(page.locator("#workspace-tool-dialog")).to_be_visible()
        expect(chat_message).to_have_value(combined_draft)
        expect(chat_message).to_be_focused()
        expect(page.locator("#preview .scene-text")).to_have_text(combined_replacement["scenes"][0]["text"])
        expect(page.locator('.scene-card.selected')).to_have_attribute("data-scene-id", combined_replacement["scenes"][0]["id"])
        check("AssistantOverlayPreservesNewerDraftCaretAcrossSceneIdentityReplacement", chat_message.evaluate("e => [e.selectionStart,e.selectionEnd]") == [7, 15] and combined_replacement["id"] == episode["id"] and combined_replacement["scenes"][0]["id"] != replacement["scenes"][0]["id"])
        screenshot(page, "assistant-scene-replacement.png")
        page.keyboard.press("Escape")

        chats = [r for r in result["requests"] if r["phase"] == "intercepted-chat"]
        check("ChatControlRequestsWereInterceptedNotRealProviderCalls", len(chats) == 4 and all(r["path"] == chat_path and r["disposition"] == "intercepted-success-fixture-never-sent-to-server" for r in chats) and not pending_chats, chats)
        result["interceptedChatSuccessFixture"] = {"handlers": 1, "requests": len(chats), "realChatRequests": 0, "scope": "UI response regression only, no provider/agent integration proof"}

        # Corrupt active-profile identity must not falsely label a different
        # layout selected after browser hydration; the saved profile still works.
        result["phase"] = "hydration"
        incoherent = stored()
        selected_profile = next(p for p in incoherent["profiles"] if p["id"] == a)
        incoherent["activeProfileId"] = a
        incoherent["layout"] = dict(selected_profile["layout"], width=selected_profile["layout"]["width"] + 113, presetId="custom")
        page.evaluate("([key,value]) => localStorage.setItem(key, JSON.stringify(value))", [KEY, incoherent])
        page.reload(wait_until="networkidle")
        select_fixture()
        settings()
        expect(page.locator("#workspace-profile-select")).to_have_value("")
        expect(page.locator("#workspace-width")).to_have_value(str(incoherent["layout"]["width"]))
        page.locator("#workspace-profile-select").select_option(a)
        check("HydrationClearsIncoherentActiveProfileWithoutLosingLayoutOrSnapshot", stored()["activeProfileId"] == a and stored()["layout"] == selected_profile["layout"])
        close_settings()
        check("HydrationMakesNoApiWrites", not [r for r in result["requests"] if r["phase"] == "hydration"])
        result["phase"] = "final"
        screenshot(page, "final-workspace.png")
        check("NoUnexpectedBrowserApiWrites", not [r for r in result["requests"] if r["disposition"] == "blocked-unexpected-write"], result["requests"])
        check("NoBrowserPageErrors", not result["pageErrors"], result["pageErrors"])
        result["layoutApiWriteCount"] = len([r for r in result["requests"] if r["phase"] == "layout"])
        result["navigationAutosaveWriteCount"] = len(autosaves)
        result["status"] = "passed"
    except Exception as error:
        result["status"] = "failed"
        result["failure"] = str(error)[:4000]
        screenshot(page, "failure.png")
        raise
    finally:
        result["checkCount"] = len(result["checks"])
        RECEIPT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        browser.close()
        print(json.dumps({"status": result.get("status"), "checkCount": result["checkCount"], "failure": result.get("failure"), "receipt": str(RECEIPT)}, ensure_ascii=False), flush=True)
