const API_BASE = "http://localhost:8000/api";

// In-memory lead cache for client-side filtering & CSV export
let _allLeads = [];

// Init 
document.addEventListener("DOMContentLoaded", () => {
    fetchStats();
    fetchAccounts();
    fetchLeads();
    fetchSettings();
    initializeLogStream();
    buildActivityTimeline();
});

// Sidebar Page Navigation
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    const targetPage = document.getElementById('page-' + name);
    if (targetPage) targetPage.classList.add('active');

    // Highlight navigation item
    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('onclick') === `showPage('${name}')`) n.classList.add('active');
    });

    const pageMeta = {
        dashboard:  { title: 'Dashboard',   subtitle: 'Outreach performance overview' },
        leads:      { title: 'Leads CRM',   subtitle: 'Manage and track your outreach targets' },
        analytics:  { title: 'Analytics',   subtitle: 'Charts and performance insights' },
        campaigns:  { title: 'Campaigns',   subtitle: 'Configure and control outreach campaigns' },
        settings:   { title: 'Settings',    subtitle: 'Global platform configuration' },
    };

    if (pageMeta[name]) {
        document.getElementById('pageTitle').textContent = pageMeta[name].title;
        document.getElementById('pageSubtitle').textContent = pageMeta[name].subtitle;
    }

    if (name === 'analytics') updateAnalytics();
    if (name === 'campaigns') renderCampaignAccounts();
}

// Modal Helpers
function openModal(id)  { 
    const m = document.getElementById(id);
    if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
}
function closeModal(id) { 
    const m = document.getElementById(id);
    if (m) { m.classList.remove('flex'); m.classList.add('hidden'); }
}

// Toast Notifications
function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    if (!t) return;
    document.getElementById('toastMsg').textContent = msg;
    const icon = document.getElementById('toastIcon');
    icon.className = type === 'error'
        ? 'fa-solid fa-circle-exclamation text-rose-400'
        : 'fa-solid fa-check-circle text-emerald-400';
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
}

