export {};
// Inlined media and site-utils to avoid cross-file ES module imports inside the
// service worker. Some Chromium versions fail fetching module dependencies
// during service worker registration; keeping the SW single-file avoids that.

type OverlayPayload = { title: string; caption: string; mediaUrl: string };

const DEFAULT_CAPTIONS = [
  'Close the doomscroll, open your life.',
  'Your future self says thanks for taking a break.',
  'Tiny break now, better focus later.',
  'Scroll less. Live more.',
  'Pause. Breathe. Reset.'
];

// Helper function to fetch a random quote with a strict timeout
async function fetchRemoteQuote(warn: (...args: any[]) => void): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5 second timeout

  try {
    // Kanye Rest is 100% free, CORS-friendly, and very fast
    const resp = await fetch('https://api.kanye.rest/', { 
      cache: 'no-store',
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);

    if (!resp.ok) {
      warn('fetchRemoteQuote non-ok response', resp.status);
      return null;
    }

    const payload = await resp.json();
    
    // The API returns an object format: { "quote": "text" }
    if (payload && typeof payload.quote === 'string') {
      return payload.quote;
    }

    return null;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      warn('fetchRemoteQuote timed out');
    } else {
      warn('fetchRemoteQuote error', e);
    }
    return null;
  }
}

async function fetchFallbackMemeUrl(warn: (...args: any[]) => void): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5 second timeout
  try {
    const resp = await fetch('https://meme-api.com/gimme', {
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      warn('fetchFallbackMemeUrl non-ok response', resp.status);
      return null;
    }
    const payload = await resp.json();
    const url = payload?.url;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      warn('fetchFallbackMemeUrl timed out');
    } else {
      warn('fetchFallbackMemeUrl error', e);
    }
    return null;
  }
}

async function buildOverlayPayload(log: (...args: any[]) => void, warn: (...args: any[]) => void): Promise<OverlayPayload> {
  const start = Date.now();

  // Run remote calls in parallel (both have strict timeouts).
  const [quoteRes, memeRes] = await Promise.allSettled([
    fetchRemoteQuote(warn),
    fetchFallbackMemeUrl(warn)
  ]);

  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const memeUrl = memeRes.status === 'fulfilled' ? memeRes.value : null;

  const caption =
    quote || DEFAULT_CAPTIONS[Math.floor(Math.random() * DEFAULT_CAPTIONS.length)] || DEFAULT_CAPTIONS[0];
  const mediaUrl = memeUrl || '';

  log('buildOverlayPayload', {
    ms: Date.now() - start,
    hasMedia: Boolean(mediaUrl),
    hasQuote: Boolean(quote),
    caption
  });
  return {
    title: "Time's up",
    caption,
    mediaUrl
  };
}

function getTrackableHost(url?: string) {
  try {
    if (!url) return null;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host || null;
  } catch (_e) {
    return null;
  }
}

function sanitizeFaviconUrl(url?: string) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  return '';
}

