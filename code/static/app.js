/* =====================================================
   城市道路突发事件应急抢修仿真与辅助决策系统 — 前端
   ===================================================== */

/* ===== API Utilities ===== */
async function apiGet(path) { const r = await fetch(path); return r.json(); }
async function apiPost(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function apiPut(path, body = {}) {
  const r = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function apiDel(path) { const r = await fetch(path, { method: "DELETE" }); return r.json(); }

function checkResult(result) {
  if (result.code !== 200) { toast(result.message); return false; }
  return true;
}

/* ===== Toast ===== */
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2500);
}

/* ===== Loading ===== */
let loadingCount = 0;
function showLoading() {
  loadingCount++;
  document.getElementById("loadingOverlay").classList.add("show");
}
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) document.getElementById("loadingOverlay").classList.remove("show");
}

/* ===== Global State ===== */
let state = null;
let currentEventId = null;
let currentPlanId = null;
let currentSimulationId = null;
let eventPlanSelections = {}; // { eventId: planId, ... }
let pendingSyncStarts = []; // [{eventId, planId}, ...] — retry when resources free
let isSubmitting = false;
let simPollTimer = null;

/* ===== Load State ===== */
async function loadState() {
  showLoading();
  const result = await apiGet("/api/state");
  hideLoading();
  if (!checkResult(result)) return;
  state = result.data;
  renderDashboard();
  renderEventList();
  renderNetworkManage();
  renderResourceManage();
  renderPlanArea();
  renderReportArea();
}

/* ===== Tab Switching ===== */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    // Switching tabs no longer stops simulation — it keeps running in background
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

/* ==================================================================
   Tab 1: Dashboard
   ================================================================== */
function renderDashboard() {
  if (!state) return;
  const m = state.metrics || {};
  document.getElementById("mEventCount").textContent = m.eventCount ?? 0;
  document.getElementById("mActiveTasks").textContent = m.activeTasks ?? 0;
  document.getElementById("mAvgRecovery").textContent = m.averageRecoveryTime ?? 0;
  document.getElementById("mAffectedVehicles").textContent = m.affectedVehicles ?? 0;
  document.getElementById("mRecoveredRoads").textContent = m.recoveredRoads ?? 0;
  renderSvgMap();
  renderDashboardSimInfo();
}

function renderDashboardSimInfo() {
  const sims = (state && state.simulations) || [];
  const running = sims.filter(s => s.status === "running");
  const paused = sims.filter(s => s.status === "paused");
  const finished = sims.filter(s => s.status === "finished");
  const events = (state && state.events) || [];

  // Aggregate consumed materials across all simulations
  const allConsumed = {};
  sims.forEach(s => {
    (s.consumedMaterials || []).forEach(m => {
      allConsumed[m.materialType] = (allConsumed[m.materialType] || 0) + m.quantity;
    });
  });

  const plannedCount = events.filter(e => e.status === "planned").length;
  const runningCount = events.filter(e => e.status === "running").length;

  let html = `<div id="dashSimInfo" style="margin-top:12px">
    <div style="display:flex;gap:12px;flex-wrap:wrap;padding:10px 14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm)">`;

  html += `<span style="font-size:12px;color:var(--ink-secondary)">
    仿真状态：<strong style="color:var(--ink)">${running.length}</strong> 运行中
    <strong style="color:var(--ink);margin-left:6px">${paused.length}</strong> 暂停
    <strong style="color:var(--ink);margin-left:6px">${finished.length}</strong> 已完成
  </span>`;

  html += `<span style="font-size:12px;color:var(--ink-secondary)">
    事件状态：<strong style="color:var(--ink)">${runningCount}</strong> 进行中
    <strong style="color:var(--ink);margin-left:6px">${plannedCount}</strong> 待处理
  </span>`;

  const matEntries = Object.entries(allConsumed);
  if (matEntries.length > 0) {
    html += `<span style="font-size:12px;color:var(--ink-secondary)">
      📦 累计消耗材料：${matEntries.map(([type, qty]) => `${type}<strong style="color:var(--ink)">×${(+qty).toFixed(1)}</strong>`).join(" ")}
    </span>`;
  }

  html += `</div></div>`;

  const existing = document.getElementById("dashSimInfo");
  if (existing) existing.outerHTML = html;
  else document.querySelector(".svg-wrapper").insertAdjacentHTML("beforebegin", html);
}

let currentFilter = "all";

const STATUS_COLORS = {
  normal: "#4caf50", congested: "#ff9800", damaged: "#e53935",
  closed: "#78909c", repairing: "#1e88e5", recovered: "#66bb6a"
};
const STATUS_DASH = { closed: "8,5" };

function buildSvgHtml(svgSuffix, applyFilter) {
  const nodes = state.nodes || [];
  const edges = state.edges || [];
  const events = state.events || [];
  const teams = state.teams || [];

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  let html = "";

  // Subtle background grid (unique defs id to avoid conflict if both SVGs share page)
  html += `<defs><pattern id="grid-${svgSuffix}" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(26,26,46,0.04)" stroke-width="1"/>
  </pattern></defs>`;
  html += `<rect width="700" height="420" fill="url(#grid-${svgSuffix})"/>`;

  // Edges (only apply status filter for dashboard SVG)
  edges.forEach(e => {
    const from = nodeMap[e.fromNode], to = nodeMap[e.toNode];
    if (!from || !to) return;
    if (applyFilter && currentFilter !== "all" && e.status !== currentFilter) return;
    const color = STATUS_COLORS[e.status] || "#999";
    html += `<line class="edge-line" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"
      stroke="${color}" stroke-dasharray="${STATUS_DASH[e.status] || ""}"
      data-edge-id="${e.id}"><title>${e.id}: ${e.status} (∝ ${e.length}km, ${e.speed}km/h)</title></line>`;
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    html += `<text class="edge-label" x="${mx}" y="${my - 7}" text-anchor="middle">${e.id}</text>`;
  });

  // Event markers (red diamond)
  events.filter(ev => ev.status !== "finished" && ev.status !== "cancelled").forEach(ev => {
    const edge = edges.find(e => e.id === ev.roadId);
    if (!edge) return;
    const from = nodeMap[edge.fromNode], to = nodeMap[edge.toNode];
    if (!from || !to) return;
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const size = ev.severity === "high" ? 14 : ev.severity === "medium" ? 11 : 8;
    html += `<polygon class="event-marker" points="${mx},${my - size} ${mx + size},${my} ${mx},${my + size} ${mx - size},${my}"
      fill="#e53935" fill-opacity="0.85" stroke="#b71c1c" stroke-width="1.5"
      data-event-id="${ev.id}"><title>${ev.type} — ${ev.roadId} [${ev.status}]</title></polygon>`;
  });

  // Team markers (skip if simulation overlay handles them)
  const hasActiveSim = (state.simulations || []).some(s =>
    s.eventId === currentEventId && (s.status === "running" || s.status === "paused" || s.status === "finished")
  );
  if (!hasActiveSim) {
    teams.filter(t => t.status !== "offline").forEach(t => {
      const node = nodeMap[t.locationNode];
      if (!node) return;
      const cy = node.y - 20;
      const busy = t.status === "busy";
      html += `<g class="team-marker" data-team-id="${t.id}">
        <circle cx="${node.x}" cy="${cy}" r="10" fill="${busy ? "#ff8f00" : "#1565c0"}" stroke="#fff" stroke-width="2"/>
        <text x="${node.x}" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">T</text>
        <title>${t.name} @ ${t.locationNode} [${t.status}]</title>
      </g>`;
    });
  }

  // Nodes
  const nodeFill = { intersection: "#fff", station: "#fff8e1", depot: "#e8f5e9" };
  const nodeStroke = { intersection: "#546e7a", station: "#f57c00", depot: "#388e3c" };
  nodes.forEach(n => {
    html += `<circle class="node-circle" cx="${n.x}" cy="${n.y}" r="8"
      fill="${nodeFill[n.type] || "#fff"}" stroke="${nodeStroke[n.type] || "#546e7a"}" stroke-width="2.5"
      data-node-id="${n.id}">
      <title>${n.id}: ${n.name} (${n.type})</title></circle>`;
    html += `<text class="node-label" x="${n.x}" y="${n.y + 20}" text-anchor="middle">${n.name}</text>`;
  });

  return html;
}

function renderSvgMap() {
  document.getElementById("roadMap").innerHTML = buildSvgHtml("dash", true);
  renderLegend();
}

function renderSimSvg() {
  const svg = document.getElementById("simRoadMap");
  if (!svg) return;
  svg.innerHTML = buildSvgHtml("sim", false);
}