// 1. Fetch Aggregated Metrics
async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/dashboard/stats`);
        const stats = await res.json();

        document.getElementById("statTotalLeads").innerText     = stats.total_leads;
        document.getElementById("statActiveAccounts").innerText = stats.active_accounts;
        document.getElementById("statDmedLeads").innerText      = stats.dmed_leads;
        document.getElementById("statRepliedLeads").innerText   = stats.replied_leads;

        // Sync Campaign toggle button state
        const btn  = document.getElementById("toggleCampaignBtn");
        const icon = document.getElementById("toggleIcon");
        const txt  = document.getElementById("toggleText");
        
        if (btn && icon && txt) {
            if (stats.campaign_running) {
                btn.style.background = 'linear-gradient(135deg,#dc2626,#b91c1c)';
                icon.className = 'fa-solid fa-pause';
                txt.textContent = 'Pause Campaign';
            } else {
                btn.style.background = '';
                icon.className = 'fa-solid fa-play';
                txt.textContent = 'Launch Automation';
            }
        }
        updateAnalytics(stats);
    } catch (e) {
        console.error("Error fetching metrics:", e);
    }
}

// 2. Fetch Profiles & Render
async function fetchAccounts() {
    try {
        const res      = await fetch(`${API_BASE}/accounts`);
        const accounts = await res.json();
        renderAccounts(accounts, 'accountsContainer');
    } catch(e) { console.error(e); }
}

function renderAccounts(accounts, containerId) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    accounts.forEach(acc => {
        const badgeClass = acc.status === 'Active'
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-amber-500/15 text-amber-400';
        const div = document.createElement('div');
        div.className = 'glass-card rounded-xl p-3 flex justify-between items-center text-xs';
        div.innerHTML = `
            <div class="space-y-0.5">
                <p class="font-medium text-white flex items-center gap-1.5">
                    <i class="fa-brands fa-instagram text-blue-400 text-xs"></i> @${acc.username}
                </p>
                <p class="text-[10px] text-slate-500">Proxy: ${acc.proxy ? acc.proxy.split('@')[1] || acc.proxy : 'Direct'}</p>
            </div>
            <div class="text-right space-y-1">
                <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase ${badgeClass}">${acc.status}</span>
                <p class="text-[9px] text-slate-500">DM:${acc.daily_actions?.dm || 0} Lk:${acc.daily_actions?.like || 0}</p>
            </div>`;
        c.appendChild(div);
    });
}

function renderCampaignAccounts() {
    fetch(`${API_BASE}/accounts`)
        .then(r => r.json())
        .then(accounts => renderAccounts(accounts, 'accountsContainerCampaigns'))
        .catch(e => console.error(e));
}

// 3. Fetch CRM Leads Database
async function fetchLeads() {
    try {
        const res   = await fetch(`${API_BASE}/leads`);
        const leads = await res.json();
        _allLeads   = leads;
        renderLeads(leads);
    } catch(e) { console.error(e); }
}

function renderLeads(leads) {
    const body = document.getElementById('leadsTableBody');
    if (!body) return;
    body.innerHTML = '';
    
    leads.forEach(lead => {
        const cleanUser = lead.username.replace(/^@+/, '');
        const statusMap = {
            Pending: '<span class="badge-pending px-2 py-0.5 rounded text-[10px] font-mono uppercase">Pending</span>',
            DMed:    '<span class="badge-dmed px-2 py-0.5 rounded text-[10px] font-mono uppercase">Sent</span>',
            Replied: '<span class="badge-replied px-2 py-0.5 rounded text-[10px] font-mono uppercase">Replied</span>',
            Failed:  '<span class="badge-failed px-2 py-0.5 rounded text-[10px] font-mono uppercase">Failed</span>',
        };
        const badge = statusMap[lead.status] || `<span class="px-2 py-0.5 rounded text-[10px] font-mono">${lead.status}</span>`;
        const tr = document.createElement('tr');
        tr.className = 'leads-row transition';
        tr.innerHTML = `
            <td class="p-3.5 text-white font-medium text-xs">
                <div class="flex items-center gap-2">
                    <div class="w-7 h-7 rounded-full bg-blue-500/15 flex items-center justify-center flex-shrink-0">
                        <i class="fa-brands fa-instagram text-blue-400 text-[11px]"></i>
                    </div>
                    <div>
                        <p class="font-semibold">@${cleanUser}</p>
                        <p class="text-[10px] text-slate-500">${lead.niche}</p>
                    </div>
                    <a href="https://www.instagram.com/${cleanUser}/" target="_blank" class="text-slate-600 hover:text-blue-400 transition ml-1">
                        <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                    </a>
                </div>
            </td>
            <td class="p-3.5 text-slate-400 text-xs">${lead.niche}</td>
            <td class="p-3.5">
                <select onchange="updateLeadStatus('${lead._id}', this.value)"
                    class="bg-transparent border border-white/10 text-xs rounded-lg px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500 cursor-pointer">
                    <option value="Pending"  ${lead.status === 'Pending'  ? 'selected' : ''}>Pending</option>
                    <option value="DMed"     ${lead.status === 'DMed'     ? 'selected' : ''}>Sent</option>
                    <option value="Replied"  ${lead.status === 'Replied'  ? 'selected' : ''}>Replied</option>
                    <option value="Failed"   ${lead.status === 'Failed'   ? 'selected' : ''}>Failed</option>
                </select>
            </td>
            <td class="p-3 flex gap-2">
                <button onclick="copyPitchToClipboard('${cleanUser}', '${lead.niche}', event)"
                    class="glass-card border border-blue-500/15 text-blue-400 hover:text-blue-300 px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1.5 transition">
                    <i class="fa-regular fa-copy"></i> Copy
                </button>
                <button onclick="autoSendPitch('${lead._id}', '${cleanUser}', '${lead.niche}', event)"
                    class="btn-primary text-white px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1.5 transition">
                    <i class="fa-solid fa-paper-plane text-[9px]"></i> Auto Send
                </button>
            </td>`;
        body.appendChild(tr);
    });
}

// Client-Side Filtering
function filterLeads() {
    const search = document.getElementById('searchLeads').value.toLowerCase();
    const status = document.getElementById('filterStatus').value;
    const niche  = document.getElementById('filterNiche').value;
    const filtered = _allLeads.filter(l => {
        const user = l.username.toLowerCase();
        return (!search || user.includes(search))
            && (!status || l.status === status)
            && (!niche  || l.niche  === niche);
    });
    renderLeads(filtered);
}

// Export CSV
function exportCSV() {
    const header = 'username,niche,status';
    const rows   = _allLeads.map(l => `${l.username},${l.niche},${l.status}`);
    const csv    = [header, ...rows].join('\n');
    const blob   = new Blob([csv], { type: 'text/csv' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = 'apex-connect-leads.csv'; a.click();
    showToast('Leads exported as CSV');
}

// Update Lead Status manually
async function updateLeadStatus(id, newStatus) {
    try {
        await fetch(`${API_BASE}/leads/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_id: id, status: newStatus })
        });
        fetchStats();
    } catch(e) { console.error(e); }
}

