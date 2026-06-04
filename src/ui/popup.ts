type SiteSettings = {
  enabled: boolean;
  thresholdMinutes: number;
};

type UsageSummary = {
  totalMinutes: number;
  totalSites: number;
  totalTabsOpened: number;
  totalTabSwitches: number;
  top5: Array<{ host: string; seconds: number; displayName: string; faviconUrl: string }>;
};

// ── Element refs ──────────────────────────────────────────────────────────────
const statusEl           = document.getElementById('status')          as HTMLDivElement   | null;
const siteEnabledEl      = document.getElementById('siteEnabled')     as HTMLInputElement | null;
const siteThresholdEl    = document.getElementById('siteThreshold')   as HTMLInputElement | null;
const saveSiteEl         = document.getElementById('saveSite')        as HTMLButtonElement| null;
const refreshEl          = document.getElementById('refresh')         as HTMLButtonElement| null;
const allowBtn           = document.getElementById('allowBtn')        as HTMLButtonElement| null;
const patreonBtn         = document.getElementById('patreonBtn')      as HTMLButtonElement| null;
const top5El             = document.getElementById('top5')            as HTMLUListElement | null;
const usageStatusEl      = document.getElementById('usageStatus')     as HTMLDivElement   | null;
const controlsHostEl     = document.getElementById('controlsHost')    as HTMLDivElement   | null;

// Stats cards
const statTotalTimeEl    = document.getElementById('statTotalTime')   as HTMLDivElement   | null;
const statSitesEl        = document.getElementById('statSites')       as HTMLDivElement   | null;
const statTabsEl         = document.getElementById('statTabs')        as HTMLDivElement   | null;
const statSwitchesEl     = document.getElementById('statSwitches')    as HTMLDivElement   | null;

// Focus score
const focusScoreEl       = document.getElementById('focusScore')      as HTMLDivElement   | null;
const focusArcEl         = document.getElementById('focusArc')        as SVGCircleElement | null;
const focusTitleEl       = document.getElementById('focusTitle')      as HTMLDivElement   | null;
const focusDescEl        = document.getElementById('focusDesc')       as HTMLDivElement   | null;
const focusBarFillEl     = document.getElementById('focusBarFill')    as HTMLDivElement   | null;
const headerDateEl       = document.getElementById('headerDate')      as HTMLSpanElement  | null;

// ── State ─────────────────────────────────────────────────────────────────────
let activeHost: string | null         = null;
let pendingPermissionHost: string | null = null;
let refreshingUsage                   = false;

// Bar color classes cycling for top-5 rows
const BAR_COLORS = ['bar-purple', 'bar-red', 'bar-indigo', 'bar-sky', 'bar-teal', 'bar-amber'];

// Patreon URL - update this with your Patreon link
const PATREON_URL = 'https://patreon.com'; // Replace with your Patreon URL

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTrackableHost(url?: string): string | null {
  try {
    if (!url) return null;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host || null;
  } catch (_e) {
    return null;
  }
}

function sendPopupMessage<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout' } as T);
    }, 4000);

    chrome.runtime.sendMessage(msg, (resp) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(resp as T);
    });
  });
}

function popupSecondsToMinutes(seconds: number): number {
  if (seconds <= 0) return 0;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return Math.max(0.1, minutes);
}

function setControlsEnabled(enabled: boolean): void {
  if (siteEnabledEl)   siteEnabledEl.disabled   = !enabled;
  if (siteThresholdEl) siteThresholdEl.disabled  = !enabled;
  if (saveSiteEl)      saveSiteEl.disabled       = !enabled;
}

// ── Focus score rendering ─────────────────────────────────────────────────────
function renderFocusScore(totalMinutes: number): void {
  // Score: 100 at 0 min, 0 at 240+ min
  const score  = Math.max(0, Math.min(100, Math.round(100 - (totalMinutes / 240) * 100)));
  const circumference = 2 * Math.PI * 19; // r=19
  const filled = (score / 100) * circumference;

  if (focusScoreEl)  focusScoreEl.textContent = String(score);
  if (focusArcEl)    focusArcEl.style.strokeDasharray = `${filled} ${circumference}`;
  if (focusBarFillEl) focusBarFillEl.style.width = `${score}%`;

  if (focusTitleEl && focusDescEl) {
    if (score >= 80) {
      focusTitleEl.textContent = 'Great focus today';
      focusDescEl.textContent  = 'You\'re spending time well. Keep it up.';
    } else if (score >= 55) {
      focusTitleEl.textContent = 'Decent focus';
      focusDescEl.textContent  = `${totalMinutes} min online — room to tighten up.`;
    } else if (score >= 30) {
      focusTitleEl.textContent = 'High distraction';
      focusDescEl.textContent  = `${totalMinutes} min online — consider a break.`;
    } else {
      focusTitleEl.textContent = 'Focus at risk';
      focusDescEl.textContent  = `${totalMinutes} min online today. Time to step away.`;
    }
  }
}