function renderLegend() {
  const container = document.querySelector(".svg-legend");
  container.innerHTML = Object.entries(STATUS_COLORS).map(([k, v]) =>
    `<span class="legend-item">
      <span class="legend-dot" style="background:${v}${k === "closed" ? ";border:2px dashed #546e7a;background:transparent" : ""}"></span>
      ${k}
    </span>`
  ).join("");
}

// Filter
document.getElementById("statusFilter").addEventListener("click", e => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  currentFilter = btn.dataset.status;
  renderSvgMap();
});

/* ==================================================================
   Tab 2: Events
   ================================================================== */
async function renderEventList() {
  const tbody = document.getElementById("eventTableBody");
  if (!state) return;
  const events = state.events || [];
  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><span class="empty-icon">📋</span><p>暂无事件，点击「新建事件」或「加载预置场景」开始。</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = events.map(ev => {
    const editable = ev.status === "created" || ev.status === "planned";
    return `<tr>
      <td><strong>${ev.id}</strong></td>
      <td>${ev.type}</td>
      <td>${ev.roadId}</td>
      <td>${ev.severity}</td>
      <td><span class="status-pill ${ev.status}">${ev.status}</span></td>
      <td>${ev.blocked ? "是" : "否"}</td>
      <td>
        ${editable ? `<button class="btn btn-sm" onclick="editEvent('${ev.id}')">编辑</button> ` : ""}
        <button class="btn btn-sm" onclick="deleteEvent('${ev.id}')">删除</button>
      </td>
    </tr>`;
  }).join("");
}

// Scenario
document.getElementById("loadScenarioBtn").addEventListener("click", async () => {
  showLoading();
  const result = await apiGet("/api/scenarios");
  hideLoading();
  if (!checkResult(result)) return;
  const scenarios = result.data || [];
  const sel = document.getElementById("scenarioSelect");
  sel.innerHTML = scenarios.map(s => `<option value="${s.id}">${s.id}: ${s.type} → ${s.roadId} (${s.severity})</option>`).join("");
  document.getElementById("scenarioPanel").style.display = "flex";
});
document.getElementById("cancelScenarioBtn").addEventListener("click", () => {
  document.getElementById("scenarioPanel").style.display = "none";
});
document.getElementById("confirmScenarioBtn").addEventListener("click", async () => {
  if (isSubmitting) return;
  isSubmitting = true;
  const scenarioId = document.getElementById("scenarioSelect").value;
  showLoading();
  const result = await apiPost("/api/scenarios/load", { scenarioId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  currentEventId = result.data?.id || null;
  toast("场景已加载");
  document.getElementById("scenarioPanel").style.display = "none";
  await loadState();
});

// Create / Edit Event
document.getElementById("createEventBtn").addEventListener("click", () => {
  document.getElementById("eventFormTitle").textContent = "新建事件";
  document.getElementById("efEventId").value = "";
  document.getElementById("efType").value = "road_collapse";
  document.getElementById("efSeverity").value = "high";
  document.getElementById("efStartTime").value = "";
  document.getElementById("efRoadId").value = "";
  document.getElementById("efWorkload").value = "";
  document.getElementById("efBlocked").value = "true";
  document.getElementById("efSubmitBtn").textContent = "提交";
  document.getElementById("eventFormPanel").style.display = "block";
});
document.getElementById("efCancelBtn").addEventListener("click", () => {
  document.getElementById("eventFormPanel").style.display = "none";
});
document.getElementById("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const editId = document.getElementById("efEventId").value;
  const body = {
    type: document.getElementById("efType").value,
    severity: document.getElementById("efSeverity").value,
    startTime: document.getElementById("efStartTime").value,
    roadId: document.getElementById("efRoadId").value,
    workload: parseFloat(document.getElementById("efWorkload").value),
    blocked: document.getElementById("efBlocked").value === "true"
  };
  showLoading();
  let result;
  if (editId) {
    result = await apiPut(`/api/events/${editId}`, body);
  } else {
    result = await apiPost("/api/events", body);
  }
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  if (!editId) currentEventId = result.data?.id || null;
  document.getElementById("eventFormPanel").style.display = "none";
  toast(editId ? "事件已更新" : "事件已创建");
  await loadState();
});

function editEvent(id) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  document.getElementById("eventFormTitle").textContent = "编辑事件";
  document.getElementById("efEventId").value = ev.id;
  document.getElementById("efType").value = ev.type;
  document.getElementById("efSeverity").value = ev.severity;
  document.getElementById("efStartTime").value = ev.startTime;
  document.getElementById("efRoadId").value = ev.roadId;
  document.getElementById("efWorkload").value = ev.workload;
  document.getElementById("efBlocked").value = ev.blocked ? "true" : "false";
  document.getElementById("efSubmitBtn").textContent = "更新";
  document.getElementById("eventFormPanel").style.display = "block";
}

async function deleteEvent(id) {
  if (!confirm(`确定删除事件 ${id}？`)) return;
  showLoading();
  const result = await apiDel(`/api/events/${id}`);
  hideLoading();
  if (!checkResult(result)) return;
  toast("事件已删除");
  await loadState();
}

/* ==================================================================
   Tab 3: Network Management
   ================================================================== */
async function renderNetworkManage() {
  if (!state) return;
  const nodes = state.nodes || [];
  const nbody = document.getElementById("nodeTableBody");
  if (nodes.length === 0) {
    nbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><span class="empty-icon">🗺️</span><p>暂无节点。</p></div></td></tr>';
  } else {
    nbody.innerHTML = nodes.map(n => `<tr>
      <td><strong>${n.id}</strong></td><td>${n.name}</td><td>${n.x}</td><td>${n.y}</td><td>${n.type}</td>
      <td><button class="btn btn-sm" onclick="editNode('${n.id}')">编辑</button> <button class="btn btn-sm" onclick="deleteNode('${n.id}')">删除</button></td>
    </tr>`).join("");
  }
  const edges = state.edges || [];
  const ebody = document.getElementById("edgeTableBody");
  if (edges.length === 0) {
    ebody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><span class="empty-icon">🛣️</span><p>暂无路段。</p></div></td></tr>';
  } else {
    ebody.innerHTML = edges.map(e => `<tr>
      <td><strong>${e.id}</strong></td><td>${e.fromNode}</td><td>${e.toNode}</td>
      <td>${e.length}</td><td>${e.speed}</td><td>${e.flow}</td>
      <td><span class="status-pill ${e.status}">${e.status}</span></td>
      <td><button class="btn btn-sm" onclick="editEdge('${e.id}')">编辑</button> <button class="btn btn-sm" onclick="deleteEdge('${e.id}')">删除</button></td>
    </tr>`).join("");
  }
}

// Node CRUD
document.getElementById("createNodeBtn").addEventListener("click", () => {
  document.getElementById("nodeFormTitle").textContent = "新建节点";
  document.getElementById("nfNodeId").value = "";
  ["nfId","nfName","nfX","nfY"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("nfType").value = "intersection";
  document.getElementById("nfSubmitBtn").textContent = "提交";
  document.getElementById("nodeFormPanel").style.display = "block";
});
document.getElementById("nfCancelBtn").addEventListener("click", () => document.getElementById("nodeFormPanel").style.display = "none");
document.getElementById("nodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const editId = document.getElementById("nfNodeId").value;
  const body = {
    id: document.getElementById("nfId").value,
    name: document.getElementById("nfName").value,
    x: parseFloat(document.getElementById("nfX").value),
    y: parseFloat(document.getElementById("nfY").value),
    type: document.getElementById("nfType").value
  };
  showLoading();
  let result;
  if (editId) { result = await apiPut(`/api/nodes/${editId}`, body); }
  else { result = await apiPost("/api/nodes", body); }
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("nodeFormPanel").style.display = "none";
  toast(editId ? "节点已更新" : "节点已创建");
  await loadState();
});

function editNode(id) {
  const n = state.nodes.find(x => x.id === id);
  if (!n) return;
  document.getElementById("nodeFormTitle").textContent = "编辑节点";
  document.getElementById("nfNodeId").value = n.id;
  document.getElementById("nfId").value = n.id;
  document.getElementById("nfName").value = n.name;
  document.getElementById("nfX").value = n.x;
  document.getElementById("nfY").value = n.y;
  document.getElementById("nfType").value = n.type;
  document.getElementById("nfSubmitBtn").textContent = "更新";
  document.getElementById("nodeFormPanel").style.display = "block";
}

async function deleteNode(id) {
  if (!confirm(`确定删除节点 ${id}？若被路段/队伍引用将无法删除。`)) return;
  showLoading();
  const result = await apiDel(`/api/nodes/${id}`);
  hideLoading();
  if (!checkResult(result)) return;
  toast("节点已删除");
  await loadState();
}