// Copy Pitch to Clipboard
async function copyPitchToClipboard(username, niche, event) {
    const btn = event ? event.currentTarget : null;
    const originalText = btn ? btn.innerHTML : "Copy Pitch";
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i> Writing...`;
    }

    try {
        const res = await fetch(`${API_BASE}/ai/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: username, niche: niche })
        });
        
        if (!res.ok) throw new Error("API responded with an error");
        
        const data = await res.json();
        const pitchText = data.dm;

        if (!navigator.clipboard) {
            const textArea = document.createElement("textarea");
            textArea.value = pitchText;
            textArea.style.position = "fixed";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                showToast(`Pitch for @${username} copied — opening DM thread...`);
            } catch (err) {
                console.error('Fallback copy failed', err);
                alert("Failed to copy text automatically. Here is the pitch:\n\n" + pitchText);
            }
            document.body.removeChild(textArea);
        } else {
            await navigator.clipboard.writeText(pitchText);
            showToast(`Pitch for @${username} copied — opening DM thread...`);
        }

        // Open the lead's Instagram DM thread in a new tab so the pitch
        // just needs to be pasted and sent — no manual searching required.
        openInstagramDM(username);
    } catch (e) {
        console.error("AI copy failed:", e);
        showToast("Copy failed - is Groq API Key missing or invalid?", "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// Opens the Instagram DM thread for a given username in a new tab.
// ig.me/m/<username> resolves to the direct-message compose view when
// you're logged into instagram.com in that browser/session already.
function openInstagramDM(username) {
    const clean = username.replace(/^@+/, '');
    window.open(`https://ig.me/m/${clean}`, '_blank', 'noopener');
}

// Trigger Secure Auto Send (Playwright Flow)
async function autoSendPitch(leadId, username, niche, event) {
    const btn = event ? event.currentTarget : null;
    const originalText = btn ? btn.innerHTML : "Auto Send";
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i> Sending...`;
    }

    try {
        const res = await fetch(`${API_BASE}/leads/send-auto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lead_id: leadId, status: "DMed" })
        });
        
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Failed to execute safely.");

        showToast(`Auto-sent DM to @${username}!`);
        fetchLeads();
        fetchStats();
    } catch (e) {
        console.error("Auto send failed:", e);
        showToast(e.message || "Auto-send failed.", "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// Fetch Settings
async function fetchSettings() {
    try {
        const res    = await fetch(`${API_BASE}/settings`);
        const config = await res.json();
        const cn = config.campaign_name    || '';
        const ml = config.max_leads_per_day || 30;
        const wm = config.safety_warmup_mode || false;
        ['campaignName','settingsCampaignName'].forEach(id => { const el = document.getElementById(id); if(el) el.value = cn; });
        ['maxLeads','settingsMaxLeads'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ml; });
        ['warmupMode','settingsWarmup'].forEach(id => { const el = document.getElementById(id); if(el) el.checked = wm; });
    } catch(e) { console.error(e); }
}

// Save Settings
async function saveSettings(e) {
    e.preventDefault();
    const campaign_name      = document.getElementById('campaignName').value;
    const max_leads_per_day  = parseInt(document.getElementById('maxLeads').value);
    const safety_warmup_mode = document.getElementById('warmupMode').checked;
    try {
        await fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaign_name, max_leads_per_day, safety_warmup_mode, dm_template:'', comment_template:'' })
        });
        showToast('Campaign settings saved');
        fetchStats();
    } catch(e) { console.error(e); }
}