function hostToDisplayName(host: string) {
  const normalized = host.toLowerCase();
  if (normalized === 'youtube.com' || normalized === 'www.youtube.com') return 'YouTube';
  if (normalized === 'music.youtube.com') return 'YouTube Music';
  if (normalized === 'x.com' || normalized === 'www.x.com' || normalized === 'twitter.com' || normalized === 'www.twitter.com') return 'X';
  if (normalized === 'facebook.com' || normalized === 'www.facebook.com' || normalized === 'm.facebook.com') return 'Facebook';
  if (normalized === 'instagram.com' || normalized === 'www.instagram.com') return 'Instagram';
  if (normalized === 'reddit.com' || normalized === 'www.reddit.com') return 'Reddit';
  if (normalized === 'gemini.google.com') return 'Gemini';

  const first = normalized.replace(/^www\./, '').split('.')[0] || normalized;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const DEFAULT_MAX_MINUTES = 1;
const MIN_THRESHOLD_MINUTES = 1;
const MAX_THRESHOLD_MINUTES = 30;
const ALARM_NAME = 'reconcile';
// MV3-friendly but responsive enough for "over threshold" enforcement.
// 15s avoids the prior 6s aggressiveness while keeping UX snappy.
const ALARM_PERIOD_MINUTES = 0.25;

const GLOBAL_SETTINGS_KEY = 'settings:global';
const SITE_SETTINGS_PREFIX = 'settings:site:';
const STATS_PREFIX = 'stats:';
const HOST_META_KEY = 'hosts:meta';

type GlobalSettings = {
  defaultThresholdMinutes: number;
};

type SiteSettings = {
  enabled: boolean;
  thresholdMinutes: number;
};

type DayStats = {
  tabsOpened: number;
  tabSwitches: number;
};

type HostMeta = {
  displayName: string;
  faviconUrl: string;
};

type UsageSummaryItem = {
  host: string;
  seconds: number;
  displayName: string;
  faviconUrl: string;
};

type DashboardPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

let currentActive: { tabId: number; host: string; startTs: number } | null = null;
const ports: chrome.runtime.Port[] = [];
let lastActivatedTabId: number | null = null;
const OVERLAY_RESHOW_COOLDOWN_MS = 2500;
const overlayLastShownAtByTab = new Map<number, number>();
const overlayVisibleByTab = new Map<number, { host: string; sinceTs: number }>();
let hostMetaCache: Record<string, HostMeta> | null = null;

function log(...args: any[]) {
  console.log('[doomscroll:bg]', ...args);
}

function warn(...args: any[]) {
  console.warn('[doomscroll:bg]', ...args);
}

// quick startup signal for SW registration troubleshooting
log('service worker starting');

function pad2(v: number) {
  return String(v).padStart(2, '0');
}

function getDateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clampMinutes(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_MINUTES;
  return Math.min(MAX_THRESHOLD_MINUTES, Math.max(MIN_THRESHOLD_MINUTES, Math.floor(value)));
}


function siteSettingsKey(host: string) {
  return `${SITE_SETTINGS_PREFIX}${host}`;
}

function statsKey(dateKey: string) {
  return `${STATS_PREFIX}${dateKey}`;
}

function storageGet(keys: null | string | string[]) {
  return new Promise<Record<string, any>>((resolve) => {
    chrome.storage.local.get(keys as any, (res) => resolve(res || {}));
  });
}

function storageSet(values: Record<string, any>) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageClear() {
  return new Promise<void>((resolve) => {
    chrome.storage.local.clear(() => {
      hostMetaCache = null;
      resolve();
    });
  });
}

async function readHostMetaMap(): Promise<Record<string, HostMeta>> {
  if (hostMetaCache) return hostMetaCache;
  const res = await storageGet([HOST_META_KEY]);
  const raw = (res[HOST_META_KEY] || {}) as Record<string, HostMeta>;
  hostMetaCache = raw;
  return raw;
}

async function saveHostMetaMap(meta: Record<string, HostMeta>) {
  hostMetaCache = meta;
  await storageSet({ [HOST_META_KEY]: meta });
}

async function updateHostMeta(host: string, tab: chrome.tabs.Tab | undefined) {
  const meta = await readHostMetaMap();
  const existing = meta[host];
  const next: HostMeta = {
    displayName: hostToDisplayName(host),
    faviconUrl: sanitizeFaviconUrl(tab?.favIconUrl) || existing?.faviconUrl || ''
  };

  if (
    existing &&
    existing.displayName === next.displayName &&
    existing.faviconUrl === next.faviconUrl
  ) {
    return;
  }

  meta[host] = next;
  await saveHostMetaMap(meta);
  log('updateHostMeta', { host, displayName: next.displayName, hasFavicon: Boolean(next.faviconUrl) });
}

async function readUsageForDate(dateKey: string): Promise<Record<string, number>> {
  const key = `usage:${dateKey}`;
  const res = await storageGet([key]);
  return (res[key] || {}) as Record<string, number>;
}

async function saveUsageForDate(dateKey: string, data: Record<string, number>) {
  await storageSet({ [`usage:${dateKey}`]: data });
}

async function readStatsForDate(dateKey: string): Promise<DayStats> {
  const key = statsKey(dateKey);
  const res = await storageGet([key]);
  const raw = (res[key] || {}) as Partial<DayStats>;
  return {
    tabsOpened: Math.max(0, Math.floor(raw.tabsOpened || 0)),
    tabSwitches: Math.max(0, Math.floor(raw.tabSwitches || 0))
  };
}

async function saveStatsForDate(dateKey: string, stats: DayStats) {
  await storageSet({ [statsKey(dateKey)]: stats });
}

async function incrementDailyStat(field: keyof DayStats, amount = 1) {
  const dateKey = getDateKey();
  const stats = await readStatsForDate(dateKey);
  stats[field] = Math.max(0, Math.floor(stats[field] + amount));
  await saveStatsForDate(dateKey, stats);
  log('incrementDailyStat', { dateKey, field, value: stats[field] });
}

async function getGlobalSettings(): Promise<GlobalSettings> {
  const res = await storageGet([GLOBAL_SETTINGS_KEY]);
  const raw = (res[GLOBAL_SETTINGS_KEY] || {}) as Partial<GlobalSettings>;
  return {
    defaultThresholdMinutes: clampMinutes(raw.defaultThresholdMinutes || DEFAULT_MAX_MINUTES)
  };
}

async function setGlobalSettings(patch: Partial<GlobalSettings>) {
  const current = await getGlobalSettings();
  const next: GlobalSettings = {
    defaultThresholdMinutes: clampMinutes(
      typeof patch.defaultThresholdMinutes === 'number'
        ? patch.defaultThresholdMinutes
        : current.defaultThresholdMinutes
    )
  };
  await storageSet({ [GLOBAL_SETTINGS_KEY]: next });
  log('setGlobalSettings', next);
  return next;
}

async function getSiteSettings(host: string): Promise<SiteSettings> {
  const key = siteSettingsKey(host);
  const res = await storageGet([key]);
  const raw = res[key] as Partial<SiteSettings> | undefined;
  const global = await getGlobalSettings();
  return {
    enabled: raw?.enabled !== false,
    thresholdMinutes: clampMinutes(raw?.thresholdMinutes || global.defaultThresholdMinutes)
  };
}

async function setSiteSettings(host: string, patch: Partial<SiteSettings>) {
  const current = await getSiteSettings(host);
  const next: SiteSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    thresholdMinutes: clampMinutes(
      typeof patch.thresholdMinutes === 'number' ? patch.thresholdMinutes : current.thresholdMinutes
    )
  };
  await storageSet({ [siteSettingsKey(host)]: next });
  log('setSiteSettings', { host, settings: next });
  return next;
}