// ── Summary rendering ─────────────────────────────────────────────────────────
function renderSummary(summary: UsageSummary | null): void {
  if (!summary) {
    if (statTotalTimeEl)  statTotalTimeEl.textContent  = '0';
    if (statSitesEl)      statSitesEl.textContent      = '0';
    if (statTabsEl)       statTabsEl.textContent       = '0';
    if (statSwitchesEl)   statSwitchesEl.textContent   = '0';
    if (top5El)           top5El.innerHTML             = '<div style="color:rgba(255,255,255,0.3);font-size:12px;padding:8px 0">No tracked sites yet</div>';
    renderFocusScore(0);
    return;
  }

  if (statTotalTimeEl)  statTotalTimeEl.textContent  = String(summary.totalMinutes);
  if (statSitesEl)      statSitesEl.textContent      = String(summary.totalSites);
  if (statTabsEl)       statTabsEl.textContent       = String(summary.totalTabsOpened);
  if (statSwitchesEl)   statSwitchesEl.textContent   = String(summary.totalTabSwitches);

  renderFocusScore(summary.totalMinutes);

  if (top5El) {
    top5El.innerHTML = '';
    if (!summary.top5.length) {
      top5El.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:12px;padding:8px 0">No tracked sites yet</div>';
    } else {
      const maxSecs = summary.top5[0]?.seconds || 1;
      summary.top5.forEach((item, i) => {
        const pct   = Math.round((item.seconds / maxSecs) * 100);
        const mins  = popupSecondsToMinutes(item.seconds);
        const color = BAR_COLORS[i % BAR_COLORS.length];

        const row = document.createElement('div');
        row.className = 'site-row';

        const faviconWrap = document.createElement('div');
        faviconWrap.className = 'site-favicon';
        const fallbackLetter = (item.displayName || item.host).charAt(0).toUpperCase();

        if (item.faviconUrl) {
          const img = document.createElement('img');
          img.src = item.faviconUrl;
          img.alt = '';
          img.addEventListener('error', () => {
            faviconWrap.textContent = fallbackLetter;
          });
          faviconWrap.appendChild(img);
        } else {
          faviconWrap.textContent = fallbackLetter;
        }

        const siteName = document.createElement('span');
        siteName.className = 'site-name';
        siteName.textContent = item.displayName || item.host;

        const barWrap = document.createElement('div');
        barWrap.className = 'site-bar-wrap';
        const barBg = document.createElement('div');
        barBg.className = 'site-bar-bg';
        const barFill = document.createElement('div');
        barFill.className = `site-bar-fill ${color}`;
        barFill.style.width = `${pct}%`;
        barBg.appendChild(barFill);
        barWrap.appendChild(barBg);

        const siteTime = document.createElement('span');
        siteTime.className = 'site-time';
        siteTime.textContent = `${mins}m`;

        row.appendChild(faviconWrap);
        row.appendChild(siteName);
        row.appendChild(barWrap);
        row.appendChild(siteTime);
        top5El.appendChild(row);
      });
    }
  }
}

// ── Usage loading ─────────────────────────────────────────────────────────────
async function loadUsageSummary(): Promise<void> {
  if (refreshingUsage) return;
  refreshingUsage = true;

  if (refreshEl) {
    refreshEl.disabled = true;
    refreshEl.classList.add('spinning');
  }

  const resp = await sendPopupMessage<{ ok: boolean; summary: UsageSummary }>({
    type: 'usage:getTodaySummary'
  });

  if (resp?.ok) {
    renderSummary(resp.summary);
    if (usageStatusEl) usageStatusEl.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
  } else {
    if (usageStatusEl) usageStatusEl.textContent = 'Refresh failed — try again.';
  }

  refreshingUsage = false;
  if (refreshEl) {
    refreshEl.disabled = false;
    refreshEl.classList.remove('spinning');
  }
}

