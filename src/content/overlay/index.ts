(() => {
  type OverlayPayload = {
    title?: string;
    caption?: string;
    mediaUrl?: string;
  };

  const OVERLAY_ID = 'doomscroll-overlay';
  let playbackKillerTimer: number | null = null;
  let overlayShown = false; // ensure we only honor first show per page load

  function log(...args: any[]) {
    console.log('[doomscroll:overlay]', ...args);
  }

  function warn(...args: any[]) {
    console.warn('[doomscroll:overlay]', ...args);
  }

  function ensureCss() {
    try {
      const href = chrome.runtime.getURL('content/overlay/overlay.css');
      const existing = document.querySelector(`link[href="${href}"]`);
      if (!existing) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      }
    } catch (e) {
      warn('ensureCss failed', e);
    }
  }

  function stopMediaPlaybackNow() {
    const mediaEls = document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio');
    mediaEls.forEach((el) => {
      try {
        el.pause();
        el.muted = true;
      } catch (_e) {
        // ignore media pause failures
      }
    });
  }

  function startPlaybackKiller() {
    stopMediaPlaybackNow();
    if (playbackKillerTimer !== null) {
      window.clearInterval(playbackKillerTimer);
    }
    playbackKillerTimer = window.setInterval(() => {
      stopMediaPlaybackNow();
    }, 1000);
  }

  function stopPlaybackKiller() {
    if (playbackKillerTimer !== null) {
      window.clearInterval(playbackKillerTimer);
      playbackKillerTimer = null;
    }
  }

  function hideOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.remove();
    }

    // Keep `overlayShown` true for this page-load so the overlay doesn't reappear
    // immediately after the user dismisses it.
    stopPlaybackKiller();
    document.documentElement.style.overflow = '';
    if (document.body) {
      document.body.style.overflow = '';
    }
    log('overlay hidden');
  }

  function createOverlayLayout(payload: OverlayPayload) {
    ensureCss();

    const mediaUrl = typeof payload.mediaUrl === 'string' ? payload.mediaUrl : '';
    const title = payload.title || "Time's up";
    const caption = payload.caption || 'Take a short break and reset your focus.';

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    const safeMedia = (mediaUrl || '').replace(/"/g, '&quot;');
    const colors = ['#000000', '#8B4513', '#ff0000', '#008000'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    overlay.style.setProperty('--border-color', color);

    overlay.innerHTML = `
      <div class="ds-top">
        <div class="ds-top-left">
          <div class="ds-top-title">${title}</div>
          <div class="ds-top-quote">${caption}</div>
        </div>
      </div>

      <div class="ds-main">
        <div class="ds-side ds-left">
          <div class="ds-clown">🤡</div>
        </div>

        <div class="ds-center">
          ${safeMedia ? `<img class="ds-media" src="${safeMedia}" alt="Meme" />` : '<div class="ds-media-fallback">No image available</div>'}
        </div>

        <div class="ds-side ds-right">
          <div class="ds-clown">🤡</div>
        </div>
      </div>

      <div class="ds-bottom">
        <div class="ds-bottom-text">Day quota is over. Snooze is coming soon.</div>
        <div class="ds-actions">
          <button class="ds-btn" data-action="newTab" type="button">New tab</button>
          <button class="ds-btn" data-action="options" type="button">Settings</button>
          <button class="ds-btn ds-btn-danger" data-action="closeTab" type="button">Close tab</button>
        </div>
      </div>
    `;

    overlay.addEventListener('click', (e) => {
      const el = e.target as HTMLElement | null;
      const action = el?.getAttribute?.('data-action');
      if (!action) return;
      if (action !== 'newTab' && action !== 'closeTab' && action !== 'options') return;
      try {
        chrome.runtime.sendMessage({ type: 'overlay:action', action });
      } catch (_e) {
        // ignore send failures
      }
    });

    return overlay;
  }

  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === 'overlay:show') {
      try {
        if (overlayShown) {
          log('overlay:show ignored - already shown for this page load');
          sendResponse({ ok: true, alreadyShown: true });
          return true;
        }
        const overlay = createOverlayLayout((msg.payload || {}) as OverlayPayload);
        document.documentElement.style.overflow = 'hidden';
        if (document.body) document.body.style.overflow = 'hidden';
        document.documentElement.appendChild(overlay);
        overlayShown = true;
        startPlaybackKiller();
        try {
          chrome.runtime.sendMessage({ type: 'overlay:shown' });
        } catch (_e) {
          // ignore send failures
        }
        log('overlay shown', { hasMedia: Boolean(msg?.payload?.mediaUrl) });
        sendResponse({ ok: true });
      } catch (e) {
        warn('overlay show failed', e);
        sendResponse({ ok: false, error: String(e) });
      }
      return true;
    }

    if (msg?.type === 'overlay:hide') {
      hideOverlay();
      try {
        chrome.runtime.sendMessage({ type: 'overlay:hidden' });
      } catch (_e) {
        // ignore send failures
      }
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();
