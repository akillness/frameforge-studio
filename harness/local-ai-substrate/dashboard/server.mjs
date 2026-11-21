import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.SUBSTRA_DASH_PORT || 8095);
const HOST = process.env.SUBSTRA_DASH_HOST || "127.0.0.1";
const PUBLIC_DIR = path.resolve("D:/local-ai-substrate/dashboard/public");

const QEV_CMD = "E:/llama-cpp-cuda/start-qev-server.cmd";
const LLM_CMD = "E:/llama-cpp-cuda/start-llm-server.cmd";
const QEV_ERR_LOG = "E:/llama-cpp-cuda/qev.err.log";
const LLM_ERR_LOG = "E:/llama-cpp-cuda/llm.err.log";
const JEO_CFG = "C:/Users/bangg/.jeo/config.json";
const WINCODE_CFG = "C:/Users/bangg/.jeo/discord-wincode-1567081884213706762/config.json";
const WINCODE_START = "C:/Users/bangg/.jeo/discord-wincode-1567081884213706762/start.ps1";

const FLOW_EVENTS = [];
function pushFlowEvent(ev) {
  FLOW_EVENTS.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toISOString(), ...ev });
  if (FLOW_EVENTS.length > 40) FLOW_EVENTS.length = 40;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function runCmd(bin, args, timeout = 25000) {
  const { stdout, stderr } = await execFileAsync(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
}

async function runWslPy(pyScript, args = [], timeout = 35000) {
  return runCmd("wsl", ["-d", "Ubuntu", "-u", "root", "--", "python3", "-c", pyScript, ...args], timeout);
}

async function fetchJsonSafe(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function readTail(filePath, lines = 30) {
  try {
    const txt = await fs.readFile(filePath, "utf-8");
    return txt.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function parseCmdFlags(cmdText) {
  const get = (flag, def = null) => {
    const m = cmdText.match(new RegExp(`(?:^|\\s)${flag}\\s+("([^"]+)"|\\S+)`));
    return m ? (m[2] ?? m[1]) : def;
  };
  return {
    modelPath: get("-m", ""),
    alias: get("--alias", ""),
    host: get("--host", "0.0.0.0"),
    port: Number(get("--port", 0)) || null,
    ngl: Number(get("-ngl", 0)),
    ncmoe: get("-ncmoe") !== null ? Number(get("-ncmoe")) : null,
    ctxSize: Number(get("-c", 32768)),
    slots: Number(get("-np", 1)),
    threads: Number(get("-t", 4)),
    threadsBatch: get("-tb") !== null ? Number(get("-tb")) : null,
    batchSize: get("-b") !== null ? Number(get("-b")) : 2048,
    ubatchSize: get("-ub") !== null ? Number(get("-ub")) : 512,
    flashAttn: get("-fa", "auto"),
    cacheTypeK: get("-ctk", "f16"),
    cacheTypeV: get("-ctv", "f16"),
    loadMode: get("--load-mode", "auto"),
    cacheRam: get("--cache-ram") !== null ? Number(get("--cache-ram")) : (kind === "llm" ? 8192 : 1024),
    metricsEnabled: /\s--metrics(?:\s|$)/.test(cmdText),
    specType: get("--spec-type", null),
    specDraftNMax: get("--spec-draft-n-max") !== null ? Number(get("--spec-draft-n-max")) : null,
    ngld: get("-ngld") !== null ? Number(get("-ngld")) : null,
    prio: get("--prio") !== null ? Number(get("--prio")) : null,
    poll: get("--poll") !== null ? Number(get("--poll")) : null,
    reasoning: get("--reasoning", null),
  };
}

function buildCmdText(kind, cfg) {
  const exe = "E:\\llama-cpp-cuda\\llama-server.exe";
  const model = kind === "qev"
    ? (cfg.modelPath || "E:\\models\\qev-0.8b-text-Q8_0.gguf")
    : (cfg.modelPath || "E:\\models\\Qwen3.8-35B-A3B-Q4_K_M.gguf");
  const alias = cfg.alias || (kind === "qev" ? "labqoat/qev-0.8b-GGUF:text-Q8_0" : "qwen3.8-35b-a3b");
  const port = kind === "qev" ? 8080 : 8081;
  const parts = [
    `"${exe}"`,
    `-m "${model}"`,
    `--alias "${alias}"`,
    `--host 0.0.0.0 --port ${port}`,
    `-ngl ${Math.max(0, Math.min(999, Number(cfg.ngl ?? 99)))}`,
  ];
  if (kind === "llm" && cfg.ncmoe !== null && cfg.ncmoe !== undefined && cfg.ncmoe !== "") {
    parts.push(`-ncmoe ${Math.max(0, Math.min(128, Number(cfg.ncmoe)))}`);
  }
  parts.push(`-fa ${["on", "off", "auto"].includes(cfg.flashAttn) ? cfg.flashAttn : "on"}`);
  parts.push(`-ctk ${cfg.cacheTypeK || "q8_0"} -ctv ${cfg.cacheTypeV || "q8_0"}`);
  parts.push(`-c ${Math.max(1024, Number(cfg.ctxSize || 32768))}`);
  parts.push(`-np ${Math.max(1, Math.min(16, Number(cfg.slots || 1)))}`);
  parts.push(`-t ${Math.max(1, Math.min(32, Number(cfg.threads || 4)))}`);
  if (cfg.threadsBatch) parts.push(`-tb ${Math.max(1, Math.min(32, Number(cfg.threadsBatch)))}`);
  if (cfg.batchSize) parts.push(`-b ${Math.max(128, Number(cfg.batchSize))}`);
  if (cfg.ubatchSize) parts.push(`-ub ${Math.max(64, Number(cfg.ubatchSize))}`);
  parts.push(`--load-mode ${["none", "auto", "mmap"].includes(cfg.loadMode) ? cfg.loadMode : "none"}`);
  if (cfg.cacheRam !== undefined && cfg.cacheRam !== null) parts.push(`--cache-ram ${Math.max(0, Number(cfg.cacheRam))}`);
  if (cfg.specType) parts.push(`--spec-type ${cfg.specType}`);
  if (cfg.specDraftNMax) parts.push(`--spec-draft-n-max ${Number(cfg.specDraftNMax)}`);
  if (cfg.ngld !== null && cfg.ngld !== undefined) parts.push(`-ngld ${Number(cfg.ngld)}`);
  if (cfg.prio !== null && cfg.prio !== undefined) parts.push(`--prio ${Number(cfg.prio)}`);
  if (cfg.poll !== null && cfg.poll !== undefined) parts.push(`--poll ${Number(cfg.poll)}`);
  if (cfg.reasoning) parts.push(`--reasoning ${cfg.reasoning}`);
  if (cfg.metricsEnabled) parts.push("--metrics");
  return `@echo off\r\nstart "" /B ${parts.join(" ")}\r\n`;
}

async function getHostTelemetry() {
  const [gpuRes, psRes, qevModels, qevSlots, llmModels, llmSlots, qevCmdTxt, llmCmdTxt, qevLog, llmLog] = await Promise.all([
    runCmd("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], 5000).catch(() => ({ stdout: "" })),
    runCmd("powershell", ["-NoProfile", "-Command", "$os=Get-CimInstance Win32_OperatingSystem; $d=Get-PSDrive C,D,E -ErrorAction SilentlyContinue | Select Name,@{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}},@{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}}; $p=Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'llama-server|discord-wincode|run-discord'} | Select ProcessId,Name,CommandLine; [PSCustomObject]@{ramTotalGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); ramFreeGB=[math]::Round($os.FreePhysicalMemory/1MB,1); disks=$d; procs=$p} | ConvertTo-Json -Depth 4 -Compress"], 8000).catch(() => ({ stdout: "{}" })),
    fetchJsonSafe("http://127.0.0.1:8080/v1/models"),
    fetchJsonSafe("http://127.0.0.1:8080/slots"),
    fetchJsonSafe("http://127.0.0.1:8081/v1/models"),
    fetchJsonSafe("http://127.0.0.1:8081/slots"),
    fs.readFile(QEV_CMD, "utf-8").catch(() => ""),
    fs.readFile(LLM_CMD, "utf-8").catch(() => ""),
    readTail(QEV_ERR_LOG, 25),
    readTail(LLM_ERR_LOG, 25),
  ]);

  let gpu = null;
  const gLine = gpuRes.stdout.trim().split(/\r?\n/)[0];
  if (gLine) {
    const [name, totalMiB, usedMiB, freeMiB, utilPct, tempC] = gLine.split(",").map(s => s.trim());
    gpu = { name, totalMiB: Number(totalMiB), usedMiB: Number(usedMiB), freeMiB: Number(freeMiB), utilPct: Number(utilPct), tempC: Number(tempC) };
  }
  let sys = {};
  try { sys = JSON.parse(psRes.stdout || "{}"); } catch {}
  const procs = Array.isArray(sys.procs) ? sys.procs : (sys.procs ? [sys.procs] : []);

  const formatEngine = (kind, port, modelsRes, slotsRes, cmdTxt, logLines) => {
    const flags = parseCmdFlags(cmdTxt);
    const meta = modelsRes.json?.data?.[0]?.meta || {};
    const slots = Array.isArray(slotsRes.json) ? slotsRes.json : [];
    const pidObj = procs.find(p => (p.CommandLine || "").includes(`--port ${port}`) || (p.CommandLine || "").includes(`--port,${port}`));
    return {
      kind,
      port,
      online: Boolean(modelsRes.ok),
      status: modelsRes.ok ? "ready" : (modelsRes.status === 503 ? "loading" : "offline"),
      modelId: modelsRes.json?.data?.[0]?.id || flags.alias,
      nCtxSlot: meta.n_ctx || Math.floor((flags.ctxSize || 32768) / Math.max(1, flags.slots || 1)),
      nCtxTrain: meta.n_ctx_train || null,
      sizeBytes: meta.size || null,
      ftype: meta.ftype || null,
      pid: pidObj?.ProcessId || null,
      flags,
      slots: slots.map(s => ({
        id: s.id,
        nCtx: s.n_ctx,
        processing: Boolean(s.is_processing),
        taskId: s.id_task,
        promptTokens: s.n_prompt_tokens || 0,
        processedTokens: s.n_prompt_tokens_processed || 0,
        cachedTokens: s.n_prompt_tokens_cache || 0,
      })),
      logTail: logLines,
    };
  };

  return {
    gpu,
    ram: { totalGB: sys.ramTotalGB ?? 64, freeGB: sys.ramFreeGB ?? null },
    disks: Array.isArray(sys.disks) ? sys.disks : (sys.disks ? [sys.disks] : []),
    procs,
    engines: {
      qev: formatEngine("qev", 8080, qevModels, qevSlots, qevCmdTxt, qevLog),
      llm: formatEngine("llm", 8081, llmModels, llmSlots, llmCmdTxt, llmLog),
    },
  };
}

const WSL_INSPECT_PY = `
import json, subprocess

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    return p.returncode, p.stdout, p.stderr

out = {"ok": True, "atespaces": [], "workerpools": [], "templates": [], "actors": [], "egressPolicies": {}, "ateSystemPods": [], "workerPods": [], "egressLogs": [], "kagent": {"installed": False, "agents": [], "teams": [], "modelConfigs": []}}

rc, s, _ = run(["kubectl", "-n", "ate-system", "get", "pods", "-o", "json"])
if rc == 0 and s.strip():
    for pod in json.loads(s).get("items", []):
        cs = pod.get("status", {}).get("containerStatuses", [])
        ready = sum(1 for c in cs if c.get("ready"))
        out["ateSystemPods"].append({
            "name": pod["metadata"]["name"],
            "phase": pod.get("status", {}).get("phase"),
            "ready": f"{ready}/{len(cs)}",
            "allReady": pod.get("status", {}).get("phase") == "Succeeded" or (len(cs) > 0 and ready == len(cs)),
            "ip": pod.get("status", {}).get("podIP"),
        })

rc, s, _ = run(["kubectl", "get", "workerpool", "-A", "-o", "json"])
if rc == 0 and s.strip():
    for wp in json.loads(s).get("items", []):
        st = wp.get("status", {})
        spec = wp.get("spec", {})
        res = spec.get("template", {}).get("resources", {})
        out["workerpools"].append({
            "namespace": wp["metadata"]["namespace"],
            "name": wp["metadata"]["name"],
            "labels": wp["metadata"].get("labels", {}),
            "replicas": spec.get("replicas", 0),
            "readyReplicas": st.get("readyReplicas", 0),
            "sandboxClass": (spec.get("sandboxClasses") or [{}])[0].get("name", "gvisor"),
            "workerImage": spec.get("workerImage", ""),
            "limits": res.get("limits", {}),
            "requests": res.get("requests", {}),
        })

for wp in out["workerpools"]:
    _, ps, _ = run(["kubectl", "-n", wp["namespace"], "get", "pods", "-o", "json"])
    if ps.strip():
        for pod in json.loads(ps).get("items", []):
            cs = pod.get("status", {}).get("containerStatuses", [])
            ready = sum(1 for c in cs if c.get("ready"))
            out["workerPods"].append({
                "namespace": pod["metadata"]["namespace"],
                "name": pod["metadata"]["name"],
                "phase": pod.get("status", {}).get("phase"),
                "ready": f"{ready}/{len(cs)}",
                "ip": pod.get("status", {}).get("podIP"),
            })

rc, s, _ = run(["kubectl-ate", "get", "atespaces", "-o", "json"])
if rc == 0 and s.strip():
    data = json.loads(s)
    items = data.get("atespaces") if isinstance(data, dict) else data
    for a in (items or []):
        name = a.get("metadata", {}).get("name") or a.get("name")
        if name:
            out["atespaces"].append(name)

for ns in out["atespaces"]:
    rc, ts, _ = run(["kubectl-ate", "get", "actor-templates", "-a", ns, "-o", "json"])
    if rc == 0 and ts.strip():
        td = json.loads(ts)
        titems = td.get("actorTemplates") if isinstance(td, dict) else td
        for t in (titems or []):
            out["templates"].append(t)
    rc, acs, _ = run(["kubectl-ate", "get", "actors", "-a", ns, "-o", "json"])
    if rc == 0 and acs.strip():
        ad = json.loads(acs)
        aitems = ad.get("actors") if isinstance(ad, dict) else ad
        for act in (aitems or []):
            out["actors"].append(act)
            aname = act.get("metadata", {}).get("name")
            if aname:
                erc, es, _ = run(["kubectl-ate", "get", "egress-policy", aname, "-a", ns, "-o", "json"])
                if erc == 0 and es.strip():
                    out["egressPolicies"][f"{ns}/{aname}"] = json.loads(es)

rc, logs, _ = run(["kubectl", "-n", "ate-system", "logs", "deployment/atenet-egress", "-c", "envoy", "--tail=35"])
if rc == 0 and logs.strip():
    for line in logs.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                ev = json.loads(line)
                if "authority" in ev:
                    out["egressLogs"].append(ev)
            except Exception:
                pass

rc, crds, _ = run(["kubectl", "get", "crd", "-o", "name"])
if rc == 0 and "kagent.dev" in crds:
    out["kagent"]["installed"] = True
    for res_type, key in [("agents.kagent.dev", "agents"), ("teams.kagent.dev", "teams"), ("modelconfigs.kagent.dev", "modelConfigs")]:
        r2, s2, _ = run(["kubectl", "get", res_type, "-A", "-o", "json"])
        if r2 == 0 and s2.strip():
            out["kagent"][key] = json.loads(s2).get("items", [])

print(json.dumps(out))
`;

async function getSubstrateTelemetry() {
  try {
    const { stdout } = await runWslPy(WSL_INSPECT_PY, [], 30000);
    return JSON.parse(stdout);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), atespaces: [], workerpools: [], templates: [], actors: [], egressPolicies: {}, ateSystemPods: [], workerPods: [], egressLogs: [], kagent: { installed: false, agents: [], teams: [], modelConfigs: [] } };
  }
}

async function getJeoTelemetry(procs) {
  let jeoCfg = {};
  let winCfg = {};
  try { jeoCfg = JSON.parse(await fs.readFile(JEO_CFG, "utf-8")); } catch {}
  try { winCfg = JSON.parse(await fs.readFile(WINCODE_CFG, "utf-8")); } catch {}

  const customProviders = {};
  for (const [id, p] of Object.entries(jeoCfg.customProviders || {})) {
    customProviders[id] = {
      id,
      label: p.label || id,
      baseUrl: p.baseUrl,
      protocol: p.protocol || "openai",
      models: p.models || [],
      defaultModel: p.defaultModel || (p.models || [])[0] || "",
      hasLiteralKey: Boolean(p.apiKey),
      apiKeyEnv: p.apiKeyEnv || null,
    };
  }
  const winProc = (procs || []).find(p => (p.CommandLine || "").includes("discord-wincode-1567081884213706762"));
  const dc = winCfg.platforms?.discord || {};
  return {
    defaultModel: jeoCfg.defaultModel || null,
    customProviders,
    discordWincode: {
      running: Boolean(winProc),
      pid: winProc?.ProcessId || null,
      cwd: winCfg.cwd || "",
      defaultModel: dc.model || "",
      allowedChannelIds: dc.allowedChannelIds || [],
      threadModels: dc.threadModels || {},
    },
  };
}

function analyzeBottlenecks(host, sub) {
  const issues = [];
  const gpu = host.gpu;
  if (gpu) {
    if (gpu.freeMiB < 350) {
      issues.push({
        id: "vram-critical",
        severity: "critical",
        nodeId: "gpu",
        title: `VRAM 임계 (${gpu.freeMiB} MiB 남음)`,
        detail: "RTX 2060 SUPER 8GB 한계에 도달해 WDDM 공유 RAM 스필(속도 급락) 위험이 높습니다.",
        hint: "MoE -ncmoe 값을 48로 올리거나 -c 컨텍스트/슬롯(-np)을 줄여 800 MiB 이상 여유를 확보하세요.",
      });
    } else if (gpu.freeMiB < 750) {
      issues.push({
        id: "vram-tight",
        severity: "warn",
        nodeId: "gpu",
        title: `VRAM 여유 부족 (${gpu.freeMiB} MiB 남음)`,
        detail: "20k+ 대형 프롬프트 프리필 시 CUDA 스크래치 버퍼가 넘칠 수 있습니다.",
        hint: "대형 배치 처리 시 최소 800~1,200 MiB 여유 VRAM 확보가 안전합니다.",
      });
    }
  }

  for (const [k, eng] of Object.entries(host.engines)) {
    if (!eng.online) {
      issues.push({
        id: `engine-down-${k}`,
        severity: "critical",
        nodeId: k,
        title: `${k === "qev" ? "qev 라우터(:8080)" : "30B MoE LLM(:8081)"} 오프라인`,
        detail: `포트 ${eng.port} 응답이 없습니다 (${eng.status}).`,
        hint: "추론 엔진 탭에서 '시작/재기동' 버튼으로 즉시 복구할 수 있습니다.",
      });
    } else {
      const busy = eng.slots.filter(s => s.processing).length;
      if (eng.slots.length > 0 && busy === eng.slots.length) {
        issues.push({
          id: `slots-full-${k}`,
          severity: "warn",
          nodeId: k,
          title: `${k} 슬롯 포화 (${busy}/${eng.slots.length} 처리 중)`,
          detail: "동시 요청이 슬롯 수를 채워 추가 요청이 대기 중입니다.",
          hint: "동시성을 높이려면 -np 슬롯 수를 늘리거나 요청을 분산하세요.",
        });
      }
      for (const s of eng.slots) {
        if (s.nCtx > 0 && s.promptTokens / s.nCtx > 0.85) {
          issues.push({
            id: `ctx-high-${k}-${s.id}`,
            severity: "warn",
            nodeId: k,
            title: `${k} 슬롯 #${s.id} 컨텍스트 85% 초과 (${s.promptTokens}/${s.nCtx})`,
            detail: "컨텍스트 포화로 프롬프트 잘림 또는 재평가 지연이 발생할 수 있습니다.",
            hint: "세션을 요약/초기화하거나 -c 값을 상향하세요.",
          });
        }
      }
    }
  }

  const cDisk = host.disks.find(d => d.Name === "C");
  if (cDisk && cDisk.FreeGB < 5) {
    issues.push({
      id: "disk-c-low",
      severity: cDisk.FreeGB < 2.5 ? "critical" : "warn",
      nodeId: "host",
      title: `C: 드라이브 여유 공간 부족 (${cDisk.FreeGB} GB)`,
      detail: "Docker/WSL2 가상 디스크가 C:에 있어 5GB 미만이면 이미지/스냅샷 작업이 실패할 수 있습니다.",
      hint: "대용량 모델·빌드는 E:(SSD) 또는 D:에 유지하세요.",
    });
  }

  const unreadySys = (sub.ateSystemPods || []).filter(p => !p.allReady);
  if (unreadySys.length > 0) {
    issues.push({
      id: "ate-system-unready",
      severity: "critical",
      nodeId: "substrate",
      title: `Substrate 시스템 파드 미준비 (${unreadySys.length}개)`,
      detail: unreadySys.map(p => `${p.name}(${p.ready})`).join(", "),
      hint: "Docker Desktop / kind-control-plane 상태를 점검하세요.",
    });
  }

  for (const wp of sub.workerpools || []) {
    if ((wp.readyReplicas || 0) < (wp.replicas || 0)) {
      issues.push({
        id: `wp-unready-${wp.name}`,
        severity: "warn",
        nodeId: "workers",
        title: `WorkerPool ${wp.namespace}/${wp.name} 준비 중 (${wp.readyReplicas}/${wp.replicas})`,
        detail: "유휴 워커 파드가 목표 복제본 수에 도달하지 않았습니다.",
        hint: "워커 풀 스케일을 조정하거나 파드 이벤트를 확인하세요.",
      });
    }
  }

  const denied = (sub.egressLogs || []).filter(e => Number(e.status) === 403);
  if (denied.length > 0) {
    issues.push({
      id: "egress-403",
      severity: "warn",
      nodeId: "egress",
      title: `Egress 차단(403) ${denied.length}건 감지`,
      detail: `최근 차단 대상: ${denied[denied.length - 1].authority}`,
      hint: "에이전트 관리 탭에서 해당 액터의 EgressPolicy에 호스트/포트를 추가하세요.",
    });
  }

  return issues;
}

let cachedSnapshot = null;
let lastCollectAt = 0;
let collecting = null;

async function collectSnapshot(force = false) {
  const now = Date.now();
  if (!force && cachedSnapshot && now - lastCollectAt < 1800) return cachedSnapshot;
  if (collecting) return collecting;
  collecting = (async () => {
    const host = await getHostTelemetry();
    const [substrate, jeo] = await Promise.all([
      getSubstrateTelemetry(),
      getJeoTelemetry(host.procs),
    ]);
    const bottlenecks = analyzeBottlenecks(host, substrate);
    const snap = {
      timestamp: new Date().toISOString(),
      host,
      substrate,
      jeo,
      bottlenecks,
      flowEvents: FLOW_EVENTS.slice(0, 20),
    };
    cachedSnapshot = snap;
    lastCollectAt = Date.now();
    collecting = null;
    return snap;
  })();
  return collecting;
}

const sseClients = new Set();
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const snap = await collectSnapshot(true);
    const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const res of sseClients) res.write(payload);
  } catch {}
}, 2500);

