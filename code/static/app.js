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
let isSubmitting = false;

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
}

let currentFilter = "all";

const STATUS_COLORS = {
  normal: "#4caf50", congested: "#ff9800", damaged: "#e53935",
  closed: "#78909c", repairing: "#1e88e5", recovered: "#66bb6a"
};
const STATUS_DASH = { closed: "8,5" };

function renderSvgMap() {
  const svg = document.getElementById("roadMap");
  const nodes = state.nodes || [];
  const edges = state.edges || [];
  const events = state.events || [];
  const teams = state.teams || [];

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  let html = "";

  // Subtle background grid
  html += `<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(26,26,46,0.04)" stroke-width="1"/>
  </pattern></defs>`;
  html += `<rect width="700" height="420" fill="url(#grid)"/>`;

  // Edges
  edges.forEach(e => {
    const from = nodeMap[e.fromNode], to = nodeMap[e.toNode];
    if (!from || !to) return;
    if (currentFilter !== "all" && e.status !== currentFilter) return;
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

  // Team markers
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

  svg.innerHTML = html;

  // Render legend
  renderLegend();
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
        ${ev.status !== "running" ? `<button class="btn btn-sm" onclick="deleteEvent('${ev.id}')">删除</button>` : ""}
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
    dbody.innerHTML = depots.map(d => `<tr>
      <td><strong>${d.id}</strong></td><td>${d.nodeId}</td><td>${d.materialType}</td><td>${d.stock}</td>
      <td><button class="btn btn-sm" onclick="editDepot('${d.id}')">编辑</button> <button class="btn btn-sm" onclick="deleteDepot('${d.id}')">删除</button></td>
    </tr>`).join("");
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
  const sel = document.getElementById("simEventSelect");
  const events = (state && state.events) || [];
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- 选择事件 --</option>' + events.map(e =>
    `<option value="${e.id}">${e.id}: ${e.type} → ${e.roadId} [${e.status}]</option>`
  ).join("");
  if (currentVal && [...sel.options].some(o => o.value === currentVal)) sel.value = currentVal;
  if (events.length > 0 && !sel.value) {
    sel.value = events[0].id;
    currentEventId = events[0].id;
  }
  updateSimStatus();
}

document.getElementById("simEventSelect").addEventListener("change", () => {
  currentEventId = document.getElementById("simEventSelect").value;
  clearSimUI();
});

function clearSimUI() {
  document.getElementById("planCards").innerHTML = "";
  selectedPlanId = null;
  currentPlanId = null;
  document.getElementById("simControlArea").style.display = "none";
}

document.getElementById("generatePlanBtn").addEventListener("click", async () => {
  if (!currentEventId) { toast("请先选择事件"); return; }
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/plans/generate", { eventId: currentEventId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  const plans = result.data || [];
  renderPlanCards(plans);
  await loadState();
  const rec = plans.find(p => p.isRecommended);
  selectedPlanId = rec ? rec.id : (plans[0] ? plans[0].id : null);
  currentPlanId = selectedPlanId;
  highlightPlanCard();
  toast("方案已生成");
});

function renderPlanCards(plans) {
  const container = document.getElementById("planCards");
  if (!plans || plans.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><p>暂无可用方案。请确保有 idle 状态的队伍。</p></div>';
    return;
  }
  const maxScore = Math.max(...plans.map(p => p.score || 0), 0.001);
  container.innerHTML = plans.map(p => {
    const isRec = p.isRecommended;
    const scorePct = ((p.score || 0) / maxScore) * 100;
    return `<div class="plan-card ${isRec ? 'recommended' : ''}" data-plan-id="${p.id}" onclick="selectPlan('${p.id}')">
      ${isRec ? '<span class="plan-badge">★ 推荐</span>' : ''}
      <h4>${p.strategyName}</h4>
      <div class="plan-stat">策略 <strong>${p.strategy}</strong></div>
      <div class="plan-stat">参与队伍 <strong>${(p.teams || []).join(", ")}</strong></div>
      <div class="plan-stat">路径 <strong>${(p.route || []).join(" → ") || "直达"}</strong></div>
      <div class="plan-stat">🕐 到达 <strong>${p.arrivalTime} min</strong></div>
      <div class="plan-stat">🔧 修复 <strong>${p.repairTime} min</strong></div>
      <div class="plan-stat">⏱ 总计 <strong>${p.totalTime} min</strong></div>
      <div class="plan-stat">💰 成本 <strong>${p.cost}</strong></div>
      <div class="plan-stat">🚗 影响车辆 <strong>${p.affectedVehicles}</strong></div>
      <div class="score-bar-wrap">
        <div class="score-bar-label"><span>综合评分</span><span>${(p.score || 0).toFixed(4)}</span></div>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${scorePct}%"></div></div>
      </div>
      <div class="plan-stat" style="margin-top:8px; font-style:italic; color:var(--ink); border-top:1px solid var(--line); padding-top:6px">${p.reason}</div>
    </div>`;
  }).join("");
}

let selectedPlanId = null;
function selectPlan(id) {
  selectedPlanId = id;
  currentPlanId = id;
  highlightPlanCard();
}
function highlightPlanCard() {
  document.querySelectorAll(".plan-card").forEach(c => {
    c.classList.toggle("selected", c.dataset.planId === selectedPlanId);
  });
}

// Simulation controls
document.getElementById("startSimBtn").addEventListener("click", async () => {
  if (!currentEventId || !currentPlanId) { toast("请先生成方案并点击选择一个方案"); return; }
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/simulation/start", { eventId: currentEventId, planId: currentPlanId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  currentSimulationId = result.data?.id || null;
  toast("仿真已启动");
  await loadState();
  renderSimulation(result.data);
});

document.getElementById("stepSimBtn").addEventListener("click", async () => {
  if (!currentSimulationId) { toast("请先开始仿真"); return; }
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/simulation/step", { simulationId: currentSimulationId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  renderSimulation(result.data);
  await loadState();
});

document.getElementById("pauseSimBtn").addEventListener("click", async () => {
  if (!currentSimulationId) return;
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/simulation/pause", { simulationId: currentSimulationId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  renderSimulation(result.data);
  await loadState();
});

document.getElementById("resumeSimBtn").addEventListener("click", async () => {
  if (!currentSimulationId) return;
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/simulation/resume", { simulationId: currentSimulationId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  renderSimulation(result.data);
  await loadState();
});

document.getElementById("resetSimBtn").addEventListener("click", async () => {
  if (!currentSimulationId) return;
  if (!confirm("确定重置仿真？将恢复到仿真开始前的状态。")) return;
  if (isSubmitting) return;
  isSubmitting = true;
  showLoading();
  const result = await apiPost("/api/simulation/reset", { simulationId: currentSimulationId });
  hideLoading();
  isSubmitting = false;
  if (!checkResult(result)) return;
  renderSimulation(result.data);
  await loadState();
});

// Speed buttons (visual only — backend handles speed internally)
document.querySelectorAll(".speed-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".speed-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

function renderSimulation(sim) {
  if (!sim) return;
  const area = document.getElementById("simControlArea");
  area.style.display = "block";
  currentSimulationId = sim.id;
  document.getElementById("progressFill").style.width = Math.min(sim.progress || 0, 100) + "%";
  document.getElementById("progressText").textContent = (sim.progress || 0).toFixed(1) + "%";

  const logs = sim.logs || [];
  const logBox = document.getElementById("simLogs");
  if (logs.length === 0) {
    logBox.innerHTML = '<div class="sim-log-placeholder">仿真日志将在此显示。</div>';
  } else {
    logBox.innerHTML = logs.map(l => `<div>${l}</div>`).join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  const st = sim.status || "unknown";
  document.getElementById("startSimBtn").style.display = (st === "ready" || st === "reset") ? "" : "none";
  document.getElementById("stepSimBtn").style.display = (st === "running") ? "" : "none";
  document.getElementById("pauseSimBtn").style.display = (st === "running") ? "" : "none";
  document.getElementById("resumeSimBtn").style.display = (st === "paused") ? "" : "none";
  document.getElementById("resetSimBtn").style.display = (st === "running" || st === "paused" || st === "finished") ? "" : "none";

  updateSimStatus();
}

function updateSimStatus() {
  const bar = document.getElementById("simStatusBar");
  const text = document.getElementById("simStatusText");
  if (!state) return;
  const sims = state.simulations || [];
  if (sims.length > 0) {
    const sim = sims[0];
    bar.style.display = "block";
    text.textContent = `仿真 ${sim.id}: ${sim.status} — 进度 ${(sim.progress || 0).toFixed(1)}%`;
    if (sim.id && !currentSimulationId) {
      currentSimulationId = sim.id;
      renderSimulation(sim);
    }
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
  sel.innerHTML = '<option value="">-- 选择事件 --</option>' + events.map(e =>
    `<option value="${e.id}">${e.id}: ${e.type} → ${e.roadId} [${e.status}]</option>`
  ).join("");
  if (currentVal) sel.value = currentVal;
}

document.getElementById("viewReportBtn").addEventListener("click", async () => {
  const eventId = document.getElementById("reportEventSelect").value;
  if (!eventId) { toast("请选择事件"); return; }
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
        <dt>综合评分</dt><dd>${(rp.score || 0).toFixed(4)}</dd>
        <dt>说明</dt><dd>${rp.reason || "--"}</dd>
      </dl>
    </div>`;
  }

  // Plans comparison table
  if (plans.length > 0) {
    html += `<div class="report-section">
      <h3>方案对比</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>方案</th><th>策略</th><th>队伍</th><th>到达</th><th>修复</th><th>总时间</th><th>成本</th><th>影响车辆</th><th>评分</th><th>推荐</th></tr></thead>
        <tbody>${plans.map(p => `<tr${p.isRecommended ? ' style="background:rgba(192,57,43,0.04)"' : ''}>
          <td><strong>${p.strategyName}</strong></td><td>${p.strategy}</td>
          <td>${(p.teams || []).join(",")}</td>
          <td>${p.arrivalTime}</td><td>${p.repairTime}</td><td>${p.totalTime}</td>
          <td>${p.cost}</td><td>${p.affectedVehicles}</td>
          <td>${(p.score || 0).toFixed(4)}</td>
          <td>${p.isRecommended ? "✓" : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`;

    // Bar chart
    const maxScore = Math.max(...plans.map(p => p.score || 0), 0.001);
    html += `<div class="report-section">
      <h3>评分对比</h3>
      <div class="report-bar-chart">`;
    plans.forEach(p => {
      const pct = ((p.score || 0) / maxScore) * 100;
      html += `<div class="bar-item">
        <span class="bar-label">${p.strategyName}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-value">${(p.score || 0).toFixed(4)}</span>
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
      </dl>
    </div>`;
  }

  // Summary
  if (summary.totalTime || summary.totalCost) {
    html += `<div class="report-section">
      <h3>汇总</h3>
      <dl class="report-dl">
        <dt>总恢复时间</dt><dd>${summary.totalTime || "--"} min</dd>
        <dt>总成本</dt><dd>${summary.totalCost || "--"}</dd>
        <dt>影响车辆总计</dt><dd>${summary.totalAffectedVehicles || "--"}</dd>
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
