const API_BASE = "http://localhost:8000/api";

// ─── In-memory lead cache for client-side filtering & CSV export ───
let _allLeads = [];

// ─── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    fetchStats();
    fetchAccounts();
    fetchLeads();
    fetchSettings();
    initializeLogStream();
    buildActivityTimeline();
});

// ─── Sidebar Page Navigation ────────────────────────────────────────
function showPage(name) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    // Remove active from all nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    // Show target page
    document.getElementById('page-' + name).classList.add('active');
    document.getElementById('nav-' + name).classList.add('active');

    // Refresh analytics when switching to that page
    if (name === 'analytics') updateAnalytics();
}

// ─── Modal Helpers ───────────────────────────────────────────────────
function openModal(id) {
    document.getElementById(id).classList.add('open');
}
function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}

// ─── 1. Fetch Aggregated Metrics ─────────────────────────────────────
async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/dashboard/stats`);
        const stats = await res.json();

        document.getElementById("statTotalLeads").innerText    = stats.total_leads;
        document.getElementById("statActiveAccounts").innerText = stats.active_accounts;
        document.getElementById("statDmedLeads").innerText     = stats.dmed_leads;
        document.getElementById("statRepliedLeads").innerText  = stats.replied_leads;

        // Campaign toggle button — sidebar
        const toggleBtn  = document.getElementById("toggleCampaignBtn");
        const toggleLarge = document.getElementById("campaignToggleLarge");
        const statusText = document.getElementById("campaignStatusText");
        const statusDot  = document.getElementById("campaignStatusDot");

        if (stats.campaign_running) {
            // Sidebar button
            toggleBtn.className = "btn-pause w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-[13px]";
            toggleBtn.innerHTML = '<i class="fa-solid fa-pause text-[11px]"></i><span>Pause Campaign</span>';
            // Campaign page button
            if (toggleLarge) {
                toggleLarge.className = "btn-pause w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-[13px]";
                toggleLarge.innerHTML = '<i class="fa-solid fa-pause text-[11px]"></i><span>Pause Campaign</span>';
            }
            if (statusText) statusText.innerText = "Running";
            if (statusDot)  { statusDot.className = "h-3 w-3 rounded-full bg-emerald-500 block"; }
        } else {
            toggleBtn.className = "btn-launch w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white font-semibold text-[13px]";
            toggleBtn.innerHTML = '<i class="fa-solid fa-play text-[11px]"></i><span>Launch Automation</span>';
            if (toggleLarge) {
                toggleLarge.className = "btn-launch w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-[13px]";
                toggleLarge.innerHTML = '<i class="fa-solid fa-play text-[11px]"></i><span>Launch Automation</span>';
            }
            if (statusText) statusText.innerText = "Idle";
            if (statusDot)  { statusDot.className = "h-3 w-3 rounded-full bg-slate-600 block"; }
        }

        updateAnalytics(stats);
    } catch (e) {
        console.error("Error fetching metrics:", e);
    }
}

// ─── 2. Fetch Profiles & Render ──────────────────────────────────────
async function fetchAccounts() {
    try {
        const res = await fetch(`${API_BASE}/accounts`);
        const accounts = await res.json();

        const renderAccounts = (containerId) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = "";

            if (!accounts.length) {
                container.innerHTML = '<p class="text-[12px] text-slate-500 text-center py-4">No accounts connected</p>';
                return;
            }

            accounts.forEach(acc => {
                const div = document.createElement("div");
                div.className = "bg-blue-900/10 border border-blue-500/10 rounded-xl p-3 flex justify-between items-center text-[11px]";

                const badgeClass = acc.status === "Active"
                    ? "bg-emerald-500/18 text-emerald-400"
                    : "bg-amber-500/18 text-amber-400";

                div.innerHTML = `
                    <div class="space-y-1">
                        <p class="font-medium text-white flex items-center gap-1.5">
                            <i class="fa-brands fa-instagram text-pink-400 text-xs"></i> @${acc.username}
                        </p>
                        <p class="text-[10px] text-slate-500">
                            Proxy: ${acc.proxy ? acc.proxy.split('@')[1] || acc.proxy : 'Direct'}
                        </p>
                    </div>
                    <div class="text-right space-y-1">
                        <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wider ${badgeClass}">${acc.status}</span>
                        <p class="text-[10px] text-slate-500">DMs: ${acc.daily_actions?.dm || 0}</p>
                    </div>`;
                container.appendChild(div);
            });
        };

        renderAccounts("accountsContainer");
        renderAccounts("accountsContainerCampaign");
    } catch (e) {
        console.error("Error fetching accounts:", e);
    }
}

// ─── 3. Fetch CRM Leads Database ─────────────────────────────────────
async function fetchLeads() {
    try {
        const res = await fetch(`${API_BASE}/leads`);
        _allLeads = await res.json();
        renderLeads(_allLeads);
    } catch (e) {
        console.error("Error fetching leads:", e);
    }
}

function renderLeads(leads) {
    const body = document.getElementById("leadsTableBody");
    body.innerHTML = "";

    if (!leads.length) {
        body.innerHTML = '<tr><td colspan="4" class="text-center text-slate-500 py-10 text-[13px]">No leads match your filters</td></tr>';
        return;
    }

    leads.forEach(lead => {
        const tr = document.createElement("tr");
        tr.className = "border-b border-blue-900/10 hover:bg-blue-900/5 transition duration-150";

        const cleanUser = lead.username.replace(/^@+/, "");

        let badgeHtml = "";
        if (lead.status === "Pending")
            badgeHtml = '<span class="bg-slate-500/18 text-slate-400 px-2 py-0.5 rounded text-[10px] font-mono uppercase">Pending</span>';
        else if (lead.status === "DMed")
            badgeHtml = '<span class="bg-emerald-500/18 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-mono uppercase">Outreach Sent</span>';
        else if (lead.status === "Replied")
            badgeHtml = '<span class="bg-violet-500/18 text-violet-400 px-2 py-0.5 rounded text-[10px] font-mono uppercase">Replied</span>';
        else if (lead.status === "Failed")
            badgeHtml = '<span class="bg-rose-500/18 text-rose-400 px-2 py-0.5 rounded text-[10px] font-mono uppercase">Failed</span>';
        else
            badgeHtml = `<span class="bg-blue-500/18 text-blue-300 px-2 py-0.5 rounded text-[10px] font-mono uppercase">${lead.status}</span>`;

        tr.innerHTML = `
            <td class="p-3 text-white font-medium">
                <div class="flex items-center gap-2">
                    <span class="text-[13px]">@${cleanUser}</span>
                    <a href="https://www.instagram.com/${cleanUser}/" target="_blank" class="text-slate-500 hover:text-blue-400 transition" title="Open Instagram">
                        <i class="fa-solid fa-external-link text-[10px]"></i>
                    </a>
                </div>
            </td>
            <td class="p-3 text-slate-400 text-[12px]">${lead.niche}</td>
            <td class="p-3">
                <select onchange="updateLeadStatus('${lead._id}', this.value)"
                    class="bg-slate-900/80 border border-blue-900/25 text-[11px] rounded-lg px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500/50 cursor-pointer">
                    <option value="Pending"  ${lead.status === 'Pending'  ? 'selected' : ''}>Pending</option>
                    <option value="DMed"     ${lead.status === 'DMed'     ? 'selected' : ''}>Outreach Sent</option>
                    <option value="Replied"  ${lead.status === 'Replied'  ? 'selected' : ''}>Replied</option>
                    <option value="Failed"   ${lead.status === 'Failed'   ? 'selected' : ''}>Failed</option>
                </select>
            </td>
            <td class="p-3">
                <button onclick="copyPitchToClipboard('${cleanUser}', '${lead.niche}')"
                    class="bg-blue-600/22 text-blue-300 border border-blue-500/18 px-3 py-1.5 rounded-lg text-[11px] hover:bg-blue-600/38 transition flex items-center gap-1.5">
                    <i class="fa-regular fa-copy text-[10px]"></i><span>Copy Pitch</span>
                </button>
            </td>`;
        body.appendChild(tr);
    });
}

// ─── Client-side filtering ────────────────────────────────────────────
function filterLeads() {
    const search  = (document.getElementById("searchLeads")?.value || "").toLowerCase();
    const status  = document.getElementById("filterStatus")?.value || "";
    const niche   = document.getElementById("filterNiche")?.value || "";

    const filtered = _allLeads.filter(lead => {
        const matchUser   = lead.username.toLowerCase().includes(search);
        const matchStatus = !status || lead.status === status;
        const matchNiche  = !niche  || lead.niche  === niche;
        return matchUser && matchStatus && matchNiche;
    });

    renderLeads(filtered);
}

// ─── CSV Export ───────────────────────────────────────────────────────
function exportLeadsCSV() {
    if (!_allLeads.length) { alert("No leads to export."); return; }

    const header = ["Username", "Niche", "Status"];
    const rows = _allLeads.map(l => [
        l.username.replace(/^@+/, ""),
        l.niche,
        l.status
    ]);

    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "apex_connect_leads.csv";
    a.click();
    URL.revokeObjectURL(url);
}

// ─── 3.5 Update Lead Status ───────────────────────────────────────────
async function updateLeadStatus(id, newStatus) {
    try {
        await fetch(`${API_BASE}/leads/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lead_id: id, status: newStatus })
        });
        fetchStats();
        // Update local cache too
        const lead = _allLeads.find(l => l._id === id);
        if (lead) lead.status = newStatus;
    } catch (e) {
        console.error("Error updating status:", e);
    }
}