async function saveSettingsFromPage() {
    const campaign_name      = document.getElementById('settingsCampaignName').value;
    const max_leads_per_day  = parseInt(document.getElementById('settingsMaxLeads').value);
    const safety_warmup_mode = document.getElementById('settingsWarmup').checked;
    try {
        await fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaign_name, max_leads_per_day, safety_warmup_mode, dm_template:'', comment_template:'' })
        });
        showToast('Settings saved');
        fetchStats();
    } catch(e) { console.error(e); }
}

// Submit IG Account
async function submitAccountBtn() {
    const username = document.getElementById('accUser').value;
    const password = document.getElementById('accPass').value;
    const proxy    = document.getElementById('accProxy').value;
    try {
        const res = await fetch(`${API_BASE}/accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, proxy })
        });
        if (res.ok) {
            closeModal('accountModal');
            ['accUser','accPass','accProxy'].forEach(id => document.getElementById(id).value = '');
            fetchAccounts(); fetchStats();
            showToast('Account linked successfully');
        } else {
            showToast('Error linking account', 'error');
        }
    } catch(e) { console.error(e); }
}

// Submit CRM Lead
async function submitLeadBtn() {
    const username = document.getElementById('leadUser').value;
    const niche    = document.getElementById('leadNiche').value;
    try {
        const res = await fetch(`${API_BASE}/leads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, niche })
        });
        if (res.ok) {
            closeModal('leadModal');
            document.getElementById('leadUser').value = '';
            fetchLeads(); fetchStats();
            showToast('Lead added to CRM');
        } else {
            showToast('Lead already exists in CRM', 'error');
        }
    } catch(e) { console.error(e); }
}