async function resolveHostThresholdSeconds(host: string): Promise<number | null> {
  const site = await getSiteSettings(host);
  if (!site.enabled) {
    log('resolveHostThresholdSeconds disabled', { host });
    return null;
  }
  return clampMinutes(site.thresholdMinutes) * 60;
}

async function isHostOverThreshold(host: string): Promise<boolean> {
  const thresholdSeconds = await resolveHostThresholdSeconds(host);
  if (!thresholdSeconds) return false;

  const dateKey = getDateKey();
  const usage = await readUsageForDate(dateKey);
  const seconds = usage[host] || 0;
  const over = seconds >= thresholdSeconds;
  log('isHostOverThreshold', { host, seconds, thresholdSeconds, over });
  return over;
}

async function addSecondsForHost(host: string, seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (!safeSeconds) return;
  const dateKey = getDateKey();
  const usage = await readUsageForDate(dateKey);
  usage[host] = (usage[host] || 0) + safeSeconds;
  await saveUsageForDate(dateKey, usage);
  log('addSecondsForHost', { host, safeSeconds, totalSecondsToday: usage[host], dateKey });
}

async function flushCurrentActive(nowTs = Date.now()) {
  const activeAtStart = currentActive;
  if (!activeAtStart) return;

  const elapsed = Math.floor((nowTs - activeAtStart.startTs) / 1000);
  log('flushCurrentActive', { host: activeAtStart.host, tabId: activeAtStart.tabId, elapsed });
  if (elapsed > 0) {
    await addSecondsForHost(activeAtStart.host, elapsed);
  }

  // `currentActive` can be cleared/replaced while we awaited storage writes above.
  // Only update the start timestamp if it's still the same active session.
  if (
    currentActive &&
    currentActive.tabId === activeAtStart.tabId &&
    currentActive.host === activeAtStart.host
  ) {
    currentActive.startTs = nowTs;
  }
}