// Edge CRUD
document.getElementById("createEdgeBtn").addEventListener("click", () => {
  document.getElementById("edgeFormTitle").textContent = "新建路段";
  document.getElementById("efEdgeId").value = "";
  ["efId","efFrom","efTo","efLength","efSpeed","efFlow"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("efStatus").value = "normal";
  document.getElementById("efSubmitBtn").textContent = "提交";
  document.getElementById("edgeFormPanel").style.display = "block";
});
document.getElementById("efCancelBtn").addEventListener("click", () => document.getElementById("edgeFormPanel").style.display = "none");
document.getElementById("edgeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const editId = document.getElementById("efEdgeId").value;
  const body = {
    id: document.getElementById("efId").value,
    fromNode: document.getElementById("efFrom").value,
    toNode: document.getElementById("efTo").value,
    length: parseFloat(document.getElementById("efLength").value),
    speed: parseFloat(document.getElementById("efSpeed").value),
    flow: parseFloat(document.getElementById("efFlow").value),
    status: document.getElementById("efStatus").value
  };
  showLoading();
  let result;
  if (editId) { result = await apiPut(`/api/edges/${editId}`, body); }
  else { result = await apiPost("/api/edges", body); }
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("edgeFormPanel").style.display = "none";
  toast(editId ? "路段已更新" : "路段已创建");
  await loadState();
});

function editEdge(id) {
  const e = state.edges.find(x => x.id === id);
  if (!e) return;
  document.getElementById("edgeFormTitle").textContent = "编辑路段";
  document.getElementById("efEdgeId").value = e.id;
  document.getElementById("efId").value = e.id;
  document.getElementById("efFrom").value = e.fromNode;
  document.getElementById("efTo").value = e.toNode;
  document.getElementById("efLength").value = e.length;
  document.getElementById("efSpeed").value = e.speed;
  document.getElementById("efFlow").value = e.flow;
  document.getElementById("efStatus").value = e.status;
  document.getElementById("efSubmitBtn").textContent = "更新";
  document.getElementById("edgeFormPanel").style.display = "block";
}

async function deleteEdge(id) {
  if (!confirm(`确定删除路段 ${id}？若有事件引用将无法删除。`)) return;
  showLoading();
  const result = await apiDel(`/api/edges/${id}`);
  hideLoading();
  if (!checkResult(result)) return;
  toast("路段已删除");
  await loadState();
}

// Network import/export
document.getElementById("exportNetworkBtn").addEventListener("click", async () => {
  showLoading();
  const result = await apiGet("/api/network/export");
  hideLoading();
  if (!checkResult(result)) return;
  downloadJson("network.json", result.data);
});
document.getElementById("importNetworkBtn").addEventListener("click", () => {
  document.getElementById("networkImportText").value = "";
  document.getElementById("importNetworkPanel").style.display = "block";
});
document.getElementById("cancelNetworkImport").addEventListener("click", () => {
  document.getElementById("importNetworkPanel").style.display = "none";
});
document.getElementById("confirmNetworkImport").addEventListener("click", async () => {
  if (isSubmitting) return;
  const text = document.getElementById("networkImportText").value;
  let data;
  try { data = JSON.parse(text); } catch (e) { toast("JSON 格式错误，请检查后重试。"); return; }
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/network/import", data);
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("importNetworkPanel").style.display = "none";
  toast("路网已导入");
  await loadState();
});

/* ==================================================================
   Tab 4: Resource Management
   ================================================================== */
async function renderResourceManage() {
  if (!state) return;
  const teams = state.teams || [];
  const tbody = document.getElementById("teamTableBody");
  if (teams.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><span class="empty-icon">👷</span><p>暂无队伍。</p></div></td></tr>';
  } else {
    tbody.innerHTML = teams.map(t => `<tr>
      <td><strong>${t.id}</strong></td><td>${t.name}</td><td>${t.locationNode}</td>
      <td>${t.workers}</td><td>${t.vehicles}</td><td>${t.skill}</td>
      <td>${t.efficiency}</td>
      <td><span class="status-pill ${t.status}">${t.status}</span></td>
      <td>${t.status !== "busy" ? `<button class="btn btn-sm" onclick="editTeam('${t.id}')">编辑</button> <button class="btn btn-sm" onclick="deleteTeam('${t.id}')">删除</button>` : '<span style="color:var(--ink-secondary);font-size:12px">工作中</span>'}</td>
    </tr>`).join("");
  }
  const depots = state.depots || [];
  const dbody = document.getElementById("depotTableBody");
  if (depots.length === 0) {
    dbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><span class="empty-icon">📦</span><p>暂无仓库。</p></div></td></tr>';
  } else {
    const maxStock = Math.max(...depots.map(d => d.stock || 0), 1);
    dbody.innerHTML = depots.map(d => {
      const pct = Math.min(100, (d.stock / maxStock) * 100);
      const lowStock = d.stock < 20;
      return `<tr>
        <td><strong>${d.id}</strong></td><td>${d.nodeId}</td><td>${d.materialType}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:${lowStock ? '700' : '500'};color:${lowStock ? '#e53935' : 'inherit'}">${d.stock}</span>
            <div style="flex:1;max-width:80px;height:6px;background:rgba(26,26,46,0.06);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${lowStock ? '#e53935' : '#4caf50'};border-radius:3px"></div>
            </div>
          </div>
        </td>
        <td><button class="btn btn-sm" onclick="editDepot('${d.id}')">编辑</button> <button class="btn btn-sm" onclick="deleteDepot('${d.id}')">删除</button></td>
      </tr>`;
    }).join("");
  }
}

// Team CRUD
document.getElementById("createTeamBtn").addEventListener("click", () => {
  document.getElementById("teamFormTitle").textContent = "新建抢修队伍";
  document.getElementById("tfTeamId").value = "";
  ["tfId","tfName","tfLocation","tfWorkers","tfVehicles","tfEfficiency"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("tfSkill").value = "road_repair";
  document.getElementById("tfStatus").value = "idle";
  document.getElementById("tfSubmitBtn").textContent = "提交";
  document.getElementById("teamFormPanel").style.display = "block";
});
document.getElementById("tfCancelBtn").addEventListener("click", () => document.getElementById("teamFormPanel").style.display = "none");
document.getElementById("teamForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const editId = document.getElementById("tfTeamId").value;
  const body = {
    id: document.getElementById("tfId").value,
    name: document.getElementById("tfName").value,
    locationNode: document.getElementById("tfLocation").value,
    workers: parseInt(document.getElementById("tfWorkers").value),
    vehicles: parseInt(document.getElementById("tfVehicles").value),
    skill: document.getElementById("tfSkill").value,
    efficiency: parseFloat(document.getElementById("tfEfficiency").value),
    status: document.getElementById("tfStatus").value
  };
  showLoading();
  let result;
  if (editId) { result = await apiPut(`/api/teams/${editId}`, body); }
  else { result = await apiPost("/api/teams", body); }
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("teamFormPanel").style.display = "none";
  toast(editId ? "队伍已更新" : "队伍已创建");
  await loadState();
});

function editTeam(id) {
  const t = state.teams.find(x => x.id === id);
  if (!t) return;
  document.getElementById("teamFormTitle").textContent = "编辑队伍";
  document.getElementById("tfTeamId").value = t.id;
  document.getElementById("tfId").value = t.id;
  document.getElementById("tfName").value = t.name;
  document.getElementById("tfLocation").value = t.locationNode;
  document.getElementById("tfWorkers").value = t.workers;
  document.getElementById("tfVehicles").value = t.vehicles;
  document.getElementById("tfSkill").value = t.skill;
  document.getElementById("tfEfficiency").value = t.efficiency;
  document.getElementById("tfStatus").value = t.status;
  document.getElementById("tfSubmitBtn").textContent = "更新";
  document.getElementById("teamFormPanel").style.display = "block";
}

async function deleteTeam(id) {
  if (!confirm(`确定删除队伍 ${id}？`)) return;
  showLoading();
  const result = await apiDel(`/api/teams/${id}`);
  hideLoading();
  if (!checkResult(result)) return;
  toast("队伍已删除");
  await loadState();
}

