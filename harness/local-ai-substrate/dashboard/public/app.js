const state = {
  snap: null,
  selectedNode: "llm",
  activeTab: "overview",
  busy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

function toast(msg, isErr = false) {
  const box = $("#toast-box");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function api(url, opt = {}) {
  const r = await fetch(url, {
    ...opt,
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { error: text }; }
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function openModal(title, bodyHtml, buttons) {
  const dlg = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  const foot = $("#modal-foot");
  foot.innerHTML = "";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = b.type || "button";
    btn.className = `btn ${b.cls || "btn-secondary"}`;
    btn.textContent = b.label;
    btn.onclick = async () => {
      try {
        btn.disabled = true;
        await b.onClick?.(dlg);
      } catch (e) {
        toast(e.message || String(e), true);
      } finally {
        btn.disabled = false;
      }
    };
    foot.appendChild(btn);
  }
  dlg.showModal();
}
$("#modal-close").onclick = () => $("#modal").close();

// Tabs
document.querySelectorAll(".tab").forEach(btn => {
  btn.onclick = () => {
    state.activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === btn));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${state.activeTab}`));
  };
});

async function refreshNow(force = true) {
  try {
    const snap = await api(`/api/snapshot${force ? "?force=1" : ""}`);
    applySnapshot(snap);
  } catch (e) {
    toast(`조회 실패: ${e.message}`, true);
  }
}
$("#btn-refresh").onclick = () => refreshNow(true);

function connectSSE() {
  const es = new EventSource("/api/stream");
  const pill = $("#sse-pill");
  es.addEventListener("snapshot", (ev) => {
    pill.textContent = "실시간 SSE 연결됨";
    pill.className = "pill pill-ok";
    try { applySnapshot(JSON.parse(ev.data)); } catch {}
  });
  es.onerror = () => {
    pill.textContent = "재연결 중…";
    pill.className = "pill pill-warn";
  };
}

function applySnapshot(snap) {
  state.snap = snap;
  renderKPIs(snap);
  renderTopology(snap);
  renderBottlenecks(snap);
  renderInspector(snap);
  renderActivity(snap);
  renderSubstrate(snap);
  renderEngines(snap);
  renderJeo(snap);
}

function renderKPIs(snap) {
  const gpu = snap.host?.gpu;
  const qev = snap.host?.engines?.qev;
  const llm = snap.host?.engines?.llm;
  const sub = snap.substrate || {};
  const actors = sub.actors || [];
  const runningActors = actors.filter(a => a.status?.state === "ACTOR_STATE_RUNNING").length;
  const wps = sub.workerpools || [];
  const readyWp = wps.reduce((a, w) => a + (w.readyReplicas || 0), 0);
  const wantWp = wps.reduce((a, w) => a + (w.replicas || 0), 0);
  const vramPct = gpu ? Math.round((gpu.usedMiB / gpu.totalMiB) * 100) : 0;

  $("#kpi-strip").innerHTML = `
    <div class="kpi">
      <div class="kpi-top"><span>GPU VRAM (RTX 2060S)</span><span class="badge ${gpu && gpu.freeMiB < 750 ? "badge-warn" : "badge-ok"}">${gpu ? `${gpu.tempC}°C` : "N/A"}</span></div>
      <div class="kpi-val">${gpu ? `${gpu.usedMiB} / ${gpu.totalMiB} MiB` : "-"}</div>
      <div class="kpi-sub">${gpu ? `여유 ${gpu.freeMiB} MiB (${100 - vramPct}%) · RAM 여유 ${snap.host?.ram?.freeGB ?? "-"} GB` : ""}</div>
    </div>
    <div class="kpi">
      <div class="kpi-top"><span>판단기 qev (:8080)</span><span class="badge ${qev?.online ? "badge-ok" : "badge-crit"}">${esc(qev?.status || "offline")}</span></div>
      <div class="kpi-val">${qev?.nCtxSlot ? `${Math.round(qev.nCtxSlot / 1024)}k ctx` : "-"}</div>
      <div class="kpi-sub">슬롯 ${qev?.slots?.filter(s => s.processing).length || 0}/${qev?.slots?.length || 0} 활성 · ${esc(qev?.flags?.ngl > 0 ? "CUDA" : "CPU")}</div>
    </div>
    <div class="kpi">
      <div class="kpi-top"><span>주력 MoE LLM (:8081)</span><span class="badge ${llm?.online ? "badge-ok" : "badge-crit"}">${esc(llm?.status || "offline")}</span></div>
      <div class="kpi-val">${llm?.nCtxSlot ? `${Math.round(llm.nCtxSlot / 1024)}k × ${llm?.slots?.length || 1}` : "-"}</div>
      <div class="kpi-sub">슬롯 ${llm?.slots?.filter(s => s.processing).length || 0}/${llm?.slots?.length || 0} 활성 · -ncmoe ${llm?.flags?.ncmoe ?? "-"} · ${esc(llm?.flags?.cacheTypeK || "")}</div>
    </div>
    <div class="kpi">
      <div class="kpi-top"><span>Substrate &amp; kagent</span><span class="badge ${sub.kagent?.installed ? "badge-ok" : "badge-accent"}">${sub.kagent?.installed ? "kagent 활성" : "Substrate 활성"}</span></div>
      <div class="kpi-val">Actors ${runningActors}/${actors.length}</div>
      <div class="kpi-sub">WorkerPool ${readyWp}/${wantWp} · 시스템 파드 ${(sub.ateSystemPods || []).filter(p => p.allReady).length}/${(sub.ateSystemPods || []).length}</div>
    </div>
  `;
}

function nodeSeverity(snap, nodeId) {
  const bns = (snap.bottlenecks || []).filter(b => b.nodeId === nodeId);
  if (bns.some(b => b.severity === "critical")) return "crit";
  if (bns.some(b => b.severity === "warn")) return "warn";
  return "ok";
}

function renderTopology(snap) {
  const sub = snap.substrate || {};
  const host = snap.host || {};
  const qev = host.engines?.qev;
  const llm = host.engines?.llm;
  const gpu = host.gpu;
  const actors = sub.actors || [];
  const running = actors.filter(a => a.status?.state === "ACTOR_STATE_RUNNING").length;
  const qevBusy = (qev?.slots || []).some(s => s.processing);
  const llmBusy = (llm?.slots || []).some(s => s.processing);
  const recentMs = Date.now() - 12000;
  const recentFlow = (snap.flowEvents || []).some(e => Date.parse(e.ts) > recentMs);
  const recentEgress = (sub.egressLogs || []).slice(-5);
  const hasDenied = recentEgress.some(e => Number(e.status) === 403);

  const sevColor = (sev, busy = false) => {
    if (sev === "crit") return { stroke: "#b93a2c", fill: "#fdecea", badge: "#b93a2c" };
    if (sev === "warn") return { stroke: "#d98200", fill: "#fff8eb", badge: "#8f5600" };
    if (busy) return { stroke: "#3451e0", fill: "#f2f5ff", badge: "#3451e0" };
    return { stroke: "#cdd3df", fill: "#ffffff", badge: "#1c7350" };
  };

  const nodes = [
    { id: "clients", x: 14, y: 120, w: 165, h: 112, title: "① 에이전트 클라이언트", l1: `윈코드: ${snap.jeo?.discordWincode?.running ? "온라인" : "중지"}`, l2: `kagent: ${sub.kagent?.installed ? sub.kagent.agents.length + "개" : "미설치(탐지대기)"}`, l3: "Live Test / CLI", sev: "ok", busy: recentFlow },
    { id: "substrate", x: 215, y: 120, w: 165, h: 112, title: "② Router · gVisor", l1: `Actors: ${running} 실행 / ${actors.length - running} 대기`, l2: `WorkerPool: ${(sub.workerpools || []).reduce((a, w) => a + (w.readyReplicas || 0), 0)} Ready`, l3: "스냅샷 · 상태보존", sev: nodeSeverity(snap, "substrate") === "crit" ? "crit" : nodeSeverity(snap, "workers"), busy: running > 0 || recentFlow },
    { id: "egress", x: 416, y: 120, w: 158, h: 112, title: "③ atenet-egress", l1: `정책 수: ${Object.keys(sub.egressPolicies || {}).length}개`, l2: "허용: :8080, :8081", l3: hasDenied ? "403 차단 감지!" : "Zero-Trust 정상", sev: hasDenied ? "warn" : "ok", busy: recentFlow || qevBusy || llmBusy },
    { id: "qev", x: 612, y: 34, w: 196, h: 102, title: "④ qev 판단기 (:8080)", l1: `${qev?.online ? "READY" : "OFFLINE"} · 32k ctx`, l2: `활성 슬롯: ${(qev?.slots || []).filter(s => s.processing).length}/${qev?.slots?.length || 0}`, l3: `CUDA FA=${qev?.flags?.flashAttn || "-"}`, sev: nodeSeverity(snap, "qev"), busy: qevBusy },
    { id: "llm", x: 612, y: 204, w: 196, h: 114, title: "⑤ 30B MoE (:8081)", l1: `${llm?.online ? "READY" : "OFFLINE"} · ${Math.round((llm?.nCtxSlot || 0) / 1024)}k×${llm?.slots?.length || 0}`, l2: `활성 슬롯: ${(llm?.slots || []).filter(s => s.processing).length}/${llm?.slots?.length || 0}`, l3: `-ncmoe ${llm?.flags?.ncmoe ?? "-"} · ${llm?.flags?.cacheTypeK || ""}`, sev: nodeSeverity(snap, "llm"), busy: llmBusy },
    { id: "gpu", x: 844, y: 105, w: 186, h: 144, title: "⑥ 호스트 GPU · RAM", l1: gpu ? `VRAM ${gpu.usedMiB}/${gpu.totalMiB}M` : "GPU N/A", l2: gpu ? `여유 ${gpu.freeMiB}M (${gpu.tempC}°C)` : "", l3: `RAM 여유 ${host.ram?.freeGB ?? "-"} GB`, sev: nodeSeverity(snap, "gpu") !== "ok" ? nodeSeverity(snap, "gpu") : nodeSeverity(snap, "host"), busy: qevBusy || llmBusy || (gpu?.utilPct || 0) > 15 },
  ];

  const edgeClass = (active, sev = "ok") => `topo-edge${sev === "crit" ? " crit" : sev === "warn" ? " warn" : active ? " active" : ""}`;

  const svg = `
  <svg class="topology-svg" viewBox="0 0 1044 348" role="img" aria-label="실시간 AI 서빙 토폴로지">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#7c88a1"></path>
      </marker>
    </defs>
    <path class="${edgeClass(running > 0 || recentFlow)}" d="M 179 176 L 215 176" marker-end="url(#arr)" />
    <path class="${edgeClass(running > 0 || recentFlow)}" d="M 380 176 L 416 176" marker-end="url(#arr)" />
    <path class="${edgeClass(qevBusy || recentFlow, nodeSeverity(snap, "qev"))}" d="M 574 156 C 594 156, 592 85, 612 85" marker-end="url(#arr)" />
    <path class="${edgeClass(llmBusy || recentFlow, nodeSeverity(snap, "llm"))}" d="M 574 196 C 594 196, 592 260, 612 260" marker-end="url(#arr)" />
    <path class="${edgeClass(qevBusy, nodeSeverity(snap, "gpu"))}" d="M 808 85 C 826 85, 826 150, 844 150" marker-end="url(#arr)" />
    <path class="${edgeClass(llmBusy, nodeSeverity(snap, "gpu"))}" d="M 808 260 C 826 260, 826 205, 844 205" marker-end="url(#arr)" />
    ${nodes.map(n => {
      const c = sevColor(n.sev, n.busy);
      const selected = state.selectedNode === n.id;
      return `
      <g class="topo-node" data-node="${n.id}" transform="translate(${n.x}, ${n.y})">
        <rect class="box" width="${n.w}" height="${n.h}" rx="12" fill="${c.fill}" stroke="${selected ? "#3451e0" : c.stroke}" stroke-width="${selected ? 2.6 : 1.6}" />
        <text x="12" y="24" font-size="12.5" font-weight="800" fill="#1b2130">${esc(n.title)}</text>
        <circle cx="${n.w - 15}" cy="20" r="5" fill="${c.badge}" />
        <text x="12" y="48" font-size="11.5" font-weight="700" fill="${c.badge}">${esc(n.l1)}</text>
        <text x="12" y="69" font-size="11.5" fill="#485166">${esc(n.l2)}</text>
        <text x="12" y="90" font-size="11" fill="#5b6478">${esc(n.l3)}</text>
      </g>`;
    }).join("")}
  </svg>`;

  const wrap = $("#topology-wrap");
  wrap.innerHTML = svg;
  wrap.querySelectorAll(".topo-node").forEach(g => {
    g.onclick = () => {
      state.selectedNode = g.dataset.node;
      renderTopology(state.snap);
      renderInspector(state.snap);
    };
  });
}

function renderBottlenecks(snap) {
  const bns = snap.bottlenecks || [];
  $("#bn-count").textContent = `${bns.length}건`;
  $("#bn-count").className = `badge ${bns.some(b => b.severity === "critical") ? "badge-crit" : bns.length ? "badge-warn" : "badge-ok"}`;
  if (!bns.length) {
    $("#bottleneck-list").innerHTML = `<div class="bn-card ok"><div class="bn-title">병목 없음 · 모든 경로 정상</div><div class="bn-detail">GPU VRAM 여유 충분, 모든 엔진·Substrate 파드 정상 가동 중</div></div>`;
    return;
  }
  $("#bottleneck-list").innerHTML = bns.map(b => `
    <div class="bn-card ${esc(b.severity)}">
      <div class="bn-title">${esc(b.title)}</div>
      <div class="bn-detail">${esc(b.detail)}</div>
      <div class="bn-hint">해결 팁: ${esc(b.hint)}</div>
    </div>
  `).join("");
}

function renderInspector(snap) {
  const id = state.selectedNode || "llm";
  const titles = { clients: "클라이언트 · 에이전트", substrate: "Substrate Router & Actors", egress: "atenet-egress 방화벽", qev: "qev (:8080)", llm: "30B MoE (:8081)", gpu: "호스트 GPU · RAM · 디스크" };
  $("#inspector-badge").textContent = titles[id] || id;
  const box = $("#node-inspector");
  const h = snap.host || {};
  const sub = snap.substrate || {};

  if (id === "qev" || id === "llm") {
    const eng = h.engines?.[id];
    box.innerHTML = `
      <div class="stack-list">
        <div><b>모델:</b> <code>${esc(eng?.modelId)}</code></div>
        <div><b>상태:</b> <span class="badge ${eng?.online ? "badge-ok" : "badge-crit"}">${esc(eng?.status)}</span> · PID ${esc(eng?.pid ?? "-")} · 슬롯당 ${Math.round((eng?.nCtxSlot || 0) / 1024)}k</div>
        <div><b>옵션:</b> <code>-ngl ${eng?.flags?.ngl} ${id === "llm" ? `-ncmoe ${eng?.flags?.ncmoe}` : ""} -fa ${eng?.flags?.flashAttn} -ctk ${eng?.flags?.cacheTypeK} -c ${eng?.flags?.ctxSize} -np ${eng?.flags?.slots}</code></div>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" id="ins-restart-eng">재기동</button>
          <button class="btn btn-danger btn-sm" id="ins-stop-eng">중지</button>
          <button class="btn btn-secondary btn-sm" id="ins-goto-eng">파라미터 편집 →</button>
        </div>
      </div>`;
    $("#ins-restart-eng").onclick = async () => {
      await api("/api/host/server", { method: "POST", body: JSON.stringify({ kind: id, action: "restart" }) });
      toast(`${id} 재기동 요청됨`);
      setTimeout(() => refreshNow(true), 2500);
    };
    $("#ins-stop-eng").onclick = async () => {
      await api("/api/host/server", { method: "POST", body: JSON.stringify({ kind: id, action: "stop" }) });
      toast(`${id} 중지됨`);
      refreshNow(true);
    };
    $("#ins-goto-eng").onclick = () => document.querySelector('.tab[data-tab="engines"]').click();
    return;
  }

  if (id === "substrate") {
    const actors = sub.actors || [];
    box.innerHTML = `
      <div class="stack-list">
        <div><b>Atespaces:</b> ${(sub.atespaces || []).map(a => `<code>${esc(a)}</code>`).join(", ") || "-"}</div>
        <div><b>Actors:</b> ${actors.map(a => `<div><code>${esc(a.metadata?.atespace)}/${esc(a.metadata?.name)}</code> <span class="badge">${esc(a.status?.state)}</span></div>`).join("") || "없음"}</div>
        <button class="btn btn-secondary btn-sm" onclick="document.querySelector('.tab[data-tab=substrate]').click()">Substrate CRUD 관리 →</button>
      </div>`;
    return;
  }

  if (id === "egress") {
    const eps = Object.entries(sub.egressPolicies || {});
    box.innerHTML = `<div class="stack-list">${eps.map(([k, v]) => `<div><b>${esc(k)}</b>: <code>${esc(JSON.stringify(v.rules || []))}</code></div>`).join("") || "등록된 정책 없음"}</div>`;
    return;
  }

  if (id === "clients") {
    const dc = snap.jeo?.discordWincode || {};
    box.innerHTML = `
      <div class="stack-list">
        <div><b>윈코드 (jeo-code):</b> ${dc.running ? `실행 중 (PID ${dc.pid})` : "중지됨"}</div>
        <div><b>쓰레드 매핑:</b> ${Object.keys(dc.threadModels || {}).length}개</div>
        <div><b>kagent CRDs:</b> ${sub.kagent?.installed ? `설치됨 (Agents ${sub.kagent.agents.length})` : "미설치 (자동 탐지 대기)"}</div>
        <button class="btn btn-secondary btn-sm" onclick="document.querySelector('.tab[data-tab=jeo]').click()">jeo-code 라우팅 설정 →</button>
      </div>`;
    return;
  }

  box.innerHTML = `
    <div class="stack-list">
      <div><b>GPU:</b> ${h.gpu ? `${esc(h.gpu.name)} (${h.gpu.usedMiB}/${h.gpu.totalMiB} MiB, ${h.gpu.tempC}°C)` : "-"}</div>
      <div><b>RAM:</b> 여유 ${h.ram?.freeGB ?? "-"} / ${h.ram?.totalGB ?? "-"} GB</div>
      <div><b>디스크 여유:</b> ${(h.disks || []).map(d => `${d.Name}: ${d.FreeGB}GB`).join(" · ")}</div>
    </div>`;
}

function renderActivity(snap) {
  const rows = [];
  for (const ev of snap.flowEvents || []) {
    rows.push(`<div class="act-row"><span><span class="badge badge-accent">${esc(ev.kind)}</span> <b>${esc(ev.source)} → ${esc(ev.target)}</b> ${esc(ev.detail || "")}</span><span class="mono">${ev.ms ? `${ev.ms}ms` : esc(ev.status)}</span></div>`);
  }
  for (const e of (snap.substrate?.egressLogs || []).slice(-10).reverse()) {
    const ok = Number(e.status) < 400;
    rows.push(`<div class="act-row"><span><span class="badge ${ok ? "badge-ok" : "badge-crit"}">Egress ${esc(e.status)}</span> <code>${esc(e.authority)}${esc(e.path || "")}</code> → ${esc(e.upstream || "")}</span><span class="mono">${esc(e.duration_ms)}ms</span></div>`);
  }
  $("#activity-feed").innerHTML = rows.join("") || `<div class="muted">최근 트래픽 이벤트가 없습니다.</div>`;
}

$("#live-test-form").onsubmit = async (e) => {
  e.preventDefault();
  const out = $("#test-output");
  out.textContent = "실행 중…";
  try {
    const res = await api("/api/host/test", {
      method: "POST",
      body: JSON.stringify({
        target: $("#test-target").value,
        prompt: $("#test-prompt").value,
        maxTokens: Number($("#test-tokens").value || 64),
      }),
    });
    out.textContent = JSON.stringify(res, null, 2);
    refreshNow(true);
  } catch (err) {
    out.textContent = `오류: ${err.message}`;
    toast(err.message, true);
  }
};

// TAB 2: SUBSTRATE CRUD
function renderSubstrate(snap) {
  const sub = snap.substrate || {};
  $("#atespace-list").innerHTML = (sub.atespaces || []).map(ns => `
    <span class="chip">${esc(ns)} <button class="btn btn-ghost btn-sm" data-del-ns="${esc(ns)}" title="삭제">✕</button></span>
  `).join("") || `<span class="muted">없음</span>`;
  $("#atespace-list").querySelectorAll("[data-del-ns]").forEach(b => {
    b.onclick = () => confirmDelete(`Atespace '${b.dataset.delNs}'를 삭제할까요?`, async () => {
      await api(`/api/substrate/atespaces/${encodeURIComponent(b.dataset.delNs)}`, { method: "DELETE" });
      toast("Atespace 삭제됨"); refreshNow(true);
    });
  });

  const ka = sub.kagent || { installed: false, agents: [], teams: [] };
  $("#kagent-panel").innerHTML = ka.installed
    ? `<div><b>kagent 에이전트:</b> ${ka.agents.length}개 · <b>팀:</b> ${ka.teams.length}개</div>`
    : `<div class="sub-banner"><span><b>kagent CRD:</b> 클러스터 미설치 (배포 시 자동 연동 표시)</span><span class="badge badge-muted">Auto-Discovery Ready</span></div>`;

  const wps = sub.workerpools || [];
  $("#workerpool-list").innerHTML = `<table><thead><tr><th>네임스페이스/이름</th><th>클래스</th><th>Replicas</th><th>자원 한도</th><th>조작</th></tr></thead><tbody>${wps.map(w => `
    <tr>
      <td><b>${esc(w.namespace)}/${esc(w.name)}</b></td>
      <td><span class="badge">${esc(w.sandboxClass)}</span></td>
      <td class="mono">${w.readyReplicas ?? 0} / ${w.replicas ?? 0}</td>
      <td class="mono">${esc(w.limits?.cpu || "-")} CPU / ${esc(w.limits?.memory || "-")}</td>
      <td class="btn-row">
        <button class="btn btn-secondary btn-sm" data-edit-wp="${esc(w.namespace)}/${esc(w.name)}">스케일/수정</button>
        <button class="btn btn-danger btn-sm" data-del-wp="${esc(w.namespace)}/${esc(w.name)}">삭제</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">WorkerPool 없음</td></tr>`}</tbody></table>`;

  $("#workerpool-list").querySelectorAll("[data-edit-wp]").forEach(b => {
    const [ns, name] = b.dataset.editWp.split("/");
    const wp = wps.find(x => x.namespace === ns && x.name === name);
    b.onclick = () => openModal(`WorkerPool 수정: ${ns}/${name}`, `
      <div class="form-grid">
        <label>Replicas<input id="m-wp-rep" type="number" min="0" max="16" value="${wp?.replicas ?? 1}" /></label>
        <label>CPU Limit<input id="m-wp-cpu" value="${esc(wp?.limits?.cpu || "1")}" /></label>
        <label>Memory Limit<input id="m-wp-mem" value="${esc(wp?.limits?.memory || "512Mi")}" /></label>
        <label>CPU Request<input id="m-wp-req" value="${esc(wp?.requests?.cpu || "200m")}" /></label>
      </div>`, [
      { label: "취소", onClick: d => d.close() },
      { label: "적용", cls: "btn-primary", onClick: async d => {
        await api(`/api/substrate/workerpools/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: JSON.stringify({ replicas: Number($("#m-wp-rep").value), cpuLimit: $("#m-wp-cpu").value, memLimit: $("#m-wp-mem").value, cpuRequest: $("#m-wp-req").value }),
        });
        toast("WorkerPool 업데이트됨"); d.close(); refreshNow(true);
      }},
    ]);
  });
  $("#workerpool-list").querySelectorAll("[data-del-wp]").forEach(b => {
    const [ns, name] = b.dataset.delWp.split("/");
    b.onclick = () => confirmDelete(`WorkerPool '${ns}/${name}'를 삭제할까요?`, async () => {
      await api(`/api/substrate/workerpools/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("WorkerPool 삭제됨"); refreshNow(true);
    });
  });

  const actors = sub.actors || [];
  $("#actor-list").innerHTML = `<table><thead><tr><th>Actor</th><th>템플릿</th><th>상태</th><th>워커 파드 / IP</th><th>Egress</th><th>조작</th></tr></thead><tbody>${actors.map(a => {
    const ns = a.metadata?.atespace;
    const name = a.metadata?.name;
    const st = a.status?.state || "-";
    const ep = sub.egressPolicies?.[`${ns}/${name}`];
    const running = st === "ACTOR_STATE_RUNNING";
    return `<tr>
      <td><b>${esc(ns)}/${esc(name)}</b></td>
      <td class="mono">${esc(a.template?.atespace || ns)}/${esc(a.template?.name || "-")}</td>
      <td><span class="badge ${running ? "badge-ok" : "badge-muted"}">${esc(st.replace("ACTOR_STATE_", ""))}</span></td>
      <td class="mono">${esc(a.status?.workerPod || "-")} ${(a.status?.workerIps || []).join(",")}</td>
      <td><button class="btn btn-secondary btn-sm" data-ep="${esc(ns)}/${esc(name)}">${ep ? `${ep.rules?.length || 0}규칙 편집` : "정책 추가"}</button></td>
      <td class="btn-row">
        ${running
          ? `<button class="btn btn-secondary btn-sm" data-act="suspend" data-target="${esc(ns)}/${esc(name)}">Suspend</button>`
          : `<button class="btn btn-primary btn-sm" data-act="resume" data-target="${esc(ns)}/${esc(name)}">Resume</button>`}
        <button class="btn btn-secondary btn-sm" data-act="revert" data-target="${esc(ns)}/${esc(name)}">Revert</button>
        <button class="btn btn-secondary btn-sm" data-logs="${esc(ns)}/${esc(name)}">로그</button>
        <button class="btn btn-danger btn-sm" data-del-actor="${esc(ns)}/${esc(name)}">삭제</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">Actor 없음</td></tr>`}</tbody></table>`;

  $("#actor-list").querySelectorAll("[data-act]").forEach(b => {
    const [ns, name] = b.dataset.target.split("/");
    b.onclick = async () => {
      try {
        b.disabled = true;
        await api(`/api/substrate/actors/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${b.dataset.act}`, { method: "POST" });
        toast(`${ns}/${name} ${b.dataset.act} 완료`); refreshNow(true);
      } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
    };
  });
  $("#actor-list").querySelectorAll("[data-logs]").forEach(b => {
    const [ns, name] = b.dataset.logs.split("/");
    b.onclick = async () => {
      const r = await api(`/api/substrate/actors/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/logs`);
      openModal(`Actor 로그: ${ns}/${name}`, `<pre class="code-box">${esc(r.logs || "(로그 없음)")}</pre>`, [{ label: "닫기", onClick: d => d.close() }]);
    };
  });
  $("#actor-list").querySelectorAll("[data-ep]").forEach(b => {
    const [ns, name] = b.dataset.ep.split("/");
    const cur = sub.egressPolicies?.[`${ns}/${name}`]?.rules || [{ http: { hostnames: ["host.docker.internal"], ports: { numbers: [8080, 8081] } } }];
    b.onclick = () => openModal(`EgressPolicy 편집: ${ns}/${name}`, `
      <div class="form-grid">
        <label class="full">Egress Rules (JSON 배열)<textarea id="m-ep-json">${esc(JSON.stringify(cur, null, 2))}</textarea></label>
      </div>`, [
      { label: "정책 삭제", cls: "btn-danger", onClick: async d => { await api(`/api/substrate/egress/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: "DELETE" }); toast("EgressPolicy 삭제됨"); d.close(); refreshNow(true); } },
      { label: "취소", onClick: d => d.close() },
      { label: "저장", cls: "btn-primary", onClick: async d => {
        const rules = JSON.parse($("#m-ep-json").value);
        await api(`/api/substrate/egress/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ rules }) });
        toast("EgressPolicy 저장됨"); d.close(); refreshNow(true);
      }},
    ]);
  });
  $("#actor-list").querySelectorAll("[data-del-actor]").forEach(b => {
    const [ns, name] = b.dataset.delActor.split("/");
    b.onclick = () => confirmDelete(`Actor '${ns}/${name}'를 삭제할까요?`, async () => {
      await api(`/api/substrate/actors/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("Actor 삭제됨"); refreshNow(true);
    });
  });

  const tpls = sub.templates || [];
  $("#template-list").innerHTML = `<table><thead><tr><th>Template</th><th>이미지(다이제스트)</th><th>스냅샷</th><th>조작</th></tr></thead><tbody>${tpls.map(t => {
    const ns = t.metadata?.atespace;
    const name = t.metadata?.name;
    const img = t.containers?.[0]?.image || "-";
    return `<tr>
      <td><b>${esc(ns)}/${esc(name)}</b></td>
      <td class="mono">${esc(img.length > 68 ? img.slice(0, 65) + "…" : img)}</td>
      <td><span class="badge">${esc(t.snapshotConfig?.preferredFidelity || "-")}</span></td>
      <td><button class="btn btn-danger btn-sm" data-del-tpl="${esc(ns)}/${esc(name)}">삭제</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">ActorTemplate 없음</td></tr>`}</tbody></table>`;
  $("#template-list").querySelectorAll("[data-del-tpl]").forEach(b => {
    const [ns, name] = b.dataset.delTpl.split("/");
    b.onclick = () => confirmDelete(`Template '${ns}/${name}'를 삭제할까요?`, async () => {
      await api(`/api/substrate/templates/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("Template 삭제됨"); refreshNow(true);
    });
  });
}

function confirmDelete(msg, fn) {
  openModal("삭제 확인", `<p>${esc(msg)}</p>`, [
    { label: "취소", onClick: d => d.close() },
    { label: "삭제", cls: "btn-danger", onClick: async d => { await fn(); d.close(); } },
  ]);
}

$("#btn-new-atespace").onclick = () => openModal("새 Atespace 생성", `
  <div class="form-grid"><label class="full">이름 (소문자/하이픈)<input id="m-ns-name" placeholder="e.g. research-ai" /></label></div>`, [
  { label: "취소", onClick: d => d.close() },
  { label: "생성", cls: "btn-primary", onClick: async d => {
    await api("/api/substrate/atespaces", { method: "POST", body: JSON.stringify({ name: $("#m-ns-name").value.trim() }) });
    toast("Atespace 생성됨"); d.close(); refreshNow(true);
  }},
]);

$("#btn-new-wp").onclick = () => openModal("새 WorkerPool 생성", `
  <div class="form-grid">
    <label>Namespace<input id="m-nwp-ns" value="local-ai" /></label>
    <label>Pool Name<input id="m-nwp-name" placeholder="e.g. coding-pool" /></label>
    <label>Replicas<input id="m-nwp-rep" type="number" min="0" max="16" value="1" /></label>
    <label>Workload Label<input id="m-nwp-lbl" value="local-ai-agent" /></label>
    <label>CPU Limit<input id="m-nwp-cpu" value="1" /></label>
    <label>Memory Limit<input id="m-nwp-mem" value="512Mi" /></label>
  </div>`, [
  { label: "취소", onClick: d => d.close() },
  { label: "생성", cls: "btn-primary", onClick: async d => {
    await api("/api/substrate/workerpools", { method: "POST", body: JSON.stringify({ namespace: $("#m-nwp-ns").value.trim(), name: $("#m-nwp-name").value.trim(), replicas: Number($("#m-nwp-rep").value), workloadLabel: $("#m-nwp-lbl").value.trim(), cpuLimit: $("#m-nwp-cpu").value.trim(), memLimit: $("#m-nwp-mem").value.trim() }) });
    toast("WorkerPool 생성됨"); d.close(); refreshNow(true);
  }},
]);

$("#btn-new-actor").onclick = () => {
  const sub = state.snap?.substrate || {};
  const tpls = sub.templates || [];
  openModal("새 Actor 생성", `
    <div class="form-grid">
      <label>Atespace<input id="m-na-ns" value="local-ai" /></label>
      <label>Actor Name<input id="m-na-name" placeholder="e.g. agent-2" /></label>
      <label class="full">Template<select id="m-na-tpl">${tpls.map(t => `<option value="${esc(t.metadata?.name)}">${esc(t.metadata?.atespace)}/${esc(t.metadata?.name)}</option>`).join("") || '<option value="local-ai-agent">local-ai-agent</option>'}</select></label>
      <label class="full"><input id="m-na-egress" type="checkbox" checked /> 기본 EgressPolicy 자동 연결 (host.docker.internal:8080,8081)</label>
    </div>`, [
    { label: "취소", onClick: d => d.close() },
    { label: "생성", cls: "btn-primary", onClick: async d => {
      const egressRules = $("#m-na-egress").checked ? [{ http: { hostnames: ["host.docker.internal"], ports: { numbers: [8080, 8081] } } }] : [];
      await api("/api/substrate/actors", { method: "POST", body: JSON.stringify({ atespace: $("#m-na-ns").value.trim(), name: $("#m-na-name").value.trim(), template: $("#m-na-tpl").value, egressRules }) });
      toast("Actor 생성됨"); d.close(); refreshNow(true);
    }},
  ]);
};

$("#btn-new-template").onclick = () => openModal("새 ActorTemplate 생성", `
  <div class="form-grid">
    <label>Atespace<input id="m-nt-ns" value="local-ai" /></label>
    <label>Template Name<input id="m-nt-name" placeholder="e.g. local-ai-agent-v2" /></label>
    <label class="full">Image (@sha256 필수)<input id="m-nt-img" value="localhost:5001/local-ai-agent@sha256:843540812e6e51d280d91b5c60a85eeb473581f802193570f955d9619499c589" /></label>
    <label>Workload Label<input id="m-nt-lbl" value="local-ai-agent" /></label>
    <label>Fidelity<select id="m-nt-fid"><option value="SNAPSHOT_FIDELITY_MEMORY">MEMORY (상태 보존)</option><option value="SNAPSHOT_FIDELITY_VOLUMES">VOLUMES</option></select></label>
  </div>`, [
  { label: "취소", onClick: d => d.close() },
  { label: "생성", cls: "btn-primary", onClick: async d => {
    await api("/api/substrate/templates", { method: "POST", body: JSON.stringify({ atespace: $("#m-nt-ns").value.trim(), name: $("#m-nt-name").value.trim(), image: $("#m-nt-img").value.trim(), workloadLabel: $("#m-nt-lbl").value.trim(), fidelity: $("#m-nt-fid").value }) });
    toast("ActorTemplate 생성됨"); d.close(); refreshNow(true);
  }},
]);

// TAB 3: HOST ENGINES
function renderEngines(snap) {
  const engines = snap.host?.engines || {};
  $("#engines-grid").innerHTML = ["qev", "llm"].map(kind => {
    const e = engines[kind];
    if (!e) return "";
    const f = e.flags || {};
    return `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>${kind === "qev" ? "qev 판단기 (:8080)" : "Qwen3-Coder-30B-A3B MoE (:8081)"} <span class="tip" tabindex="0" data-tip="${kind === "qev" ? "Jev 라우팅·리뷰용 0.8B 결정 모델입니다." : "30.5B MoE 주력 추론 모델입니다. -ncmoe로 RAM 오프로드 레이어 수를 조절해 8GB VRAM 스필을 방지합니다."}">?</span></h2>
          <p class="muted mono">${esc(e.modelId)} · PID ${esc(e.pid ?? "-")}</p>
        </div>
        <span class="badge ${e.online ? "badge-ok" : "badge-crit"}">${esc(e.status)}</span>
      </div>

      <div class="slot-grid">
        ${(e.slots || []).map(s => {
          const pct = s.nCtx ? Math.min(100, Math.round((s.promptTokens / s.nCtx) * 100)) : 0;
          return `<div class="slot-card">
            <div class="kpi-top"><span>Slot #${s.id}</span><span class="badge ${s.processing ? "badge-accent" : "badge-muted"}">${s.processing ? "추론 중" : "대기"}</span></div>
            <div class="mono" style="margin-top:4px;">${s.promptTokens} / ${s.nCtx} tok (캐시 ${s.cachedTokens})</div>
            <div class="prog-track"><div class="prog-fill" style="width:${pct}%"></div></div>
          </div>`;
        }).join("") || `<div class="muted">슬롯 정보 없음 (오프라인)</div>`}
      </div>

      <form class="form-grid" data-eng-form="${kind}">
        <label>총 컨텍스트 (-c)<input name="ctxSize" type="number" step="1024" value="${f.ctxSize ?? 32768}" /></label>
        <label>슬롯 수 (-np)<input name="slots" type="number" min="1" max="8" value="${f.slots ?? 1}" /></label>
        <label>GPU 레이어 (-ngl)<input name="ngl" type="number" min="0" max="99" value="${f.ngl ?? 99}" /></label>
        ${kind === "llm" ? `<label>MoE CPU 레이어 (-ncmoe)<input name="ncmoe" type="number" min="0" max="48" value="${f.ncmoe ?? 48}" /></label>` : `<label>스레드 (-t)<input name="threads" type="number" min="1" max="16" value="${f.threads ?? 4}" /></label>`}
        <label>Flash Attention (-fa)<select name="flashAttn"><option value="on" ${f.flashAttn === "on" ? "selected" : ""}>on</option><option value="auto" ${f.flashAttn === "auto" ? "selected" : ""}>auto</option><option value="off" ${f.flashAttn === "off" ? "selected" : ""}>off</option></select></label>
        <label>KV 캐시 타입 (-ctk/-ctv)<select name="kvType"><option value="q8_0" ${f.cacheTypeK === "q8_0" ? "selected" : ""}>q8_0 (권장)</option><option value="f16" ${f.cacheTypeK === "f16" ? "selected" : ""}>f16</option><option value="q4_0" ${f.cacheTypeK === "q4_0" ? "selected" : ""}>q4_0</option></select></label>
        <label>로딩 모드 (--load-mode)<select name="loadMode"><option value="none" ${f.loadMode === "none" ? "selected" : ""}>none (RAM 사전적재)</option><option value="auto" ${f.loadMode === "auto" ? "selected" : ""}>auto</option></select></label>
        <label>Prometheus --metrics<select name="metricsEnabled"><option value="false" ${!f.metricsEnabled ? "selected" : ""}>끄기</option><option value="true" ${f.metricsEnabled ? "selected" : ""}>켜기</option></select></label>
        <div class="btn-row" style="grid-column:1/-1; margin-top:4px;">
          <button class="btn btn-primary" type="submit">저장 및 재기동</button>
          <button class="btn btn-danger" type="button" data-eng-stop="${kind}">중지</button>
        </div>
      </form>

      <div class="divider"></div>
      <div class="muted" style="margin-bottom:6px;">최근 로그 (${kind}.err.log)</div>
      <pre class="code-box">${esc((e.logTail || []).join("\n"))}</pre>
    </div>`;
  }).join("");

  $("#engines-grid").querySelectorAll("[data-eng-form]").forEach(form => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const kind = form.dataset.engForm;
      const fd = new FormData(form);
      const kv = fd.get("kvType");
      const flags = {
        ctxSize: Number(fd.get("ctxSize")),
        slots: Number(fd.get("slots")),
        ngl: Number(fd.get("ngl")),
        ...(kind === "llm" ? { ncmoe: Number(fd.get("ncmoe")) } : { threads: Number(fd.get("threads")) }),
        flashAttn: fd.get("flashAttn"),
        cacheTypeK: kv,
        cacheTypeV: kv,
        loadMode: fd.get("loadMode"),
        metricsEnabled: fd.get("metricsEnabled") === "true",
      };
      await api("/api/host/server", { method: "POST", body: JSON.stringify({ kind, action: "restart", flags }) });
      toast(`${kind} 설정 저장 및 재기동 시작됨`);
      setTimeout(() => refreshNow(true), 3000);
    };
  });
  $("#engines-grid").querySelectorAll("[data-eng-stop]").forEach(b => {
    b.onclick = async () => {
      await api("/api/host/server", { method: "POST", body: JSON.stringify({ kind: b.dataset.engStop, action: "stop" }) });
      toast(`${b.dataset.engStop} 중지됨`); refreshNow(true);
    };
  });
}

// TAB 4: JEO-CODE & THREAD ROUTING
function renderJeo(snap) {
  const jeo = snap.jeo || {};
  const providers = Object.values(jeo.customProviders || {});
  $("#provider-list").innerHTML = `<table><thead><tr><th>ID</th><th>Endpoint</th><th>기본 모델</th><th>조작</th></tr></thead><tbody>${providers.map(p => `
    <tr>
      <td><b>${esc(p.id)}</b><div class="muted">${esc(p.label)}</div></td>
      <td class="mono">${esc(p.baseUrl)}</td>
      <td class="mono">${esc(p.defaultModel)}</td>
      <td class="btn-row">
        <button class="btn btn-secondary btn-sm" data-test-prov="${esc(p.id)}">프로브</button>
        <button class="btn btn-secondary btn-sm" data-edit-prov="${esc(p.id)}">수정</button>
        <button class="btn btn-danger btn-sm" data-del-prov="${esc(p.id)}">삭제</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="muted">커스텀 프로바이더 없음</td></tr>`}</tbody></table>`;

  $("#provider-list").querySelectorAll("[data-test-prov]").forEach(b => {
    b.onclick = async () => {
      const r = await api(`/api/jeo/providers/${encodeURIComponent(b.dataset.testProv)}/test`, { method: "POST" });
      openModal(`프로바이더 프로브: ${b.dataset.testProv}`, `<pre class="code-box">${esc(r.output)}</pre>`, [{ label: "닫기", onClick: d => d.close() }]);
    };
  });
  $("#provider-list").querySelectorAll("[data-edit-prov]").forEach(b => {
    const p = providers.find(x => x.id === b.dataset.editProv);
    b.onclick = () => openProviderModal(p);
  });
  $("#provider-list").querySelectorAll("[data-del-prov]").forEach(b => {
    b.onclick = () => confirmDelete(`프로바이더 '${b.dataset.delProv}'를 삭제할까요?`, async () => {
      await api(`/api/jeo/providers/${encodeURIComponent(b.dataset.delProv)}`, { method: "DELETE" });
      toast("프로바이더 삭제됨"); refreshNow(true);
    });
  });

  const dc = jeo.discordWincode || {};
  $("#wincode-status").innerHTML = `
    <span><b>윈코드 상태:</b> <span class="badge ${dc.running ? "badge-ok" : "badge-crit"}">${dc.running ? `실행 중 (PID ${dc.pid})` : "중지"}</span> · 기본 모델 <code>${esc(dc.defaultModel)}</code></span>
    <span class="mono">채널: ${(dc.allowedChannelIds || []).join(", ")}</span>`;

  const tm = Object.entries(dc.threadModels || {});
  $("#threadmap-list").innerHTML = `<table><thead><tr><th>Discord Thread ID</th><th>할당 모델</th><th>조작</th></tr></thead><tbody>${tm.map(([tid, mid]) => `
    <tr>
      <td class="mono">${esc(tid)}</td>
      <td class="mono"><b>${esc(mid)}</b></td>
      <td class="btn-row">
        <button class="btn btn-secondary btn-sm" data-edit-tm="${esc(tid)}" data-mid="${esc(mid)}">수정</button>
        <button class="btn btn-danger btn-sm" data-del-tm="${esc(tid)}">삭제</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="3" class="muted">쓰레드 오버라이드 없음</td></tr>`}</tbody></table>`;

  $("#threadmap-list").querySelectorAll("[data-edit-tm]").forEach(b => {
    b.onclick = () => openThreadModal(b.dataset.editTm, b.dataset.mid);
  });
  $("#threadmap-list").querySelectorAll("[data-del-tm]").forEach(b => {
    b.onclick = () => confirmDelete(`쓰레드 매핑 '${b.dataset.delTm}'을 삭제할까요?`, async () => {
      await api(`/api/jeo/thread-models/${encodeURIComponent(b.dataset.delTm)}`, { method: "DELETE" });
      toast("쓰레드 매핑 삭제됨"); refreshNow(true);
    });
  });
}

function openProviderModal(p = null) {
  openModal(p ? `프로바이더 수정: ${p.id}` : "새 커스텀 프로바이더 추가", `
    <div class="form-grid">
      <label>Provider ID<input id="m-p-id" value="${esc(p?.id || "")}" ${p ? "disabled" : ""} placeholder="e.g. local-llm" /></label>
      <label>Label<input id="m-p-lbl" value="${esc(p?.label || "")}" placeholder="Windows Local 30B MoE" /></label>
      <label class="full">Base URL<input id="m-p-url" value="${esc(p?.baseUrl || "http://127.0.0.1:8081/v1")}" /></label>
      <label>Default Model<input id="m-p-def" value="${esc(p?.defaultModel || "qwen3-coder-30b-a3b")}" /></label>
      <label>Models (쉼표 구분)<input id="m-p-mods" value="${esc((p?.models || ["qwen3-coder-30b-a3b"]).join(", "))}" /></label>
    </div>`, [
    { label: "취소", onClick: d => d.close() },
    { label: "저장", cls: "btn-primary", onClick: async d => {
      const id = (p?.id || $("#m-p-id").value).trim();
      await api(`/api/jeo/providers/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ label: $("#m-p-lbl").value.trim(), baseUrl: $("#m-p-url").value.trim(), defaultModel: $("#m-p-def").value.trim(), models: $("#m-p-mods").value }),
      });
      toast("프로바이더 저장됨"); d.close(); refreshNow(true);
    }},
  ]);
}
$("#btn-new-provider").onclick = () => openProviderModal();

function openThreadModal(tid = "", mid = "local-llm/qwen3-coder-30b-a3b") {
  openModal("Discord 쓰레드 모델 바인딩", `
    <div class="form-grid">
      <label class="full">Discord Thread ID<input id="m-tm-tid" value="${esc(tid)}" placeholder="e.g. 1572915955917660180" /></label>
      <label class="full">Model ID<input id="m-tm-mid" value="${esc(mid)}" /></label>
    </div>`, [
    { label: "취소", onClick: d => d.close() },
    { label: "저장", cls: "btn-primary", onClick: async d => {
      await api("/api/jeo/thread-models", { method: "PUT", body: JSON.stringify({ threadId: $("#m-tm-tid").value.trim(), modelId: $("#m-tm-mid").value.trim() }) });
      toast("쓰레드 모델 매핑 저장됨 (윈코드 봇 재기동 필요)"); d.close(); refreshNow(true);
    }},
  ]);
}
$("#btn-new-threadmap").onclick = () => openThreadModal();
$("#btn-restart-wincode").onclick = async () => {
  await api("/api/jeo/messenger/restart", { method: "POST" });
  toast("윈코드 봇 재기동 완료"); setTimeout(() => refreshNow(true), 2000);
};

refreshNow(false);
connectSSE();