async function restartLlamaEngine(kind, flags) {
  const port = kind === "qev" ? 8080 : 8081;
  const cmdFile = kind === "qev" ? QEV_CMD : LLM_CMD;
  const outLog = kind === "qev" ? "E:\\llama-cpp-cuda\\qev.out.log" : "E:\\llama-cpp-cuda\\llm.out.log";
  const errLog = kind === "qev" ? "E:\\llama-cpp-cuda\\qev.err.log" : "E:\\llama-cpp-cuda\\llm.err.log";
  const currentTxt = await fs.readFile(cmdFile, "utf-8").catch(() => "");
  const merged = { ...parseCmdFlags(currentTxt), ...flags };
  const newCmd = buildCmdText(kind, merged);
  await fs.writeFile(cmdFile, newCmd, "utf-8");

  const model = merged.modelPath || (kind === "qev" ? "E:\\models\\qev-0.8b-text-Q8_0.gguf" : "E:\\models\\Qwen3.8-35B-A3B-Q4_K_M.gguf");
  const alias = merged.alias || (kind === "qev" ? "labqoat/qev-0.8b-GGUF:text-Q8_0" : "qwen3.8-35b-a3b");
  const args = [
    "-m", model, "--alias", alias, "--host", "0.0.0.0", "--port", String(port),
    "-ngl", String(merged.ngl ?? 99),
    ...(kind === "llm" && merged.ncmoe !== null && merged.ncmoe !== undefined && merged.ncmoe !== "" ? ["-ncmoe", String(merged.ncmoe)] : []),
    "-fa", merged.flashAttn || "on",
    "-ctk", merged.cacheTypeK || "q8_0", "-ctv", merged.cacheTypeV || "q8_0",
    "-c", String(merged.ctxSize || 32768),
    "-np", String(merged.slots || 1),
    "-t", String(merged.threads || 4),
    ...(merged.threadsBatch ? ["-tb", String(merged.threadsBatch)] : []),
    ...(merged.batchSize ? ["-b", String(merged.batchSize)] : []),
    ...(merged.ubatchSize ? ["-ub", String(merged.ubatchSize)] : []),
    "--load-mode", merged.loadMode || "none",
    "--cache-ram", String(merged.cacheRam ?? 1024),
    ...(merged.specType ? ["--spec-type", String(merged.specType)] : []),
    ...(merged.specDraftNMax ? ["--spec-draft-n-max", String(merged.specDraftNMax)] : []),
    ...(merged.ngld !== null && merged.ngld !== undefined ? ["-ngld", String(merged.ngld)] : []),
    ...(merged.prio !== null && merged.prio !== undefined ? ["--prio", String(merged.prio)] : []),
    ...(merged.poll !== null && merged.poll !== undefined ? ["--poll", String(merged.poll)] : []),
    ...(merged.reasoning ? ["--reasoning", String(merged.reasoning)] : []),
    ...(merged.metricsEnabled ? ["--metrics"] : []),
  ];
  const argLiteral = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(",");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.CommandLine -match '--port\\s+${port}|--port,${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 1; Start-Process -FilePath 'E:\\llama-cpp-cuda\\llama-server.exe' -ArgumentList ${argLiteral} -WindowStyle Hidden -RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'`;
  await runCmd("powershell", ["-NoProfile", "-Command", ps], 20000);
  pushFlowEvent({ source: "control-plane", target: kind, kind: "restart", status: "restarting", detail: `ctx=${merged.ctxSize}, np=${merged.slots}, ncmoe=${merged.ncmoe ?? "-"}` });
  return merged;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (req.method === "GET" && p === "/api/health") {
      return sendJson(res, 200, { ok: true, service: "substra-ops-dashboard", port: PORT });
    }
    if (req.method === "GET" && p === "/api/snapshot") {
      return sendJson(res, 200, await collectSnapshot(url.searchParams.get("force") === "1"));
    }
    if (req.method === "GET" && p === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      const snap = await collectSnapshot();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && p === "/api/host/server") {
      const body = await readBody(req);
      const { kind, action, flags } = body;
      if (!["qev", "llm"].includes(kind)) return sendJson(res, 400, { ok: false, error: "Invalid engine kind" });
      const port = kind === "qev" ? 8080 : 8081;
      if (action === "stop") {
        await runCmd("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.CommandLine -match '--port\\s+${port}|--port,${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
        pushFlowEvent({ source: "control-plane", target: kind, kind: "stop", status: "stopped" });
        return sendJson(res, 200, { ok: true, action: "stopped", kind });
      }
      const updated = await restartLlamaEngine(kind, flags || {});
      return sendJson(res, 200, { ok: true, action: "restarted", kind, flags: updated });
    }

    if (req.method === "POST" && p === "/api/host/test") {
      const body = await readBody(req);
      const target = body.target || "llm";
      const prompt = String(body.prompt || "Reply with OK.");
      const maxTokens = Math.min(256, Math.max(8, Number(body.maxTokens || 64)));
      const t0 = Date.now();
      if (target === "qev") {
        const r = await fetch("http://127.0.0.1:8080/v1/systemone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "labqoat/qev-0.8b-GGUF:text-Q8_0",
            state: { prompt },
            questions: { actionable: { type: "noul", instructions: "Is this request safe and actionable?" } },
          }),
        });
        const j = await r.json();
        const ms = Date.now() - t0;
        pushFlowEvent({ source: "live-test", target: "qev", kind: "decision", status: r.ok ? "200" : String(r.status), ms, detail: `noul=${j?.answers?.actionable?.noul?.toFixed?.(3)}` });
        return sendJson(res, 200, { ok: r.ok, target, ms, result: j });
      }
      if (target === "actor") {
        const atespace = String(body.atespace || "local-ai").replace(/[^a-zA-Z0-9_-]/g, "");
        const actor = String(body.actor || "agent-1").replace(/[^a-zA-Z0-9_-]/g, "");
        const py = `
import json, subprocess, time, urllib.request
p = subprocess.Popen(["kubectl-ate", "proxy", "actor", "${actor}", "-a", "${atespace}", "18099:80"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(60):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18099/readyz", timeout=2) as r:
                if r.status == 200:
                    break
        except Exception:
            time.sleep(0.25)
    req = urllib.request.Request("http://127.0.0.1:18099/agent", data=json.dumps({"prompt": ${JSON.stringify(prompt)}, "max_tokens": ${maxTokens}}).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        print(r.read().decode())
finally:
    p.terminate()
    p.wait(timeout=10)
`;
        const { stdout } = await runWslPy(py, [], 180000);
        const ms = Date.now() - t0;
        const j = JSON.parse(stdout.trim());
        pushFlowEvent({ source: "substrate-actor", target: `${atespace}/${actor}`, kind: "e2e", status: "200", ms, detail: `qev=${j.qev_ms}ms llm=${j.llm_ms}ms` });
        return sendJson(res, 200, { ok: true, target: `${atespace}/${actor}`, ms, result: j });
      }
      const r = await fetch("http://127.0.0.1:8081/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.8-35b-a3b",
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
      });
      const j = await r.json();
      const ms = Date.now() - t0;
      const tps = j?.timings?.predicted_per_second ? j.timings.predicted_per_second.toFixed(2) : null;
      pushFlowEvent({ source: "live-test", target: "llm", kind: "completion", status: r.ok ? "200" : String(r.status), ms, detail: tps ? `${tps} tok/s` : "" });
      return sendJson(res, 200, { ok: r.ok, target, ms, result: j });
    }

    if (req.method === "POST" && p === "/api/substrate/atespaces") {
      const { name } = await readBody(req);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name || "")) return sendJson(res, 400, { ok: false, error: "Invalid atespace name" });
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "create", "atespace", sys.argv[1]])`, [name]);
      return sendJson(res, 201, { ok: true, name });
    }
    if (req.method === "DELETE" && p.startsWith("/api/substrate/atespaces/")) {
      const name = decodeURIComponent(p.split("/").pop());
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "delete", "atespace", sys.argv[1]])`, [name]);
      return sendJson(res, 200, { ok: true, deleted: name });
    }

    if (req.method === "POST" && p === "/api/substrate/workerpools") {
      const b = await readBody(req);
      const ns = String(b.namespace || "local-ai");
      const name = String(b.name || "");
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(ns) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        return sendJson(res, 400, { ok: false, error: "Invalid namespace or WorkerPool name" });
      }
      const doc = `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
---
apiVersion: ate.dev/v1
kind: WorkerPool
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    workload: ${b.workloadLabel || name}
spec:
  replicas: ${Math.max(0, Math.min(16, Number(b.replicas ?? 1)))}
  workerImage: ${b.workerImage || "ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.0"}
  sandboxClasses:
  - name: ${b.sandboxClass || "gvisor"}
  template:
    resources:
      limits:
        cpu: "${b.cpuLimit || "1"}"
        memory: ${b.memLimit || "512Mi"}
      requests:
        cpu: ${b.cpuRequest || "200m"}
        memory: ${b.memLimit || "512Mi"}
`;
      await runWslPy(`import subprocess, sys; subprocess.run(["kubectl", "apply", "-f", "-"], input=sys.argv[1], text=True, check=True)`, [doc]);
      return sendJson(res, 201, { ok: true, namespace: ns, name });
    }

    if (req.method === "PATCH" && p.startsWith("/api/substrate/workerpools/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      const b = await readBody(req);
      const patch = { spec: {} };
      if (b.replicas !== undefined) patch.spec.replicas = Math.max(0, Math.min(16, Number(b.replicas)));
      if (b.cpuLimit || b.memLimit || b.cpuRequest) {
        patch.spec.template = { resources: { limits: {}, requests: {} } };
        if (b.cpuLimit) patch.spec.template.resources.limits.cpu = String(b.cpuLimit);
        if (b.memLimit) {
          patch.spec.template.resources.limits.memory = String(b.memLimit);
          patch.spec.template.resources.requests.memory = String(b.memLimit);
        }
        if (b.cpuRequest) patch.spec.template.resources.requests.cpu = String(b.cpuRequest);
      }
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl", "-n", sys.argv[1], "patch", "workerpool", sys.argv[2], "--type=merge", "-p", sys.argv[3]])`, [ns, name, JSON.stringify(patch)]);
      return sendJson(res, 200, { ok: true, namespace: ns, name, patch });
    }

    if (req.method === "DELETE" && p.startsWith("/api/substrate/workerpools/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl", "-n", sys.argv[1], "delete", "workerpool", sys.argv[2]])`, [ns, name]);
      return sendJson(res, 200, { ok: true, deleted: `${ns}/${name}` });
    }

    if (req.method === "POST" && p === "/api/substrate/templates") {
      const b = await readBody(req);
      const manifest = b.yaml ? String(b.yaml) : JSON.stringify({
        metadata: { atespace: b.atespace || "local-ai", name: b.name },
        workerSelector: { matchLabels: { workload: b.workloadLabel || "local-ai-agent" } },
        containers: [{
          name: "agent",
          image: b.image,
          command: Array.isArray(b.command) ? b.command : ["python3", "/app/server.py"],
          env: Array.isArray(b.env) ? b.env : [
            { name: "QEV_URL", value: "http://host.docker.internal:8080/v1/systemone" },
            { name: "QEV_MODEL", value: "labqoat/qev-0.8b-GGUF:text-Q8_0" },
            { name: "LLM_URL", value: "http://host.docker.internal:8081/v1/chat/completions" },
            { name: "LLM_MODEL", value: "qwen3.8-35b-a3b" },
          ],
          wakeupProbe: { httpGet: { path: b.readyPath || "/readyz", port: Number(b.port || 80) } },
          volumeMounts: [{ name: "data", mountPath: "/home/agent" }],
        }],
        resources: { limits: { cpuMillicores: Number(b.cpuMillicores || 1000), memoryBytes: Number(b.memoryBytes || 268435456) } },
        snapshotConfig: { preferredFidelity: b.fidelity || "SNAPSHOT_FIDELITY_MEMORY" },
        volumes: [{ name: "data", durableDir: {} }],
      });
      await runWslPy(`import subprocess, sys; subprocess.run(["kubectl-ate", "create", "actor-template", "-f", "-"], input=sys.argv[1], text=True, check=True)`, [manifest]);
      return sendJson(res, 201, { ok: true });
    }

    if (req.method === "DELETE" && p.startsWith("/api/substrate/templates/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "delete", "actor-template", sys.argv[1], "-a", sys.argv[2]])`, [name, ns]);
      return sendJson(res, 200, { ok: true, deleted: `${ns}/${name}` });
    }

    if (req.method === "POST" && p === "/api/substrate/actors") {
      const b = await readBody(req);
      const ns = String(b.atespace || "local-ai");
      const name = String(b.name || "");
      const template = String(b.template || "local-ai-agent");
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "create", "actor", sys.argv[1], "-a", sys.argv[2], "--template", sys.argv[3]])`, [name, ns, template]);
      if (Array.isArray(b.egressRules) && b.egressRules.length > 0) {
        const ep = JSON.stringify({ rules: b.egressRules });
        await runWslPy(`import subprocess, sys; subprocess.run(["kubectl-ate", "create", "egress-policy", sys.argv[1], "-a", sys.argv[2], "-f", "-"], input=sys.argv[3], text=True, check=True)`, [name, ns, ep]);
      }
      return sendJson(res, 201, { ok: true, atespace: ns, name });
    }

    if (req.method === "POST" && p.startsWith("/api/substrate/actors/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      const action = parts[6];
      if (!["suspend", "resume", "revert"].includes(action)) return sendJson(res, 400, { ok: false, error: "Invalid actor action" });
      const t0 = Date.now();
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", sys.argv[1], "actor", sys.argv[2], "-a", sys.argv[3]])`, [action, name, ns]);
      pushFlowEvent({ source: "control-plane", target: `${ns}/${name}`, kind: action, status: "ok", ms: Date.now() - t0 });
      return sendJson(res, 200, { ok: true, action, atespace: ns, name });
    }

    if (req.method === "GET" && p.startsWith("/api/substrate/actors/") && p.endsWith("/logs")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      const { stdout } = await runWslPy(`import subprocess, sys; out = subprocess.check_output(["kubectl-ate", "logs", "actor", sys.argv[1], "-a", sys.argv[2]], text=True); print(chr(10).join(out.splitlines()[-80:]))`, [name, ns]);
      return sendJson(res, 200, { ok: true, logs: stdout });
    }

    if (req.method === "DELETE" && p.startsWith("/api/substrate/actors/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const name = decodeURIComponent(parts[5]);
      await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "delete", "actor", sys.argv[1], "-a", sys.argv[2]])`, [name, ns]);
      return sendJson(res, 200, { ok: true, deleted: `${ns}/${name}` });
    }

    if ((req.method === "PUT" || req.method === "DELETE") && p.startsWith("/api/substrate/egress/")) {
      const parts = p.split("/");
      const ns = decodeURIComponent(parts[4]);
      const actor = decodeURIComponent(parts[5]);
      if (req.method === "DELETE") {
        await runWslPy(`import subprocess, sys; subprocess.check_call(["kubectl-ate", "delete", "egress-policy", sys.argv[1], "-a", sys.argv[2]])`, [actor, ns]);
        return sendJson(res, 200, { ok: true, deleted: `${ns}/${actor}` });
      }
      const b = await readBody(req);
      const rulesJson = JSON.stringify(b.rules || []);
      const py = `