// Depot CRUD
document.getElementById("createDepotBtn").addEventListener("click", () => {
  document.getElementById("depotFormTitle").textContent = "新建物资仓库";
  document.getElementById("dfDepotId").value = "";
  ["dfId","dfNodeId","dfStock"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("dfMaterial").value = "asphalt";
  document.getElementById("dfSubmitBtn").textContent = "提交";
  document.getElementById("depotFormPanel").style.display = "block";
});
document.getElementById("dfCancelBtn").addEventListener("click", () => document.getElementById("depotFormPanel").style.display = "none");
document.getElementById("depotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  isSubmitting = true;
  const editId = document.getElementById("dfDepotId").value;
  const body = {
    id: document.getElementById("dfId").value,
    nodeId: document.getElementById("dfNodeId").value,
    materialType: document.getElementById("dfMaterial").value,
    stock: parseFloat(document.getElementById("dfStock").value)
  };
  showLoading();
  let result;
  if (editId) { result = await apiPut(`/api/depots/${editId}`, body); }
  else { result = await apiPost("/api/depots", body); }
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("depotFormPanel").style.display = "none";
  toast(editId ? "仓库已更新" : "仓库已创建");
  await loadState();
});

function editDepot(id) {
  const d = state.depots.find(x => x.id === id);
  if (!d) return;
  document.getElementById("depotFormTitle").textContent = "编辑仓库";
  document.getElementById("dfDepotId").value = d.id;
  document.getElementById("dfId").value = d.id;
  document.getElementById("dfNodeId").value = d.nodeId;
  document.getElementById("dfMaterial").value = d.materialType;
  document.getElementById("dfStock").value = d.stock;
  document.getElementById("dfSubmitBtn").textContent = "更新";
  document.getElementById("depotFormPanel").style.display = "block";
}

async function deleteDepot(id) {
  if (!confirm(`确定删除仓库 ${id}？`)) return;
  showLoading();
  const result = await apiDel(`/api/depots/${id}`);
  hideLoading();
  if (!checkResult(result)) return;
  toast("仓库已删除");
  await loadState();
}

// Resources import/export
document.getElementById("exportResourcesBtn").addEventListener("click", async () => {
  showLoading();
  const result = await apiGet("/api/resources/export");
  hideLoading();
  if (!checkResult(result)) return;
  downloadJson("resources.json", result.data);
});
document.getElementById("importResourcesBtn").addEventListener("click", () => {
  document.getElementById("resourcesImportText").value = "";
  document.getElementById("importResourcesPanel").style.display = "block";
});
document.getElementById("cancelResourcesImport").addEventListener("click", () => {
  document.getElementById("importResourcesPanel").style.display = "none";
});
document.getElementById("confirmResourcesImport").addEventListener("click", async () => {
  if (isSubmitting) return;
  const text = document.getElementById("resourcesImportText").value;
  let data;
  try { data = JSON.parse(text); } catch (e) { toast("JSON 格式错误，请检查后重试。"); return; }
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/resources/import", data);
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  document.getElementById("importResourcesPanel").style.display = "none";
  toast("资源已导入");
  await loadState();
});

/* ==================================================================
   Tab 5: Plan & Simulation
   ================================================================== */
async function renderPlanArea() {
  // Render road network SVG in simulation tab
  renderSimSvg();
  const sel = document.getElementById("simEventSelect");
  const events = (state && state.events) || [];
  const currentVal = sel.value;
  const actionableStatuses = ["planned", "created"];
  sel.innerHTML = '<option value="">-- 选择事件 --</option>' + events.map(e =>
    `<option value="${e.id}">${e.id}: ${e.type} → ${e.roadId} [${e.status}]${actionableStatuses.includes(e.status) ? ' 📋' : ''}</option>`
  ).join("");
  if (currentVal && [...sel.options].some(o => o.value === currentVal)) sel.value = currentVal;
  if (events.length > 0 && !sel.value) {
    // Prefer an event that can generate plans (planned/created), fallback to first
    const actionable = events.find(e => actionableStatuses.includes(e.status));
    sel.value = actionable ? actionable.id : events[0].id;
    currentEventId = sel.value;
  }
  // 自动加载已存在的方案
  if (currentEventId) {
    await loadExistingPlans(currentEventId);
  }
  updateSimStatus();
}

document.getElementById("simEventSelect").addEventListener("change", async () => {
  currentEventId = document.getElementById("simEventSelect").value;
  // Keep sim controls visible — only reload plans for the new event
  document.getElementById("planCards").innerHTML = "";
  const phaseEl = document.getElementById("simPhaseDisplay");
  if (phaseEl) phaseEl.remove();
  currentSimulationId = null;
  document.getElementById("simControlArea").style.display = "none";
  if (currentEventId) {
    await loadExistingPlans(currentEventId);
    updateSimStatus();
  }
});

function switchToEvent(eventId) {
  const sel = document.getElementById("simEventSelect");
  sel.value = eventId;
  sel.dispatchEvent(new Event("change"));
}

async function loadExistingPlans(eventId) {
  if (!eventId) return;
  showLoading();
  const result = await apiGet(`/api/plans/${eventId}`);
  hideLoading();
  if (!checkResult(result)) return;
  if (result.data && result.data.length > 0) {
    renderPlanCards(result.data);
  } else {
    document.getElementById("planCards").innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>暂无可用方案。点击「生成方案」生成。</p></div>';
  }
}

document.getElementById("generatePlanBtn").addEventListener("click", async () => {
  if (!currentEventId) { toast("请先选择事件"); return; }
  // Check event status before calling backend
  const curEvent = state?.events?.find(e => e.id === currentEventId);
  if (curEvent && !["created", "planned"].includes(curEvent.status)) {
    toast(`事件 ${currentEventId} 状态为 ${curEvent.status}，无法生成方案。请选择 created 或 planned 状态的事件。`);
    return;
  }
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/plans/generate", { eventId: currentEventId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  toast("方案已生成");
  await loadState();
});

function renderPlanCards(plans) {
  const container = document.getElementById("planCards");
  if (!plans || plans.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>暂无可用方案。请确保有 idle 状态的队伍。</p></div>';
    return;
  }
  // Check if current event already has any running/paused/finished sim
  const anySim = (state?.simulations || []).some(s => s.eventId === currentEventId && (s.status === "running" || s.status === "paused" || s.status === "finished"))
    || pendingSyncStarts.some(p => p.eventId === currentEventId);
  const mySelectedPlanId = eventPlanSelections[currentEventId];

  container.innerHTML = plans.map(p => {
    const isRec = p.isRecommended;
    const mf = p.materialFeasible;
    const shortage = p.materialShortage || [];
    const materials = p.requiredMaterials || [];
    const isSelected = p.id === mySelectedPlanId;
    const cardClass = `${isRec ? 'recommended' : ''} ${mf === false ? 'material-warn' : ''} ${isSelected ? 'selected' : ''}`;

    let actionsArea = '';
    if (anySim) {
      // Simulation phase: show sim controls per card
      const mySim = (state?.simulations || []).find(s => s.planId === p.id && s.status !== "reset");
      if (!mySim) {
        const isPending = pendingSyncStarts.some(pe => pe.eventId === currentEventId && pe.planId === p.id);
        if (isPending) {
          actionsArea = `<span class="sim-inline-status" style="color:#ff8f00;background:rgba(255,143,0,0.1)">⏳ 等待资源...</span>`;
        } else {
          actionsArea = `<span class="sim-inline-status" style="color:var(--ink-secondary)">未参与同步仿真</span>`;
        }
      } else if (mySim.status === "running") {
        actionsArea = `<span class="sim-inline-status running">● 仿真中</span>
          <button class="btn btn-sm" onclick="simAction('pause','${mySim.id}')">⏸ 暂停</button>
          <button class="btn btn-sm" onclick="simAction('reset','${mySim.id}')">↻ 重置</button>`;
      } else if (mySim.status === "paused") {
        actionsArea = `<span class="sim-inline-status paused">⏸ 已暂停</span>
          <button class="btn btn-primary btn-sm" onclick="simAction('resume','${mySim.id}')">▶ 继续</button>
          <button class="btn btn-sm" onclick="simAction('reset','${mySim.id}')">↻ 重置</button>`;
      } else if (mySim.status === "finished") {
        actionsArea = `<span class="sim-inline-status finished">✓ 已完成</span>
          <button class="btn btn-sm" onclick="simAction('reset','${mySim.id}')">↻ 重置</button>`;
      }
    } else {
      // Selection phase: show select/selected button
      if (isSelected) {
        actionsArea = `<span class="selected-badge-inline">✓ 已选</span>
          <button class="btn btn-sm" onclick="unselectPlan('${p.id}')">取消</button>`;
      } else {
        actionsArea = `<button class="btn btn-primary btn-sm" onclick="selectPlanForEvent('${p.id}')">选择此方案</button>`;
      }
    }

    return `<div class="plan-card ${cardClass}" data-plan-id="${p.id}">
      ${isRec ? '<span class="plan-badge">★ 推荐</span>' : ''}
      ${mf === false ? '<span class="plan-badge badge-warn">⚠ 库存不足</span>' : ''}
      <h4>${p.strategyName}</h4>
      <div class="plan-stat">策略 <strong>${p.strategy}</strong></div>
      <div class="plan-stat">参与队伍 <strong>${(p.teams || []).join(", ")}</strong></div>
      <div class="plan-stat">路径 <strong>${(p.route || []).join(" → ") || "直达"}</strong></div>
      <div class="plan-stat-row">
        <span>🕐 到达 <strong>${p.arrivalTime} min</strong></span>
        <span>🔧 修复 <strong>${p.repairTime} min</strong></span>
        <span>⏱ 总计 <strong>${p.totalTime} min</strong></span>
      </div>
      <div class="plan-stat-row">
        <span>💰 成本 <strong>${p.cost}</strong></span>
        <span>🚗 影响 <strong>${p.affectedVehicles}辆</strong></span>
        <span>⚠ 风险 <strong>${(p.riskPenalty || 0).toFixed(2)}</strong></span>
      </div>
      ${materials.length > 0 ? `<div class="plan-stat">📦 所需物资 <strong>${materials.map(m => `${m.materialType}×${m.quantity}`).join(", ")}</strong></div>` : ""}
      ${shortage.length > 0 ? `<div class="plan-stat plan-shortage">⛔ 库存短缺：${shortage.map(s => `${s.materialType} 缺 ${s.missing}`).join("；")}</div>` : ""}
      <div class="plan-score-row">
        <span class="plan-score-label">综合评分</span>
        <span class="plan-score-value">${(p.score || 0).toFixed(4)}</span>
        <span class="plan-score-hint">(越低越优)</span>
      </div>
      <div class="plan-stat" style="margin-top:6px; font-style:italic; color:var(--ink); border-top:1px solid var(--line); padding-top:6px">${p.reason}</div>
      <div class="plan-sim-actions">${actionsArea}</div>
    </div>`;
  }).join("");
  renderSelectionSummary();
}

