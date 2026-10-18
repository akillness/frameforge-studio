"""Focused trend controls smoke on disposable loopback servers.

Uses manually recorded fixture keywords only. It never clicks the collection action and
rejects any browser request to a non-loopback origin, so no provider or publication work
is invoked. Run with WORKFLOW_STUDIO_URL=http://127.0.0.1:4328 (or 4329) and the optional
WORKFLOW_STUDIO_TOKEN environment variable used by scripts/workflow-browser-smoke.py.
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
RECEIPT = ROOT / os.environ.get("TRENDS_STUDIO_RECEIPT", "artifacts/trends-browser-smoke.json")
RECEIPT.parent.mkdir(parents=True, exist_ok=True)
result = {
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
    "base": BASE,
    "checks": {},
    "pageErrors": [],
    "scope": "Trend status/settings/query/selection/popular/episode controls; manual fixtures only; no collection",
}


def check(name, condition, detail=None):
    assert condition, detail or name
    result["checks"][name] = True


def request(client, path, body=None, method="POST"):
    response = client.fetch(BASE + path, method=method if body is not None else "GET", data=body)
    assert response.ok, f"{method} {path}: {response.status}: {response.text()[:400]}"
    return response.json()


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    context.set_default_timeout(15000)
    page = context.new_page()
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))
    browser_requests = []
    page.on("request", lambda request_item: browser_requests.append((request_item.method, request_item.url)))

    try:
        token = os.environ.get("WORKFLOW_STUDIO_TOKEN")
        if token:
            login = context.request.post(BASE + "/api/login", data={"token": token})
            assert login.ok, f"POST /api/login: {login.status}"

        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        add = lambda keyword, suffix_part: request(context.request, "/api/trends", {
            "keyword": keyword,
            "source": "browser fixture",
            "url": f"https://example.test/trends/{suffix_part}-{suffix}",
        })
        add("Alpha", "alpha-1")
        add("Alpha", "alpha-2")
        add("Beta", "beta")

        retention = request(context.request, "/api/trends/settings", {"retentionMs": 21 * 24 * 60 * 60 * 1000}, method="PUT")
        assert retention["settings"]["retentionMs"] == 21 * 24 * 60 * 60 * 1000
        check("validRetentionSettingAccepted", True)
        page.goto(BASE, wait_until="networkidle")
        page.locator('[data-action="view"][data-view="trends"]').click()
        expect(page.locator("#trend-search-form")).to_be_visible()
        expect(page.locator("#trend-settings-form")).to_be_visible()
        expect(page.locator("span.badge").filter(has_text="자동 수집 꺼짐")).to_be_visible()
        check("statusBadgeDistinguishesDisabledScheduler", True)

        page.locator("#trend-query").fill("Alpha")
        with page.expect_request(lambda req: req.method == "GET" and "/api/trends?" in req.url and "query=Alpha" in req.url) as searched:
            page.locator("#trend-search-form button[type=submit]").click()
        assert "query=Alpha" in searched.value.url, searched.value.url
        rows = page.locator(".data-list .data-row")
        expect(rows).to_have_count(1)
        expect(rows.first).to_contain_text("Alpha")
        check("queryControlFiltersKeywordRows", True)

        select_button = rows.first.locator('[data-action="trend-select"]')
        with page.expect_request(lambda req: req.method == "POST" and req.url.endswith("/api/trends/select")) as selected_request:
            select_button.click()
        selected_body = json.loads(selected_request.value.post_data or "{}")
        assert selected_body == {"keyword": "Alpha", "selected": True}, selected_body
        expect(page.locator('.data-list [data-action="trend-select"][data-keyword="Alpha"]')).to_contain_text("선택 해제")
        check("selectionControlPersistsSelectedState", True)

        popular_button = page.locator('[data-action="trend-popular"][data-query="Alpha"]')
        expect(popular_button).to_be_visible()
        with page.expect_request(lambda req: req.method == "GET" and "/api/trends?" in req.url and "query=Alpha" in req.url) as popular_request:
            popular_button.click()
        assert "query=Alpha" in popular_request.value.url, popular_request.value.url
        expect(page.locator(".data-list .data-row")).to_have_count(1)
        expect(page.locator(".data-list .data-row").first).to_contain_text("Alpha")
        check("popularControlLoadsKeywordQuery", True)

        episode_button = page.locator('.data-list [data-action="trend-episode"]').first
        episode_button.click()
        expect(page.locator("#modal")).to_be_visible()
        expect(page.locator('#modal-form input[name="title"]')).to_have_value("Alpha")
        page.locator("#modal-cancel").click()
        expect(page.locator("#modal")).not_to_be_visible()
        check("aggregateKeywordCanOpenEpisodeComposer", True)

        page.locator('#trend-settings-form input[name="enabled"]').uncheck()
        page.locator('#trend-settings-form input[name="intervalHours"]').fill("2")
        with page.expect_request(lambda req: req.method == "PUT" and req.url.endswith("/api/trends/settings")) as settings_request:
            page.locator("#trend-settings-form button[type=submit]").click()
        settings_body = json.loads(settings_request.value.post_data or "{}")
        assert settings_body == {"enabled": False, "intervalMs": 7200000}, settings_body
        expect(page.locator("span.badge").filter(has_text="자동 수집 꺼짐")).to_be_visible()
        check("settingsControlPersistsSchedulerWithoutCollection", True)

        status = request(context.request, "/api/trends/status", method="GET")
        assert status["settings"]["enabled"] is False
        assert status["settings"]["intervalMs"] == 7200000
        assert status["settings"]["retentionMs"] == 21 * 24 * 60 * 60 * 1000
        assert status["running"] is False
        assert status["activeRunId"] is None
        check("settingsPersistedAndNoRunWasStarted", True)

        collection_posts = [url for method, url in browser_requests if method == "POST" and url.endswith("/api/trends/refresh")]
        assert not collection_posts, collection_posts
        check("collectionActionWasNeverInvoked", True)
        external_requests = [url for _method, url in browser_requests if urlparse(url).hostname not in {"127.0.0.1", "localhost"}]
        assert not external_requests, external_requests
        check("browserMadeNoOutboundProviderRequests", True)
        check("noBrowserPageErrors", not result["pageErrors"], result["pageErrors"])
        result["browserRequests"] = len(browser_requests)
        result["status"] = "passed"
    except Exception as error:
        result["status"] = "failed"
        result["failure"] = str(error)
        raise
    finally:
        RECEIPT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        browser.close()
        print(json.dumps({"status": result.get("status"), "checks": len(result["checks"]), "failure": result.get("failure"), "receipt": str(RECEIPT)}, ensure_ascii=False), flush=True)