import json, subprocess, sys
actor, ns, rules_raw = sys.argv[1], sys.argv[2], sys.argv[3]
rules = json.loads(rules_raw)
g = subprocess.run(["kubectl-ate", "get", "egress-policy", actor, "-a", ns, "-o", "json"], capture_output=True, text=True)
if g.returncode == 0 and g.stdout.strip():
    existing = json.loads(g.stdout)
    doc = {"metadata": existing.get("metadata", {}), "rules": rules}
    verb = "update"
else:
    doc = {"rules": rules}
    verb = "create"
subprocess.run(["kubectl-ate", verb, "egress-policy", actor, "-a", ns, "-f", "-"], input=json.dumps(doc), text=True, check=True)
`;
      await runWslPy(py, [actor, ns, rulesJson]);
      return sendJson(res, 200, { ok: true, atespace: ns, actor });
    }

    if (p.startsWith("/api/jeo/providers/")) {
      const id = decodeURIComponent(p.split("/")[4]);
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return sendJson(res, 400, { ok: false, error: "Invalid provider id" });
      if (req.method === "POST" && p.endsWith("/test")) {
        const { stdout, stderr } = await runCmd("C:/Users/bangg/.bun/bin/bun.exe", ["C:/Users/bangg/AppData/Roaming/npm/node_modules/jeo-code/src/cli.ts", "provider", "test", id], 15000);
        return sendJson(res, 200, { ok: true, output: stdout || stderr });
      }
      const raw = JSON.parse(await fs.readFile(JEO_CFG, "utf-8"));
      raw.customProviders = raw.customProviders || {};
      if (req.method === "DELETE") {
        delete raw.customProviders[id];
        await fs.writeFile(JEO_CFG, JSON.stringify(raw, null, 2) + "\n", "utf-8");
        return sendJson(res, 200, { ok: true, deleted: id });
      }
      if (req.method === "PUT") {
        const b = await readBody(req);
        const existing = raw.customProviders[id] || {};
        raw.customProviders[id] = {
          label: String(b.label || existing.label || id),
          baseUrl: String(b.baseUrl || existing.baseUrl),
          protocol: b.protocol === "anthropic" ? "anthropic" : "openai",
          models: Array.isArray(b.models) ? b.models : String(b.models || "").split(",").map(s => s.trim()).filter(Boolean),
          defaultModel: String(b.defaultModel || existing.defaultModel || ""),
          ...(b.apiKeyEnv ? { apiKeyEnv: String(b.apiKeyEnv) } : {}),
        };
        await fs.writeFile(JEO_CFG, JSON.stringify(raw, null, 2) + "\n", "utf-8");
        return sendJson(res, 200, { ok: true, id, provider: raw.customProviders[id] });
      }
    }

    if (p === "/api/jeo/thread-models" && req.method === "PUT") {
      const b = await readBody(req);
      const threadId = String(b.threadId || "").trim();
      const modelId = String(b.modelId || "").trim();
      if (!/^\d{1,22}$/.test(threadId) || !modelId) return sendJson(res, 400, { ok: false, error: "Invalid threadId or modelId" });
      const win = JSON.parse(await fs.readFile(WINCODE_CFG, "utf-8"));
      win.platforms.discord.threadModels = win.platforms.discord.threadModels || {};
      win.platforms.discord.threadModels[threadId] = modelId;
      await fs.writeFile(WINCODE_CFG, JSON.stringify(win, null, 2) + "\n", "utf-8");
      return sendJson(res, 200, { ok: true, threadModels: win.platforms.discord.threadModels });
    }

    if (p.startsWith("/api/jeo/thread-models/") && req.method === "DELETE") {
      const threadId = decodeURIComponent(p.split("/").pop());
      const win = JSON.parse(await fs.readFile(WINCODE_CFG, "utf-8"));
      if (win.platforms?.discord?.threadModels) delete win.platforms.discord.threadModels[threadId];
      await fs.writeFile(WINCODE_CFG, JSON.stringify(win, null, 2) + "\n", "utf-8");
      return sendJson(res, 200, { ok: true, deleted: threadId });
    }

    if (p === "/api/jeo/messenger/restart" && req.method === "POST") {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'bun.exe' -and $_.CommandLine -and $_.CommandLine.Contains('discord-wincode-1567081884213706762') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 1; & '${WINCODE_START}'`;
      const { stdout } = await runCmd("powershell", ["-NoProfile", "-Command", ps], 20000);
      return sendJson(res, 200, { ok: true, output: stdout.trim() });
    }

    if (req.method === "GET") {
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const filePath = path.resolve(PUBLIC_DIR, rel);
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
      try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
        return res.end(data);
      } catch {
        return sendJson(res, 404, { error: "Not found" });
      }
    }

    sendJson(res, 404, { error: "Unknown route" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SubstraOps Dashboard listening on http://${HOST}:${PORT}`);
});