/* ===== Plan Selection ===== */
function selectPlanForEvent(planId) {
  eventPlanSelections[currentEventId] = planId;
  loadExistingPlans(currentEventId);
}
function unselectPlan(planId) {
  delete eventPlanSelections[currentEventId];
  loadExistingPlans(currentEventId);
}

function renderSelectionSummary() {
  const area = document.getElementById("selectionSummary");
  const entries = Object.entries(eventPlanSelections);
  const events = state?.events || [];
  const plans = state?.plans || [];
  const sims = state?.simulations || [];

  if (entries.length === 0) {
    area.style.display = "none";
    return;
  }
  area.style.display = "block";

  // Check if any sims are active for the selected events
  const activeSimIds = entries.map(([eid]) => sims.filter(s => s.eventId === eid && s.status !== "reset").map(s => s.id)).flat();
  const hasActiveSims = activeSimIds.length > 0 || pendingSyncStarts.length > 0;
  // Find entries that don't have active sims yet (can still be started)
  const pendingEntries = entries.filter(([eid]) => {
    const hasSim = sims.some(s => s.eventId === eid && s.status !== "reset");
    const isPending = pendingSyncStarts.some(p => p.eventId === eid);
    return !hasSim && !isPending;
  });
  const hasPendingEntries = pendingEntries.length > 0;

  area.innerHTML = `<div class="summary-header">
    <h3>已选方案（${entries.length} 个事件）</h3>
    <div style="display:flex;gap:8px">
      ${hasPendingEntries
        ? `<button class="btn btn-primary" id="startRemainingBtn">▶ 启动剩余 (${pendingEntries.length})</button>`
        : ''
      }
      ${hasActiveSims || hasPendingEntries
        ? `<button class="btn" id="resetAllBtn">↻ 全部重置</button>`
        : `<button class="btn btn-primary" id="startSyncBtn">▶ 开始同步仿真</button>`
      }
    </div>
  </div>
  <div class="summary-list">${entries.map(([eid, pid]) => {
    const ev = events.find(e => e.id === eid);
    const pl = plans.find(p => p.id === pid);
    const sim = sims.find(s => s.eventId === eid && s.status !== "reset");
    const isPending = pendingSyncStarts.some(p => p.eventId === eid && p.planId === pid);
    let simStatus = "", simColor = "";
    if (isPending) { simStatus = "⏳ 等待资源"; simColor = "#ff8f00"; }
    else if (sim) { simStatus = sim.status === "running" ? "● 仿真中" : sim.status === "paused" ? "⏸ 已暂停" : "✓ 已完成"; simColor = sim.status === "running" ? "#1e88e5" : sim.status === "paused" ? "#ff8f00" : "#4caf50"; }
    return `<span class="summary-chip" data-event-id="${eid}" onclick="switchToEvent('${eid}')">${ev ? ev.id : eid}: ${pl ? pl.strategyName : pid}${simStatus ? ` <span style="color:${simColor}">${simStatus}</span>` : ''}</span>`;
  }).join("")}</div>`;
  const startBtn = document.getElementById("startSyncBtn");
  if (startBtn) startBtn.onclick = startSyncSimulation;
  const remainBtn = document.getElementById("startRemainingBtn");
  if (remainBtn) remainBtn.onclick = startRemainingSims;
  const resetBtn = document.getElementById("resetAllBtn");
  if (resetBtn) resetBtn.onclick = resetAllSims;
}

async function resetAllSims() {
  pendingSyncStarts = [];
  const sims = state?.simulations || [];
  const activeSims = sims.filter(s => s.status === "running" || s.status === "paused" || s.status === "finished");
  if (activeSims.length === 0) {
    await loadState();
    toast("已清除等待中的仿真");
    return;
  }
  if (!confirm(`确定重置全部 ${activeSims.length} 个仿真？将恢复到仿真开始前的状态。`)) return;

  const results = await Promise.allSettled(
    activeSims.map(s =>
      fetch("/api/simulation/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ simulationId: s.id })
      }).then(r => r.json())
    )
  );
  const successCount = results.filter(r => r.status === "fulfilled" && r.value.code === 200).length;
  toast(`重置完成：${successCount}/${activeSims.length} 成功`);

  currentSimulationId = null;
  const phaseEl = document.getElementById("simPhaseDisplay");
  if (phaseEl) phaseEl.remove();
  document.getElementById("simControlArea").style.display = "none";
  await loadState();
}

async function startRemainingSims() {
  const entries = Object.entries(eventPlanSelections);
  const sims = state?.simulations || [];
  // Only start entries without active sims (and not already pending)
  const pending = entries.filter(([eid]) => {
    const hasSim = sims.some(s => s.eventId === eid && s.status !== "reset");
    const isPending = pendingSyncStarts.some(p => p.eventId === eid);
    return !hasSim && !isPending;
  });
  if (pending.length === 0) { toast("没有需要启动的仿真"); return; }

  // Check material feasibility (same as startSyncSimulation)
  const plans = state?.plans || [];
  const shortages = [];
  for (const [, pid] of pending) {
    const pl = plans.find(p => p.id === pid);
    if (pl && pl.materialFeasible === false) {
      shortages.push(`${pl.id} (${pl.strategyName}): ${(pl.materialShortage || []).map(s => `${s.materialType}缺${s.missing}`).join("、")}`);
    }
  }
  if (shortages.length > 0) {
    if (!confirm(`⚠ 以下方案库存不足：\n${shortages.join("\n")}\n\n是否仍然启动？`)) return;
  }

  let successCount = 0;
  for (const [eid, pid] of pending) {
    if (isSubmitting) { await new Promise(r => setTimeout(r, 100)); }
    const r = await apiPost("/api/simulation/start", { eventId: eid, planId: pid });
    if (r.code === 200) { successCount++; }
    else { pendingSyncStarts.push({ eventId: eid, planId: pid, reason: r.message }); }
  }
  if (pendingSyncStarts.length > 0) {
    toast(`${successCount} 个启动成功，${pendingSyncStarts.length} 个等待资源释放后自动启动`);
  } else {
    toast("仿真已全部启动");
  }
  await loadState();
}