// ── Site settings ─────────────────────────────────────────────────────────────
async function loadSiteSettings(host: string): Promise<void> {
  const resp = await sendPopupMessage<{ ok: boolean; settings: SiteSettings }>({
    type: 'settings:getSite',
    host
  });
  if (!resp?.ok) {
    // Default behavior: sites are enabled unless the user explicitly disables.
    if (siteEnabledEl) siteEnabledEl.checked = true;
    if (siteThresholdEl) siteThresholdEl.value = '1';
    return;
  }
  if (siteEnabledEl)   siteEnabledEl.checked       = resp.settings.enabled;
  if (siteThresholdEl) siteThresholdEl.value        = String(resp.settings.thresholdMinutes);
}

// ── Permission button ─────────────────────────────────────────────────────────
function showPermissionButton(host: string | null): void {
  pendingPermissionHost = host;
  if (!host) {
    if (allowBtn) allowBtn.style.display = 'none';
    return;
  }
  if (allowBtn) {
    allowBtn.textContent = `Allow ${host}`;
    allowBtn.style.display = 'inline-flex';
  }
}

// ── Active host management ────────────────────────────────────────────────────
async function refreshForActiveHost(): Promise<void> {
  if (!activeHost) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeHost = getTrackableHost(tabs[0]?.url || (tabs[0] as chrome.tabs.Tab & { pendingUrl?: string })?.pendingUrl || undefined);
  }

  if (controlsHostEl) {
    controlsHostEl.textContent = activeHost ?? 'Unsupported page';
  }

  if (!activeHost) {
    if (statusEl) statusEl.textContent = 'Active site: unsupported page';
    setControlsEnabled(false);
    showPermissionButton(null);
    return;
  }

  setControlsEnabled(true);
  await loadSiteSettings(activeHost);
}

async function initActiveHost(): Promise<void> {
  const resp = await sendPopupMessage<{ host: string | null }>({ type: 'session:getActive' });
  activeHost = resp?.host || null;

  if (!activeHost) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeHost = getTrackableHost(
      tabs[0]?.url || (tabs[0] as chrome.tabs.Tab & { pendingUrl?: string })?.pendingUrl || undefined
    );
  }

  await refreshForActiveHost();
}

// ── Event listeners ───────────────────────────────────────────────────────────
if (saveSiteEl) {
  saveSiteEl.addEventListener('click', async () => {
    if (!activeHost) return;
    const threshold = Math.min(30, Math.max(1, Number(siteThresholdEl?.value) || 1));
    if (siteThresholdEl) siteThresholdEl.value = String(threshold);

    const resp = await sendPopupMessage<{ ok: boolean }>({
      type: 'settings:setSite',
      host: activeHost,
      settings: {
        enabled: Boolean(siteEnabledEl?.checked),
        thresholdMinutes: threshold
      }
    });

    if (resp?.ok && statusEl) {
      statusEl.textContent = `Saved for ${activeHost}`;
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }
  });
}

if (refreshEl) {
  refreshEl.addEventListener('click', () => { void loadUsageSummary(); });
}

if (allowBtn) {
  allowBtn.addEventListener('click', () => {
    if (!pendingPermissionHost) return;
    const httpsOrigin = `https://${pendingPermissionHost}/*`;
    const httpOrigin  = `http://${pendingPermissionHost}/*`;
    chrome.permissions.request({ origins: [httpsOrigin, httpOrigin] }, (granted) => {
      if (!granted) return;
      chrome.runtime.sendMessage({ type: 'permission:granted', host: pendingPermissionHost }, () => {
        showPermissionButton(null);
      });
    });
  });
}

if (patreonBtn) {
  patreonBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: PATREON_URL });
  });
}

// ── Port listener ─────────────────────────────────────────────────────────────
const port = chrome.runtime.connect();
port.onMessage.addListener((msg) => {
  if (msg?.type === 'activeChanged') {
    activeHost = msg.host || null;
    void refreshForActiveHost();
    return;
  }
  if (msg?.type === 'permissionDenied') {
    const host = msg.host as string;
    showPermissionButton(host || null);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (headerDateEl) {
    const now = new Date();
    headerDateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  }
  await initActiveHost();
  await loadUsageSummary();
});