function ensureHostPermission(host: string): Promise<boolean> {
  const httpsOrigin = `https://${host}/*`;
  const httpOrigin = `http://${host}/*`;
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [httpsOrigin, httpOrigin] }, (has) => {
      log('ensureHostPermission', { host, has });
      resolve(Boolean(has));
    });
  });
}


function getStartOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getPeriodDates(period: DashboardPeriod, now = new Date()) {
  // Dashboard periods are rolling windows (not calendar-bound):
  // - daily: today
  // - weekly: last 7 days (incl today)
  // - monthly: last 30 days (incl today)
  // - yearly: last 365 days (incl today)
  const end = getStartOfDay(now);

  const days =
    period === 'daily'
      ? 1
      : period === 'weekly'
        ? 7
        : period === 'monthly'
          ? 30
          : 365;

  const dates: Date[] = [];
  const cursor = new Date(end);
  cursor.setDate(cursor.getDate() - (days - 1));

  while (cursor <= end) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

async function computeSummary(period: DashboardPeriod) {
  const dates = getPeriodDates(period);
  const hostTotals: Record<string, number> = {};
  let totalSeconds = 0;
  let totalTabsOpened = 0;
  let totalTabSwitches = 0;

  for (const d of dates) {
    const dateKey = getDateKey(d.getTime());
    const usage = await readUsageForDate(dateKey);
    for (const [host, seconds] of Object.entries(usage)) {
      const s = Math.max(0, Math.floor(seconds || 0));
      if (!s) continue;
      hostTotals[host] = (hostTotals[host] || 0) + s;
      totalSeconds += s;
    }

    const stats = await readStatsForDate(dateKey);
    totalTabsOpened += stats.tabsOpened;
    totalTabSwitches += stats.tabSwitches;
  }

  const hostMeta = await readHostMetaMap();
  const ranked: UsageSummaryItem[] = Object.entries(hostTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([host, seconds]) => ({
      host,
      seconds,
      displayName: hostMeta[host]?.displayName || hostToDisplayName(host),
      faviconUrl: hostMeta[host]?.faviconUrl || ''
    }));

  const summary = {
    period,
    totalSeconds,
    totalMinutes: Math.round(totalSeconds / 60),
    totalSites: ranked.length,
    totalTabsOpened,
    totalTabSwitches,
    top5: ranked.slice(0, 5),
    top10: ranked.slice(0, 10),
    ranked
  };
  log('computeSummary', { period, totalSites: summary.totalSites, totalMinutes: summary.totalMinutes });
  return summary;
}

async function injectOverlayForHost(host: string) {
  const start = Date.now();
  const active = currentActive;
  if (!active || active.host !== host) {
    log('injectOverlayForHost skipped inactive host', { host, activeHost: active?.host || null });
    return;
  }

  log('injectOverlayForHost start', { host, tabId: active.tabId });
  const granted = await ensureHostPermission(host);
  if (!granted) {
    warn('permission missing for host', host);
    for (const p of ports) p.postMessage({ type: 'permissionDenied', host });
    return;
  }

  const tabId = active.tabId;
  const now = Date.now();
  const lastShown = overlayLastShownAtByTab.get(tabId) || 0;
  if (now - lastShown < OVERLAY_RESHOW_COOLDOWN_MS) {
    log('injectOverlayForHost skipped by cooldown', { host, tabId });
    return;
  }

  const tPayloadStart = Date.now();
  const payload = await buildOverlayPayload(log, warn);
  log('injectOverlayForHost payload ready', { host, tabId, ms: Date.now() - tPayloadStart });
  try {
    // augment title with wasted minutes for clearer top-bar messaging
    const dateKey = getDateKey();
    const usage = await readUsageForDate(dateKey);
    const seconds = Math.max(0, Math.floor(usage[host] || 0));
    const minutes = Math.round(seconds / 60) || 0;
    payload.title = `${minutes} Minute${minutes === 1 ? '' : 's'} wasted in Matrix`;
    log('injectOverlayForHost payload', { host, minutes, hasMedia: Boolean(payload.mediaUrl) });
  } catch (e) {
    warn('failed to compute minutes for payload', e);
  }

  const sendOverlayShow = () =>
    new Promise<boolean>((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'overlay:show', payload }, () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });

  const tSendStart = Date.now();
  const sentDirectly = await sendOverlayShow();
  log('injectOverlayForHost sendOverlayShow result', {
    host,
    tabId,
    sentDirectly,
    ms: Date.now() - tSendStart,
    totalMs: Date.now() - start
  });
  if (!sentDirectly) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay/index.js'] }, async () => {
      if (chrome.runtime.lastError) {
        warn('inject overlay script error', chrome.runtime.lastError.message);
        return;
      }

      const sentAfterInject = await sendOverlayShow();
      if (!sentAfterInject) {
        warn('overlay message failed after inject', { host, tabId });
        return;
      }

      overlayLastShownAtByTab.set(tabId, Date.now());
      log('overlay shown (after inject)', { host, tabId, totalMs: Date.now() - start });
    });
    return;
  }

  overlayLastShownAtByTab.set(tabId, now);
  log('overlay shown (direct)', { host, tabId, totalMs: Date.now() - start });
}