async function startSyncSimulation() {
  const entries = Object.entries(eventPlanSelections);
  if (entries.length === 0) { toast("请先为事件选择方案"); return; }

  // Check material feasibility
  const plans = state?.plans || [];
  const shortages = [];
  for (const [, pid] of entries) {
    const pl = plans.find(p => p.id === pid);
    if (pl && pl.materialFeasible === false) {
      shortages.push(`${pl.id} (${pl.strategyName}): ${(pl.materialShortage || []).map(s => `${s.materialType}缺${s.missing}`).join("、")}`);
    }
  }
  if (shortages.length > 0) {
    if (!confirm(`⚠ 以下方案库存不足：\n${shortages.join("\n")}\n\n是否仍然启动？`)) return;
  }

  pendingSyncStarts = [];
  let successCount = 0;
  for (const [eid, pid] of entries) {
    if (isSubmitting) { await new Promise(r => setTimeout(r, 100)); }
    const r = await apiPost("/api/simulation/start", { eventId: eid, planId: pid });
    if (r.code === 200) {
      successCount++;
    } else {
      pendingSyncStarts.push({ eventId: eid, planId: pid, reason: r.message });
    }
  }
  if (pendingSyncStarts.length > 0) {
    toast(`${successCount} 个仿真启动成功，${pendingSyncStarts.length} 个等待资源释放后自动启动`);
  } else {
    toast("同步仿真已全部启动");
  }
  // Track the last started sim for display
  const lastSuccess = entries.find(([eid]) => !pendingSyncStarts.some(p => p.eventId === eid));
  const lastSim = lastSuccess ? (state?.simulations || []).find(s => s.eventId === lastSuccess[0] && s.status === "running") : null;
  currentSimulationId = lastSim ? lastSim.id : null;
  await loadState();
  if (currentSimulationId) {
    const updated = (state?.simulations || []).find(s => s.id === currentSimulationId);
    if (updated) renderSimulation(updated);
  }
}

/* ===== Per-Plan Simulation Controls (post-sync) ===== */
async function simAction(action, simId) {
  if (isSubmitting) return;
  isSubmitting = true; showLoading();
  let result;
  if (action === 'step') result = await apiPost("/api/simulation/step", { simulationId: simId });
  else if (action === 'pause') result = await apiPost("/api/simulation/pause", { simulationId: simId });
  else if (action === 'resume') result = await apiPost("/api/simulation/resume", { simulationId: simId });
  else if (action === 'reset') result = await apiPost("/api/simulation/reset", { simulationId: simId });
  hideLoading(); isSubmitting = false;
  if (!checkResult(result)) return;
  currentSimulationId = action === 'reset' ? null : simId;
  const phaseEl = document.getElementById("simPhaseDisplay");
  if (action === 'reset' && phaseEl) phaseEl.remove();
  if (action === 'reset') document.getElementById("simControlArea").style.display = "none";
  await loadState();
  if (currentSimulationId) renderSimulation(result.data);
}

// Speed buttons
document.querySelectorAll(".speed-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".speed-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const speed = parseInt(btn.dataset.speed);
    const sims = state?.simulations || [];
    const activeSims = sims.filter(s => s.status === "running" || s.status === "paused");
    if (activeSims.length > 0) {
      showLoading();
      // Set speed on all active sims
      const results = await Promise.allSettled(
        activeSims.map(s => fetch("/api/simulation/speed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ simulationId: s.id, speed })
        }).then(r => r.json()))
      );
      hideLoading();
      toast(`倍速已切换为 ${speed}x（${activeSims.length} 个仿真）`);
      await loadState();
      if (currentSimulationId) {
        const updated = (state?.simulations || []).find(s => s.id === currentSimulationId);
        if (updated) renderSimulation(updated);
      }
    }
  });
});

function renderSimulation(sim) {
  if (!sim) return;
  const area = document.getElementById("simControlArea");
  area.style.display = "block";
  currentSimulationId = sim.id;
  document.getElementById("progressFill").style.width = Math.min(sim.progress || 0, 100) + "%";
  document.getElementById("progressText").textContent = (sim.progress || 0).toFixed(1) + "%";

  // Phase display
  const phase = sim.phase || "dispatch";
  const phaseNames = {dispatch:"派遣中", travel:"行进中", repairing:"修复中", finishing:"收尾中", finished:"已完成"};
  const phaseEl = document.getElementById("simPhaseDisplay") || (() => {
    const el = document.createElement("div"); el.id = "simPhaseDisplay";
    document.querySelector(".sim-progress-area").before(el);
    return el;
  })();
  phaseEl.innerHTML = `
    <div class="sim-info-row">
      <div class="sim-info-item">阶段 <span class="sim-phase-badge ${phase}">${phaseNames[phase] || phase}</span></div>
      <div class="sim-info-item">影响车辆 <strong id="simAffectedVehicles">${sim.currentAffectedVehicles || 0}</strong></div>
      <div class="sim-info-item">道路状态 <strong style="color:${STATUS_COLORS[sim.roadStatus] || '#999'}">${sim.roadStatus || "--"}</strong></div>
      <div class="sim-info-item">当前时间 <strong>${sim.currentTime || 0} min</strong></div>
    </div>`;
  if (sim.consumedMaterials && sim.consumedMaterials.length > 0) {
    phaseEl.innerHTML += `<div class="sim-materials">📦 已消耗材料：${sim.consumedMaterials.map(m => `${m.materialType}×${m.quantity}`).join(", ")}</div>`;
  }

  const logs = sim.logs || [];
  const logBox = document.getElementById("simLogs");
  if (logs.length === 0) {
    logBox.innerHTML = '<div class="sim-log-placeholder">仿真日志将在此显示。</div>';
  } else {
    logBox.innerHTML = logs.map(l => `<div>${l}</div>`).join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  // Render road map and SVG overlay on both dash and sim tab
  renderSimSvg();
  renderSimOnMap(sim);

  // Auto-polling: step ALL running sims across events
  const anyRunning = (state?.simulations || []).some(s => s.status === "running");
  if (anyRunning && !simPollTimer) {
    startSimPolling();
  } else if (!anyRunning && simPollTimer) {
    stopSimPolling();
  }

  updateSimStatus();
}

function startSimPolling() {
  if (simPollTimer) clearInterval(simPollTimer);
  simPollTimer = setInterval(async () => {
    if (isSubmitting) return;
    const sims = state?.simulations || [];
    const runningSims = sims.filter(s => s.status === "running");

    if (runningSims.length > 0) {
      // Step all running simulations in parallel
      isSubmitting = true;
      await Promise.allSettled(
        runningSims.map(sim =>
          fetch("/api/simulation/step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ simulationId: sim.id })
          }).then(r => r.json())
        )
      );
      isSubmitting = false;

      await loadState();
    } else if (pendingSyncStarts.length > 0) {
      // No running sims, but may need to retry pending — refresh state first
      await loadState();
    }

    // Auto-retry pending simulation starts when resources may have freed up
    if (pendingSyncStarts.length > 0) {
      const stillPending = [];
      for (const pending of pendingSyncStarts) {
        const r = await apiPost("/api/simulation/start", { eventId: pending.eventId, planId: pending.planId });
        if (r.code !== 200) stillPending.push(pending);
      }
      if (stillPending.length < pendingSyncStarts.length) {
        pendingSyncStarts = stillPending;
        if (pendingSyncStarts.length === 0) toast("所有等待中的仿真已自动启动");
        await loadState();
      } else {
        pendingSyncStarts = stillPending;
      }
    }

    // Re-render the focused simulation if any
    if (currentSimulationId) {
      const updated = (state?.simulations || []).find(s => s.id === currentSimulationId);
      if (updated) renderSimulation(updated);
    }

    // Stop polling when nothing is active
    const hasAnyActive = (state?.simulations || []).some(s => s.status !== "reset");
    if (!hasAnyActive && pendingSyncStarts.length === 0 && simPollTimer) {
      stopSimPolling();
    }
  }, 3000);
}

function stopSimPolling() {
  if (simPollTimer) {
    clearInterval(simPollTimer);
    simPollTimer = null;
  }
}

function renderSimOnMap(sim) {
  addSimOverlayToSvg(document.getElementById("roadMap"), sim);
  addSimOverlayToSvg(document.getElementById("simRoadMap"), sim);
}