// ─── Copy Pitch to Clipboard ──────────────────────────────────────────
async function copyPitchToClipboard(username, niche) {
    try {
        const res = await fetch(`${API_BASE}/ai/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, niche })
        });
        const data = await res.json();
        await navigator.clipboard.writeText(data.dm);
        alert(`Pitch for @${username} copied! Paste it on Instagram.`);
    } catch (e) {
        console.error("Failed to copy pitch:", e);
        alert("Make sure your Groq API key is valid to auto-generate the pitch!");
    }
}

// ─── 4. Fetch Campaign Settings ───────────────────────────────────────
async function fetchSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        const config = await res.json();
        document.getElementById("campaignName").value = config.campaign_name || "";
        document.getElementById("maxLeads").value     = config.max_leads_per_day || 30;
        document.getElementById("warmupMode").checked = config.safety_warmup_mode || false;
    } catch (e) {
        console.error("Error loading config:", e);
    }
}

// ─── 5. Submit Account ────────────────────────────────────────────────
async function submitAccount(e) {
    e.preventDefault();
    const username = document.getElementById("accUser").value;
    const password = document.getElementById("accPass").value;
    const proxy    = document.getElementById("accProxy").value;
    try {
        const res = await fetch(`${API_BASE}/accounts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password, proxy })
        });
        if (res.ok) {
            closeModal("accountModal");
            document.getElementById("accUser").value  = "";
            document.getElementById("accPass").value  = "";
            document.getElementById("accProxy").value = "";
            fetchAccounts();
            fetchStats();
        } else {
            alert("Error validating or uploading Instagram account settings.");
        }
    } catch (err) {
        console.error(err);
    }
}