async function checkThresholdAndFire(host: string) {
  const over = await isHostOverThreshold(host);
  if (!over) return;

  log('checkThresholdAndFire firing overlay', { host });
  await injectOverlayForHost(host);
}

function notifyActive(host: string | null) {
  for (const p of ports) {
    p.postMessage({ type: 'activeChanged', host });
  }
}

async function switchActiveTo(tab: chrome.tabs.Tab | undefined, countSwitch: boolean) {
  const tabId = tab?.id;
  const rawUrl = tab?.url || tab?.pendingUrl || undefined;
  const host = getTrackableHost(rawUrl);
  const now = Date.now();

  if (typeof tabId === 'number' && overlayVisibleByTab.has(tabId)) {
    // If the blocking overlay is up on this tab, we treat it as "inactive" so
    // time does not accrue while the popup is shown.
    log('switchActiveTo suppressed due to overlay visible', { tabId });
    await flushCurrentActive(now);
    currentActive = null;
    notifyActive(null);
    return;
  }

  if (countSwitch && typeof tabId === 'number' && lastActivatedTabId !== null && lastActivatedTabId !== tabId) {
    await incrementDailyStat('tabSwitches', 1);
  }
  if (typeof tabId === 'number') {
    lastActivatedTabId = tabId;
  }

  if (!tabId) {
    log('switchActiveTo clearing active (no tab id)', { tabId, rawUrl });
    await flushCurrentActive(now);
    currentActive = null;
    notifyActive(null);
    return;
  }

  if (!host) {
    if (currentActive && currentActive.tabId === tabId) {
      log('switchActiveTo keeping previous host due temporary untrackable url', { tabId, rawUrl });
      return;
    }
    log('switchActiveTo clearing active (untrackable)', { tabId, rawUrl });
    await flushCurrentActive(now);
    currentActive = null;
    notifyActive(null);
    return;
  }

  if (currentActive && currentActive.tabId === tabId && currentActive.host === host) {
    return;
  }

  if (currentActive) {
    await flushCurrentActive(now);
  }

  currentActive = { tabId, host, startTs: now };
  void updateHostMeta(host, tab);
  log('switchActiveTo', { tabId, host, countSwitch });
  notifyActive(host);
  await checkThresholdAndFire(host);
}

function ensureReconcileAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      log('creating alarm', { name: ALARM_NAME, periodMinutes: ALARM_PERIOD_MINUTES });
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
    }
  });
}