// AI Copy Preview Generation
async function previewAICopy() {
    const username = document.getElementById('previewUsername').value;
    const niche    = document.getElementById('previewNiche').value;
    const spinner  = document.getElementById('previewSpinner');
    if (!username) { showToast('Enter a target account name', 'error'); return; }
    spinner.classList.remove('hidden');
    try {
        const res  = await fetch(`${API_BASE}/ai/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, niche })
        });
        const data = await res.json();
        document.getElementById('previewDmResult').innerText      = data.dm;
        document.getElementById('previewCommentResult').innerText  = data.comment;
    } catch(e) { console.error(e); } finally { spinner.classList.add('hidden'); }
}

// Toggle Campaign loop state
async function toggleCampaign() {
    try {
        await fetch(`${API_BASE}/campaign/toggle`, { method: 'POST' });
        fetchStats();
    } catch(e) { console.error(e); }
}

// Real-Time SSE Log pipe
function initializeLogStream() {
    const terminal = document.getElementById('terminalStream');
    if (!terminal) return;
    const source   = new EventSource(`${API_BASE}/logs/stream`);
    source.onmessage = (event) => {
        const log = JSON.parse(event.data);
        const div = document.createElement('div');
        let cc = 'text-slate-300';
        if (log.level === 'SUCCESS') cc = 'text-emerald-400';
        else if (log.level === 'WARNING') cc = 'text-amber-400';
        else if (log.level === 'ERROR')   cc = 'text-rose-400';
        div.className = cc;
        div.innerHTML = `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.level}] ${log.message}`;
        terminal.appendChild(div);
        terminal.scrollTop = terminal.scrollHeight;
    };
    source.onerror = () => console.warn('SSE disconnected. Retrying...');
}

// Analytics Visualizer
function updateAnalytics(stats) {
    const total   = parseInt(document.getElementById('statTotalLeads').innerText)  || 0;
    const dmed    = parseInt(document.getElementById('statDmedLeads').innerText)   || 0;
    const replied = parseInt(document.getElementById('statRepliedLeads').innerText)|| 0;

    // Funnel
    const funnelEl = document.getElementById('funnelChart');
    if (funnelEl) {
        funnelEl.innerHTML = '';
        const funnelData = [
            { label: 'Total Leads', value: total, color: 'bg-blue-500' },
            { label: 'DMs Sent',    value: dmed,  color: 'bg-sky-400' },
            { label: 'Replies',     value: replied,color: 'bg-violet-400' },
        ];
        funnelData.forEach(f => {
            const pct = total > 0 ? Math.round((f.value / total) * 100) : 0;
            funnelEl.innerHTML += `
                <div class="ana-row">
                    <span class="text-[11px] text-slate-400 w-24 flex-shrink-0">${f.label}</span>
                    <div class="ana-bar-wrap"><div class="ana-bar ${f.color}" style="width:${pct}%"></div></div>
                    <span class="text-[11px] text-white font-semibold w-8 text-right">${f.value}</span>
                    <span class="text-[10px] text-slate-500 w-8">${pct}%</span>
                </div>`;
        });
    }

    // Bar chart mock (simulated daily data)
    const days   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const values = [8, 12, 7, 15, 10, 6, dmed || 4];
    const maxV   = Math.max(...values, 1);
    const barEl  = document.getElementById('barChart');
    const labEl  = document.getElementById('barLabels');
    if (barEl && labEl) {
        barEl.innerHTML = ''; labEl.innerHTML = '';
        values.forEach((v, i) => {
            const h = Math.round((v / maxV) * 100);
            barEl.innerHTML  += `<div class="flex-1 flex flex-col items-center justify-end">
                <span class="text-[10px] text-slate-500 mb-1">${v}</span>
                <div class="chart-bar w-full" style="height:${h}%"></div>
            </div>`;
            labEl.innerHTML  += `<span class="flex-1 text-center text-[10px] text-slate-500">${days[i]}</span>`;
        });
    }

    // Niche breakdown
    const nicheEl = document.getElementById('nicheBreakdown');
    if (nicheEl) {
        const niches  = {};
        _allLeads.forEach(l => { niches[l.niche] = (niches[l.niche] || 0) + 1; });
        nicheEl.innerHTML = '';
        Object.entries(niches).forEach(([n, c]) => {
            const pct = total > 0 ? Math.round((c / total) * 100) : 0;
            nicheEl.innerHTML += `
                <div class="ana-row">
                    <span class="text-[11px] text-slate-400 w-32 flex-shrink-0">${n}</span>
                    <div class="ana-bar-wrap"><div class="ana-bar" style="width:${pct}%"></div></div>
                    <span class="text-[11px] text-white font-semibold w-6 text-right">${c}</span>
                </div>`;
        });
        if (!Object.keys(niches).length) nicheEl.innerHTML = '<p class="text-xs text-slate-500 italic">No leads yet</p>';
    }

    // Status breakdown
    const statEl   = document.getElementById('statusBreakdown');
    if (statEl) {
        const statuses = {};
        _allLeads.forEach(l => { statuses[l.status] = (statuses[l.status] || 0) + 1; });
        const sColors  = { Pending: '#3b82f6', DMed: '#34d399', Replied: '#a78bfa', Failed: '#f87171' };
        statEl.innerHTML = '';
        Object.entries(statuses).forEach(([s, c]) => {
            const pct = total > 0 ? Math.round((c / total) * 100) : 0;
            const col = sColors[s] || '#64748b';
            statEl.innerHTML += `
                <div class="ana-row">
                    <span class="text-[11px] text-slate-400 w-24 flex-shrink-0">${s}</span>
                    <div class="ana-bar-wrap"><div class="ana-bar" style="width:${pct}%;background:${col}"></div></div>
                    <span class="text-[11px] text-white font-semibold w-6 text-right">${c}</span>
                </div>`;
        });
        if (!Object.keys(statuses).length) statEl.innerHTML = '<p class="text-xs text-slate-500 italic">No leads yet</p>';
    }
}

// Activity Timeline (decorative bars)
function buildActivityTimeline() {
    const container = document.getElementById("activityTimeline");
    if (!container) return;
    const days = 30;
    container.innerHTML = '';
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