// ─── 6. Submit Lead ───────────────────────────────────────────────────
async function submitLead(e) {
    e.preventDefault();
    const username = document.getElementById("leadUser").value;
    const niche    = document.getElementById("leadNiche").value;
    try {
        const res = await fetch(`${API_BASE}/leads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, niche })
        });
        if (res.ok) {
            closeModal("leadModal");
            document.getElementById("leadUser").value = "";
            fetchLeads();
            fetchStats();
        } else {
            alert("Lead username is already stored in CRM.");
        }
    } catch (err) {
        console.error(err);
    }
}

// ─── 7. Save Settings ─────────────────────────────────────────────────
async function saveSettings(e) {
    e.preventDefault();
    const campaign_name      = document.getElementById("campaignName").value;
    const max_leads_per_day  = parseInt(document.getElementById("maxLeads").value);
    const safety_warmup_mode = document.getElementById("warmupMode").checked;
    try {
        await fetch(`${API_BASE}/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                campaign_name, max_leads_per_day, safety_warmup_mode,
                dm_template: "", comment_template: ""
            })
        });
        alert("Campaign configuration saved.");
        fetchStats();
    } catch (e) {
        console.error(e);
    }
}

// ─── 8. AI Copy Preview ───────────────────────────────────────────────
async function previewAICopy() {
    const username = document.getElementById("previewUsername").value;
    const niche    = document.getElementById("previewNiche").value;
    const spinner  = document.getElementById("previewSpinner");

    if (!username) { alert("Please enter a target account name first."); return; }

    spinner.classList.remove("hidden");
    try {
        const res = await fetch(`${API_BASE}/ai/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, niche })
        });
        const data = await res.json();
        document.getElementById("previewDmResult").innerText      = data.dm;
        document.getElementById("previewCommentResult").innerText = data.comment;
    } catch (e) {
        console.error("AI preview error:", e);
    } finally {
        spinner.classList.add("hidden");
    }
}

// ─── 9. Toggle Campaign ───────────────────────────────────────────────
async function toggleCampaign() {
    try {
        await fetch(`${API_BASE}/campaign/toggle`, { method: "POST" });
        fetchStats();
    } catch (e) {
        console.error(e);
    }
}

// ─── 10. SSE Log Stream ───────────────────────────────────────────────
function initializeLogStream() {
    const terminals = [
        document.getElementById("terminalStream"),
        document.getElementById("terminalStream2")
    ].filter(Boolean);

    const source = new EventSource(`${API_BASE}/logs/stream`);

    source.onmessage = (event) => {
        const log = JSON.parse(event.data);

        let colorClass = "text-slate-300";
        if (log.level === "SUCCESS") colorClass = "text-emerald-400";
        else if (log.level === "WARNING") colorClass = "text-amber-400";
        else if (log.level === "ERROR")   colorClass = "text-rose-400";

        const timestamp = new Date(log.timestamp).toLocaleTimeString();

        terminals.forEach(terminal => {
            const div = document.createElement("div");
            div.className = colorClass;
            div.textContent = `[${timestamp}] [${log.level}] ${log.message}`;
            terminal.appendChild(div);
            terminal.scrollTop = terminal.scrollHeight;
        });
    };

    source.onerror = () => {
        console.warn("Log SSE stream disconnected. Retrying...");
    };
}

// ─── Analytics Update ─────────────────────────────────────────────────
function updateAnalytics(stats) {
    // Use passed stats or read from DOM
    const total   = parseInt(document.getElementById("statTotalLeads")?.innerText || "0");
    const dmed    = parseInt(document.getElementById("statDmedLeads")?.innerText  || "0");
    const replied = parseInt(document.getElementById("statRepliedLeads")?.innerText || "0");

    // Funnel bars
    const setBar = (id, pct) => {
        const el = document.getElementById(id);
        if (el) el.style.width = pct + "%";
    };

    const dmedPct    = total ? Math.round((dmed    / total) * 100) : 0;
    const repliedPct = total ? Math.round((replied / total) * 100) : 0;

    setBar("bar-total",   100);
    setBar("bar-dmed",    dmedPct);
    setBar("bar-replied", repliedPct);

    const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    safeSet("bar-total-label",   total);
    safeSet("bar-dmed-label",    dmed);
    safeSet("bar-replied-label", replied);
    safeSet("replyRateStat",     (total ? Math.round((replied / total) * 100) : 0) + "%");
    safeSet("dmRateStat",        (total ? Math.round((dmed    / total) * 100) : 0) + "%");

    // Status breakdown
    const breakdown = document.getElementById("statusBreakdown");
    if (breakdown && _allLeads.length) {
        const counts = { Pending: 0, DMed: 0, Replied: 0, Failed: 0 };
        _allLeads.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
        const colors = { Pending: "bg-slate-500", DMed: "bg-emerald-500", Replied: "bg-violet-500", Failed: "bg-rose-500" };
        breakdown.innerHTML = "";
        Object.entries(counts).forEach(([status, count]) => {
            const pct = _allLeads.length ? Math.round((count / _allLeads.length) * 100) : 0;
            const div = document.createElement("div");
            div.innerHTML = `
                <div class="flex justify-between text-[11px] mb-1.5">
                    <span class="text-slate-400">${status}</span>
                    <span class="text-slate-300 font-semibold">${count} <span class="text-slate-600">(${pct}%)</span></span>
                </div>
                <div class="bg-white/5 rounded-full h-2">
                    <div class="${colors[status]} h-2 rounded-full transition-all duration-700" style="width:${pct}%"></div>
                </div>`;
            breakdown.appendChild(div);
        });
    }
}

// ─── Activity Timeline (decorative bars) ─────────────────────────────
function buildActivityTimeline() {
    const container = document.getElementById("activityTimeline");
    if (!container) return;
    const days = 30;
    for (let i = 0; i < days; i++) {
        const h = Math.floor(Math.random() * 85) + 8;
        const bar = document.createElement("div");
        bar.className = "flex-1 rounded-t-sm transition-all duration-500 cursor-pointer hover:opacity-90";
        bar.style.height = h + "%";
        const alpha = 0.25 + (h / 100) * 0.65;
        bar.style.background = `rgba(59,130,246,${alpha.toFixed(2)})`;
        bar.title = `Day ${i + 1}: ${h} actions`;
        container.appendChild(bar);
    }
}