function bootstrapActiveTab() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    log('bootstrapActiveTab', { found: Boolean(tabs[0]), tabId: tabs[0]?.id || null });
    void switchActiveTo(tabs[0], false);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  log('onInstalled', { reason: details.reason });
  ensureReconcileAlarm();
  bootstrapActiveTab();
  if (details.reason === 'install') {
    // Basic onboarding: show dashboard/settings on first install.
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  log('onStartup');
  ensureReconcileAlarm();
  bootstrapActiveTab();
});

ensureReconcileAlarm();
bootstrapActiveTab();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  log('alarm fired', { alarm: alarm.name });

  void (async () => {
    if (!currentActive) return;
    const host = currentActive.host;
    await flushCurrentActive(Date.now());
    await checkThresholdAndFire(host);
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  log('tab created', { tabId: tab.id, url: tab.url || tab.pendingUrl || null });
  void incrementDailyStat('tabsOpened', 1);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  log('tab activated', activeInfo);
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    void switchActiveTo(tab, true);
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  log('window focus changed', { windowId });
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void (async () => {
      await flushCurrentActive(Date.now());
      currentActive = null;
      notifyActive(null);
    })();
    return;
  }

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    void switchActiveTo(tabs[0], false);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.status && !changeInfo.url) return;

  // Clear overlay state when tab navigates/reloads (content script gets torn down)
  if (changeInfo.status === 'loading' || Boolean(changeInfo.url)) {
    overlayVisibleByTab.delete(tabId);
    overlayLastShownAtByTab.delete(tabId);
  }

  // When page starts loading, check if site is already over threshold
  if (changeInfo.status === 'loading' || Boolean(changeInfo.url)) {
    const host = getTrackableHost(tab.url || tab.pendingUrl || undefined);
    if (host) {
      log('page loading', { tabId, host });
      void (async () => {
        const over = await isHostOverThreshold(host);
        if (over) {
          log('host already over threshold, will show overlay', { host, tabId });
          // Set as active and inject overlay
          currentActive = { tabId, host, startTs: Date.now() };
          notifyActive(host);
          await injectOverlayForHost(host);
        }
      })();
    }
  }

  // For page completion, update active tracking
  if (!currentActive) return;
  if (currentActive.tabId !== tabId) return;
  
  if (changeInfo.status === 'complete') {
    log('tab complete', { tabId, host: currentActive.host });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  overlayVisibleByTab.delete(tabId);
  overlayLastShownAtByTab.delete(tabId);
  if (currentActive?.tabId === tabId) {
    currentActive = null;
    notifyActive(null);
  }
});

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  const type = msg?.type;
  log('message received', { type });

  if (type === 'overlay:action') {
    const tabId = sender?.tab?.id;
    const action = msg?.action as string;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'tabId missing' });
      return true;
    }

    if (action === 'options') {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return true;
    }

    if (action === 'newTab') {
      chrome.tabs.create({ url: 'chrome://newtab' }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        chrome.tabs.remove(tabId, () => {
          sendResponse({ ok: true });
        });
      });
      return true;
    }

    if (action === 'closeTab') {
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    sendResponse({ ok: false, error: 'unknown action' });
    return true;
  }

  if (type === 'overlay:shown') {
    const tabId = sender?.tab?.id;
    const rawUrl = sender?.tab?.url || sender?.tab?.pendingUrl || undefined;
    const host = getTrackableHost(rawUrl);
    if (typeof tabId !== 'number' || !host) {
      sendResponse({ ok: false });
      return true;
    }

    overlayVisibleByTab.set(tabId, { host, sinceTs: Date.now() });
    log('overlay shown (pause timer)', { tabId, host });

    void (async () => {
      const active = currentActive;
      if (active && active.tabId === tabId) {
        await flushCurrentActive(Date.now());
        currentActive = null;
        notifyActive(null);
      }
    })();

    sendResponse({ ok: true });
    return true;
  }

  if (type === 'overlay:hidden') {
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      overlayVisibleByTab.delete(tabId);
      log('overlay hidden (resume eligible)', { tabId });
      // If this tab is currently active, resume tracking it immediately.
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs[0]?.id === tabId) {
          void switchActiveTo(tabs[0], false);
        }
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (type === 'getDefaults') {
    void getGlobalSettings().then((g) => sendResponse({ maxMinutes: g.defaultThresholdMinutes }));
    return true;
  }

  if (type === 'settings:getGlobal') {
    void getGlobalSettings().then((g) => sendResponse({ ok: true, settings: g }));
    return true;
  }

  if (type === 'settings:setGlobal') {
    void setGlobalSettings(msg?.settings || {}).then((g) => sendResponse({ ok: true, settings: g }));
    return true;
  }

  if (type === 'settings:getSite') {
    const host = typeof msg?.host === 'string' ? msg.host : '';
    if (!host) {
      sendResponse({ ok: false, error: 'host required' });
      return true;
    }
    void getSiteSettings(host).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (type === 'settings:setSite') {
    const host = typeof msg?.host === 'string' ? msg.host : '';
    if (!host) {
      sendResponse({ ok: false, error: 'host required' });
      return true;
    }
    void setSiteSettings(host, msg?.settings || {}).then((settings) => {
      // When disabling a site, find and hide the overlay on any tab showing it for that host
      if (!settings.enabled) {
        for (const [tabId, overlayInfo] of overlayVisibleByTab.entries()) {
          if (overlayInfo.host === host) {
            chrome.tabs.sendMessage(tabId, { type: 'overlay:hide' }, () => {
              if (chrome.runtime.lastError) {
                log('overlay hide skipped', chrome.runtime.lastError.message);
              }
            });
            break; // Only hide one overlay per disable action
          }
        }
      }
      sendResponse({ ok: true, settings });
    });
    return true;
  }

  if (type === 'session:getActive') {
    if (currentActive?.host) {
      sendResponse({ host: currentActive.host });
      return true;
    }

    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const host = getTrackableHost(tabs[0]?.url || tabs[0]?.pendingUrl || undefined);
      sendResponse({ host: host || null });
    });
    return true;
  }

  if (type === 'usage:getTodaySummary') {
    void computeSummary('daily').then((summary) => sendResponse({ ok: true, summary }));
    return true;
  }

  if (type === 'dashboard:getSummary') {
    const period = (msg?.period || 'daily') as DashboardPeriod;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(period)) {
      sendResponse({ ok: false, error: 'invalid period' });
      return true;
    }
    void computeSummary(period).then((summary) => sendResponse({ ok: true, summary }));
    return true;
  }

  if (type === 'debug:getUsage') {
    const dateKey = getDateKey();
    void readUsageForDate(dateKey).then((u) => sendResponse({ date: dateKey, usage: u }));
    return true;
  }

  if (type === 'debug:ping') {
    sendResponse({ ok: true });
    return true;
  }

  if (type === 'permission:granted') {
    const host = msg?.host as string;
    if (host) {
      log('permission granted for host from popup', host);
      void injectOverlayForHost(host);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (type === 'backup:export') {
    void storageGet(null).then((data) => {
      sendResponse({
        ok: true,
        backup: {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          data
        }
      });
    });
    return true;
  }

  if (type === 'backup:import') {
    const backup = msg?.backup as { schemaVersion?: number; data?: Record<string, any> };
    if (!backup || typeof backup !== 'object' || typeof backup.data !== 'object' || !backup.data) {
      sendResponse({ ok: false, error: 'invalid backup payload' });
      return true;
    }

    void (async () => {
      log('backup import started');
      await storageClear();
      await storageSet(backup.data as Record<string, any>);
      ensureReconcileAlarm();
      bootstrapActiveTab();
      log('backup import finished');
      sendResponse({ ok: true });
    })();

    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  ports.push(port);
  log('port connected', { count: ports.length });

  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    if (i >= 0) ports.splice(i, 1);
    log('port disconnected', { count: ports.length });
  });

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'getUsage') {
      log('port message getUsage');
      void computeSummary('daily').then((summary) => {
        port.postMessage({ type: 'usage', summary });
      });
    }
  });
});