function addSimOverlayToSvg(svg, sim) {
  if (!svg) return;
  // Remove previous sim overlays
  svg.querySelectorAll(".sim-overlay").forEach(el => el.remove());
  if (!sim || !state) return;

  const st = sim.status || "unknown";
  if (st === "ready" || st === "reset") return;

  const nodes = state.nodes || [];
  const edges = state.edges || [];
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  let overlayHtml = "";

  // Find plan route for this simulation
  let planRoute = [];
  const currentPlans = state.plans || [];
  const plan = currentPlans.find(p => p.id === sim.planId);
  if (plan && plan.route && plan.route.length > 0) {
    planRoute = plan.route;
  }

  // Draw plan route (glow + dashed line)
  if (planRoute.length >= 2) {
    const pts = planRoute.map(id => nodeMap[id]).filter(n => n);
    const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    overlayHtml += `<path class="sim-overlay sim-route-glow" d="${pathD}"/>`;
    overlayHtml += `<path class="sim-overlay sim-route-path" d="${pathD}"/>`;
  }

  // Highlight the affected road
  const roadId = sim.roadId;
  if (roadId) {
    const edge = edges.find(e => e.id === roadId);
    if (edge) {
      const from = nodeMap[edge.fromNode], to = nodeMap[edge.toNode];
      if (from && to) {
        overlayHtml += `<line class="sim-overlay sim-affected-road" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`;
      }
    }
  }

  // Draw team positions from sim data
  const teamPositions = sim.teamPositions || {};
  Object.entries(teamPositions).forEach(([teamId, nodeId]) => {
    const node = nodeMap[nodeId];
    if (!node) return;
    const busy = st === "running" || st === "paused";
    overlayHtml += `<g class="sim-overlay sim-team-marker" data-team-id="${teamId}">
      <circle cx="${node.x}" cy="${node.y - 20}" r="12" fill="${busy ? "#ff6f00" : "#4caf50"}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="${node.x}" cy="${node.y - 20}" r="5" fill="#fff" opacity="0.6"/>
      <text class="sim-team-label" x="${node.x}" y="${node.y - 17}">${teamId}</text>
    </g>`;
  });

  // Progress indicator near event site
  if (roadId && sim.progress > 0) {
    const edge = edges.find(e => e.id === roadId);
    if (edge) {
      const from = nodeMap[edge.fromNode], to = nodeMap[edge.toNode];
      if (from && to) {
        const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
        overlayHtml += `<rect class="sim-overlay sim-progress-bg" x="${mx - 22}" y="${my - 32}" width="44" height="18"/>
          <text class="sim-overlay sim-progress-dot" x="${mx}" y="${my - 19}" text-anchor="middle">${sim.progress.toFixed(0)}%</text>`;
      }
    }
  }

  if (overlayHtml) {
    svg.insertAdjacentHTML("beforeend", overlayHtml);
  }
}

function updateSimStatus() {
  const bar = document.getElementById("simStatusBar");
  const text = document.getElementById("simStatusText");
  if (!state) return;
  const sims = state.simulations || [];
  // Find the active (non-reset) simulation for this event, preferring the latest
  const eventSim = sims.filter(s => s.eventId === currentEventId && s.status !== "reset").pop();
  const anyActive = sims.some(s => s.status !== "reset");
  const runningCount = sims.filter(s => s.status === "running").length;

  if (eventSim && eventSim.status !== "reset") {
    bar.style.display = "block";
    text.textContent = `${eventSim.id}: ${eventSim.status} — 进度 ${(eventSim.progress || 0).toFixed(1)}%`;
    const area = document.getElementById("simControlArea");
    if (area.style.display === "none" || !area.style.display) {
      currentSimulationId = eventSim.id;
      renderSimulation(eventSim);
    }
  } else if (anyActive) {
    // Current event has no sim, but others are running — show global status
    bar.style.display = "block";
    const finishedCount = sims.filter(s => s.status === "finished").length;
    const totalCount = sims.filter(s => s.status !== "reset").length;
    text.textContent = `当前事件未参与仿真 · ${runningCount} 运行中 · ${finishedCount} 已完成 · 共 ${totalCount} 活跃`;
    document.getElementById("simControlArea").style.display = "none";
  } else {
    bar.style.display = "none";
  }
}

/* ==================================================================
   Tab 6: Report
   ================================================================== */
async function renderReportArea() {
  const sel = document.getElementById("reportEventSelect");
  const events = (state && state.events) || [];
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- 选择事件 --</option><option value="__overview__">📊 总览</option>' + events.map(e =>
    `<option value="${e.id}">${e.id}: ${e.type} → ${e.roadId} [${e.status}]</option>`
  ).join("");
  if (currentVal && [...sel.options].some(o => o.value === currentVal)) sel.value = currentVal;
}

document.getElementById("viewReportBtn").addEventListener("click", async () => {
  const eventId = document.getElementById("reportEventSelect").value;
  if (!eventId) { toast("请选择事件"); return; }
  if (eventId === "__overview__") {
    renderReportOverview();
    return;
  }
  showLoading();
  const result = await apiGet(`/api/report/${eventId}`);
  hideLoading();
  if (!checkResult(result)) return;
  renderReport(result.data);
});

document.getElementById("exportReportBtn").addEventListener("click", async () => {
  const eventId = document.getElementById("reportEventSelect").value;
  if (!eventId) { toast("请选择事件"); return; }
  showLoading();
  const result = await apiGet(`/api/report/${eventId}/export`);
  hideLoading();
  if (!checkResult(result)) return;
  downloadJson(`report-${eventId}.json`, result.data);
});

document.getElementById("reportResetAllBtn").addEventListener("click", resetAllSims);

function renderReportOverview() {
  const events = (state?.events) || [];
  const sims = (state?.simulations) || [];
  const plans = (state?.plans) || [];
  const selPlans = eventPlanSelections || {};

  const finishedEvents = events.filter(e => e.status === "finished");
  const runningEvents = events.filter(e => e.status === "running");
  const plannedEvents = events.filter(e => e.status === "planned");

  let html = `<div class="report-section">
    <h3>📊 仿真总览</h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 0">
      <span style="font-size:13px;color:var(--ink-secondary)">总事件：<strong style="color:var(--ink)">${events.length}</strong></span>
      <span style="font-size:13px;color:var(--ink-secondary)">已完成：<strong style="color:#4caf50">${finishedEvents.length}</strong></span>
      <span style="font-size:13px;color:var(--ink-secondary)">运行中：<strong style="color:#1e88e5">${runningEvents.length}</strong></span>
      <span style="font-size:13px;color:var(--ink-secondary)">待处理：<strong style="color:var(--ink)">${plannedEvents.length}</strong></span>
    </div>
  </div>`;

  if (events.length === 0) {
    html += '<div class="report-placeholder">暂无事件数据。</div>';
    document.getElementById("reportContent").innerHTML = html;
    return;
  }

  html += `<div class="report-section"><h3>事件列表</h3><div class="table-wrap"><table>
    <thead><tr>
      <th>事件</th><th>类型</th><th>路段</th><th>严重程度</th><th>状态</th>
      <th>选中方案</th><th>仿真状态</th><th>进度</th><th>恢复时间</th><th>成本</th><th>影响车辆</th>
    </tr></thead><tbody>`;

  events.forEach(ev => {
    const sim = sims.filter(s => s.eventId === ev.id && s.status !== "reset").pop();
    // Find plan: try simulation planId, then backend selectedPlanId, then in-memory selection
    let selPlan = null;
    if (sim) selPlan = plans.find(p => p.id === sim.planId);
    if (!selPlan && ev.selectedPlanId) selPlan = plans.find(p => p.id === ev.selectedPlanId);
    if (!selPlan && selPlans[ev.id]) selPlan = plans.find(p => p.id === selPlans[ev.id]);

    let recoveryTime = "--", cost = "--", affected = "--";

    if (sim && sim.status === "finished") {
      recoveryTime = (sim.currentTime || 0) + " min";
      affected = sim.currentAffectedVehicles || 0;
      if (sim.consumedMaterials) {
        cost = sim.consumedMaterials.reduce((s, m) => s + (+m.quantity || 0), 0).toFixed(1) + " units";
      }
    } else if (selPlan) {
      recoveryTime = (selPlan.totalTime || 0) + " min";
      cost = selPlan.cost || "--";
      affected = selPlan.affectedVehicles || 0;
    } else if (sim) {
      recoveryTime = (sim.currentTime || 0) + " min";
      affected = sim.currentAffectedVehicles || 0;
    }

    const simStatus = sim
      ? (sim.status === "running" ? `<span style="color:#1e88e5">● 运行中</span>`
        : sim.status === "paused" ? `<span style="color:#ff8f00">⏸ 暂停</span>`
        : sim.status === "finished" ? `<span style="color:#4caf50">✓ 已完成</span>`
        : sim.status)
      : (selPlan ? `<span style="color:var(--ink-secondary)">未开始</span>` : `<span style="color:var(--ink-secondary)">--</span>`);

    const progress = sim ? ((sim.progress || 0).toFixed(1) + "%") : "--";

    html += `<tr>
      <td><strong>${ev.id}</strong></td>
      <td>${ev.type}</td>
      <td>${ev.roadId}</td>
      <td>${ev.severity}</td>
      <td><span class="status-pill ${ev.status}">${ev.status}</span></td>
      <td>${selPlan ? selPlan.strategyName : '<span style="color:var(--ink-secondary)">--</span>'}</td>
      <td>${simStatus}</td>
      <td>${progress}</td>
      <td>${recoveryTime}</td>
      <td>${cost}</td>
      <td>${affected}</td>
    </tr>`;
  });

  html += `</tbody></table></div></div>`;

  // Summary section
  const finishedSims = sims.filter(s => s.status === "finished");
  if (finishedSims.length > 0) {
    const totalTime = finishedSims.reduce((s, sim) => s + (sim.currentTime || 0), 0);
    const totalAffected = finishedSims.reduce((s, sim) => s + (sim.currentAffectedVehicles || 0), 0);
    const allConsumed = {};
    finishedSims.forEach(s => (s.consumedMaterials || []).forEach(m => {
      allConsumed[m.materialType] = (allConsumed[m.materialType] || 0) + (+m.quantity || 0);
    }));
    html += `<div class="report-section">
      <h3>汇总统计</h3>
      <dl class="report-dl">
        <dt>已完成仿真</dt><dd>${finishedSims.length} 个</dd>
        <dt>累计恢复时间</dt><dd>${totalTime} min</dd>
        <dt>累计影响车辆</dt><dd>${totalAffected} 辆</dd>
        ${Object.keys(allConsumed).length ? `<dt>累计消耗材料</dt><dd>${Object.entries(allConsumed).map(([t, q]) => `${t}×${q}`).join("，")}</dd>` : ""}
      </dl>
    </div>`;
  }

  // Logs section — show logs for all non-reset simulations
  const simsWithLogs = sims.filter(s => s.status !== "reset" && s.logs && s.logs.length > 0);
  if (simsWithLogs.length > 0) {
    html += `<div class="report-section"><h3>仿真日志</h3>`;
    simsWithLogs.forEach(s => {
      const ev = events.find(e => e.id === s.eventId);
      html += `<div style="margin-bottom:12px">
        <h4 style="font-size:13px;margin:0 0 6px">${ev ? ev.id : s.eventId} — ${s.status} (${(s.progress || 0).toFixed(1)}%)</h4>
        <div class="report-log-box">${s.logs.map(l => `<div>${l}</div>`).join("")}</div>
      </div>`;
    });
    html += `</div>`;
  }

  document.getElementById("reportContent").innerHTML = html;
}

