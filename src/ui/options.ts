type DashboardPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

type GlobalSettings = {
  defaultThresholdMinutes: number;
};

type SummaryItem = {
  host: string;
  seconds: number;
  displayName: string;
  faviconUrl: string;
};

type DashboardSummary = {
  totalMinutes: number;
  totalSites: number;
  totalTabsOpened: number;
  totalTabSwitches: number;
  top10: SummaryItem[];
};

function sendOptionsMessage<T = any>(msg: Record<string, any>): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp as T));
  });
}

function optionsSecondsToMinutes(seconds: number) {
  if (seconds <= 0) return 0;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return Math.max(0.1, minutes);
}

document.addEventListener('DOMContentLoaded', async () => {
  const maxMinutesEl = document.getElementById('maxMinutes') as HTMLInputElement | null;
  const saveGlobalEl = document.getElementById('saveGlobal') as HTMLButtonElement | null;
  const settingsStatusEl = document.getElementById('settingsStatus') as HTMLDivElement | null;

  const totalTimeEl = document.getElementById('totalTime') as HTMLDivElement | null;
  const totalSitesEl = document.getElementById('totalSites') as HTMLDivElement | null;
  const tabsOpenedEl = document.getElementById('tabsOpened') as HTMLDivElement | null;
  const tabSwitchesEl = document.getElementById('tabSwitches') as HTMLDivElement | null;
  const top10BodyEl = document.getElementById('top10Body') as HTMLTableSectionElement | null;

  const exportBackupEl = document.getElementById('exportBackup') as HTMLButtonElement | null;
  const importBackupBtnEl = document.getElementById('importBackupBtn') as HTMLButtonElement | null;
  const importBackupEl = document.getElementById('importBackup') as HTMLInputElement | null;

  let currentPeriod: DashboardPeriod = 'daily';

  if (
    !maxMinutesEl ||
    !saveGlobalEl ||
    !settingsStatusEl ||
    !totalTimeEl ||
    !totalSitesEl ||
    !tabsOpenedEl ||
    !tabSwitchesEl ||
    !top10BodyEl ||
    !exportBackupEl ||
    !importBackupBtnEl ||
    !importBackupEl
  ) {
    console.error('[doomscroll:options] Missing required DOM nodes');
    return;
  }

  const setStatus = (message: string, isError = false) => {
    settingsStatusEl.textContent = message;
    settingsStatusEl.classList.toggle('error', isError);
  };

  const loadGlobalSettings = async () => {
    const resp = await sendOptionsMessage<{ ok: boolean; settings: GlobalSettings }>({ type: 'settings:getGlobal' });
    if (!resp?.ok) {
      setStatus('Failed to load settings.', true);
      return;
    }
    maxMinutesEl.value = String(resp.settings.defaultThresholdMinutes);
  };

  const saveGlobalSettings = async () => {
    const threshold = Math.min(30, Math.max(1, Number(maxMinutesEl.value) || 1));
    maxMinutesEl.value = String(threshold);

    const resp = await sendOptionsMessage<{ ok: boolean }>({
      type: 'settings:setGlobal',
      settings: { defaultThresholdMinutes: threshold }
    });

    if (!resp?.ok) {
      setStatus('Could not save settings.', true);
      return;
    }

    setStatus('Settings saved.');
  };

  const renderTop10 = (items: SummaryItem[]) => {
    top10BodyEl.innerHTML = '';
    if (!items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="3">No usage data yet.</td>';
      top10BodyEl.appendChild(tr);
      return;
    }

    items.slice(0, 10).forEach((item, idx) => {
      const tr = document.createElement('tr');
      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);

      const tdSite = document.createElement('td');
      const siteCell = document.createElement('div');
      siteCell.className = 'site-cell';

      const icon = document.createElement('img');
      icon.className = 'site-icon';
      icon.alt = '';
      if (item.faviconUrl) {
        icon.src = item.faviconUrl;
      } else {
        icon.style.visibility = 'hidden';
      }
      icon.addEventListener('error', () => {
        icon.style.visibility = 'hidden';
      });

      const textWrap = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'site-name';
      nameEl.textContent = item.displayName || item.host;
      const hostEl = document.createElement('div');
      hostEl.className = 'site-host';
      hostEl.textContent = item.host;
      textWrap.appendChild(nameEl);
      textWrap.appendChild(hostEl);

      siteCell.appendChild(icon);
      siteCell.appendChild(textWrap);
      tdSite.appendChild(siteCell);

      const tdMinutes = document.createElement('td');
      tdMinutes.textContent = String(optionsSecondsToMinutes(item.seconds));

      tr.appendChild(tdIdx);
      tr.appendChild(tdSite);
      tr.appendChild(tdMinutes);
      top10BodyEl.appendChild(tr);
    });
  };

  const renderSummary = (summary: DashboardSummary | null) => {
    if (!summary) {
      totalTimeEl.textContent = '0 min';
      totalSitesEl.textContent = '0';
      tabsOpenedEl.textContent = '0';
      tabSwitchesEl.textContent = '0';
      renderTop10([]);
      return;
    }

    totalTimeEl.textContent = `${summary.totalMinutes} min`;
    totalSitesEl.textContent = String(summary.totalSites);
    tabsOpenedEl.textContent = String(summary.totalTabsOpened);
    tabSwitchesEl.textContent = String(summary.totalTabSwitches);
    renderTop10(summary.top10 || []);
  };

  const loadSummary = async (period: DashboardPeriod) => {
    const resp = await sendOptionsMessage<{ ok: boolean; summary: DashboardSummary }>({
      type: 'dashboard:getSummary',
      period
    });

    if (!resp?.ok) {
      renderSummary(null);
      return;
    }

    renderSummary(resp.summary);
  };

  const setActivePeriodTab = (period: DashboardPeriod) => {
    currentPeriod = period;
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.period === period);
    });
  };

  const exportBackup = async () => {
    const resp = await sendOptionsMessage<{ ok: boolean; backup: any }>({ type: 'backup:export' });
    if (!resp?.ok) {
      setStatus('Backup export failed.', true);
      return;
    }

    const blob = new Blob([JSON.stringify(resp.backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `doomscroll-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('Backup exported.');
  };

  const importBackup = async (file: File) => {
    const text = await file.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      setStatus('Invalid JSON file.', true);
      return;
    }

    const resp = await sendOptionsMessage<{ ok: boolean; error?: string }>({ type: 'backup:import', backup: parsed });
    if (!resp?.ok) {
      setStatus(resp?.error || 'Import failed.', true);
      return;
    }

    setStatus('Backup imported. Reloading dashboard...');
    await loadGlobalSettings();
    await loadSummary(currentPeriod);
  };

  saveGlobalEl.addEventListener('click', () => {
    void saveGlobalSettings();
  });

  exportBackupEl.addEventListener('click', () => {
    void exportBackup();
  });

  importBackupBtnEl.addEventListener('click', () => {
    importBackupEl.click();
  });

  importBackupEl.addEventListener('change', () => {
    const file = importBackupEl.files?.[0];
    if (!file) return;
    void importBackup(file);
  });

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = (btn.dataset.period || 'daily') as DashboardPeriod;
      setActivePeriodTab(p);
      void loadSummary(p);
    });
  });

  await loadGlobalSettings();
  setActivePeriodTab('daily');
  await loadSummary('daily');
});