function renderReport(data) {
  if (!data) {
    document.getElementById("reportContent").innerHTML = '<div class="report-placeholder">暂无报告数据。</div>';
    return;
  }
  const ev = data.event || {};
  const rp = data.recommendedPlan || {};
  const plans = data.plans || [];
  const sim = data.simulation || {};
  const summary = data.summary || {};
  const logs = data.logs || (sim.logs || []);

  let html = '';

  // Event summary
  html += `<div class="report-section">
    <h3>事件摘要</h3>
    <dl class="report-dl">
      <dt>ID</dt><dd>${ev.id || "--"}</dd>
      <dt>类型</dt><dd>${ev.type || "--"}</dd>
      <dt>关联路段</dt><dd>${ev.roadId || "--"}</dd>
      <dt>严重程度</dt><dd>${ev.severity || "--"}</dd>
      <dt>当前状态</dt><dd><span class="status-pill ${ev.status}">${ev.status || "--"}</span></dd>
      <dt>封路</dt><dd>${ev.blocked ? "是" : "否"}</dd>
      <dt>创建时间</dt><dd>${ev.createdAt || "--"}</dd>
    </dl>
  </div>`;

  // Recommended plan
  if (rp.id) {
    html += `<div class="report-section">
      <h3>推荐方案</h3>
      <dl class="report-dl">
        <dt>方案名称</dt><dd>${rp.strategyName || "--"}</dd>
        <dt>策略</dt><dd>${rp.strategy || "--"}</dd>
        <dt>参与队伍</dt><dd>${(rp.teams || []).join(", ") || "--"}</dd>
        <dt>总恢复时间</dt><dd>${rp.totalTime} min</dd>
        <dt>成本</dt><dd>${rp.cost}</dd>
        <dt>影响车辆</dt><dd>${rp.affectedVehicles}</dd>
        <dt>风险惩罚</dt><dd>${(rp.riskPenalty || 0).toFixed(2)}</dd>
        <dt>综合评分</dt><dd>${(rp.score || 0).toFixed(4)} <small>(越低越优)</small></dd>
        ${(rp.requiredMaterials || []).length ? `<dt>所需物资</dt><dd>${rp.requiredMaterials.map(m => `${m.materialType}×${m.quantity}`).join(", ")}</dd>` : ""}
        ${rp.materialFeasible === false ? `<dt style="color:#e53935">库存状态</dt><dd style="color:#e53935">库存不足：${(rp.materialShortage || []).map(s => `${s.materialType}缺${s.missing}`).join("；")}</dd>` : ""}
        <dt>说明</dt><dd>${rp.reason || "--"}</dd>
      </dl>
    </div>`;
  }

  // Plans comparison table
  if (plans.length > 0) {
    html += `<div class="report-section">
      <h3>方案对比</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>方案</th><th>策略</th><th>队伍</th><th>总计</th><th>成本</th><th>影响</th><th>风险</th><th>物资</th><th>评分</th><th>推荐</th></tr></thead>
        <tbody>${plans.map(p => `<tr${p.isRecommended ? ' style="background:rgba(192,57,43,0.04)"' : ''}>
          <td><strong>${p.strategyName}</strong></td><td>${p.strategy}</td>
          <td>${(p.teams || []).join(",")}</td>
          <td>${p.totalTime}</td>
          <td>${p.cost}</td>
          <td>${p.affectedVehicles}</td>
          <td>${(p.riskPenalty || 0).toFixed(2)}</td>
          <td>${(p.requiredMaterials || []).map(m => `${m.materialType}×${m.quantity}`).join("<br>") || "--"}</td>
          <td>${(p.score || 0).toFixed(4)}</td>
          <td>${p.isRecommended ? "✓" : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <p style="font-size:12px;color:var(--ink-secondary);margin-top:4px">* 评分越低越优</p>
    </div>`;

    // Bar chart of raw scores (lower is better)
    const scores = plans.map(p => p.score || 0);
    const maxScore = Math.max(...scores, 0.001);
    html += `<div class="report-section">
      <h3>综合评分对比（越低越优）</h3>
      <div class="report-bar-chart">`;
    plans.forEach((p, i) => {
      const pct = (1 - scores[i] / maxScore) * 100;
      html += `<div class="bar-item">
        <span class="bar-label">${p.strategyName}</span>
        <div class="bar-track"><div class="bar-fill bar-fill-invert" style="width:${pct}%"></div></div>
        <span class="bar-value">${scores[i].toFixed(4)}</span>
      </div>`;
    });
    html += `</div></div>`;
  }

  // Simulation
  if (sim.id) {
    html += `<div class="report-section">
      <h3>仿真摘要</h3>
      <dl class="report-dl">
        <dt>仿真 ID</dt><dd>${sim.id}</dd>
        <dt>状态</dt><dd><span class="status-pill ${sim.status}">${sim.status}</span></dd>
        <dt>进度</dt><dd>${(sim.progress || 0).toFixed(1)}%</dd>
        <dt>当前时间</dt><dd>${sim.currentTime || 0} min</dd>
        <dt>当前影响车辆</dt><dd>${sim.currentAffectedVehicles || 0}</dd>
        <dt>道路状态</dt><dd>${sim.roadStatus || "--"}</dd>
        ${(sim.consumedMaterials || []).length ? `<dt>已消耗材料</dt><dd>${sim.consumedMaterials.map(m => `${m.materialType}×${m.quantity} (${m.depotId})`).join(", ")}</dd>` : ""}
      </dl>
    </div>`;
  }

  // Summary
  if (summary.eventStatus) {
    html += `<div class="report-section">
      <h3>汇总</h3>
      <dl class="report-dl">
        <dt>事件状态</dt><dd>${summary.eventStatus}</dd>
        <dt>方案数量</dt><dd>${summary.planCount || 0}</dd>
        <dt>推荐策略</dt><dd>${summary.recommendedStrategy || "--"}</dd>
        <dt>仿真状态</dt><dd>${summary.simulationStatus || "--"}</dd>
        <dt>当前影响车辆</dt><dd>${summary.currentAffectedVehicles || 0}</dd>
        <dt>日志条数</dt><dd>${summary.logCount || 0}</dd>
        ${(summary.consumedMaterials || []).length ? `<dt>已消耗材料</dt><dd>${summary.consumedMaterials.map(m => `${m.materialType}×${m.quantity} (${m.depotId})`).join(", ")}</dd>` : ""}
      </dl>
    </div>`;
  }

  // Logs
  if (logs.length > 0) {
    html += `<div class="report-section">
      <h3>仿真日志</h3>
      <div class="report-log-box">${logs.map(l => `<div>${l}</div>`).join("")}</div>
    </div>`;
  }

  document.getElementById("reportContent").innerHTML = html;
}

/* ===== Download Helper ===== */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast("文件已下载: " + filename);
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", async () => {
  await loadState();
});
