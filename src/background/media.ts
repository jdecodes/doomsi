export type OverlayPayload = {
  title: string;
  caption: string;
  mediaUrl: string;
};

const DEFAULT_CAPTIONS = [
  'Close the doomscroll, open your life.',
  'Your future self says thanks for taking a break.',
  'Tiny break now, better focus later.',
  'Scroll less. Live more.',
  'Pause. Breathe. Reset.'
];

// Helper function to fetch a random quote with a strict timeout
async function fetchRemoteQuote(warn: (...args: any[]) => void): Promise<string | null> {
  // Create a timeout controller so the request fails quickly if the internet is slow
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5 second timeout

  try {
    const resp = await fetch('https://zenquotes.io/api/random', { 
      cache: 'no-store',
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);

    if (!resp.ok) {
      warn('fetchRemoteQuote non-ok response', resp.status);
      return null;
    }

    const payload = await resp.json();
    // Quotable API returns the text in the 'content' field
    return typeof payload?.content === 'string' ? payload.content : null;
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
  try {
    const resp = await fetch('https://meme-api.com/gimme', { cache: 'no-store' });
    if (!resp.ok) {
      warn('fetchFallbackMemeUrl non-ok response', resp.status);
      return null;
    }
    const payload = await resp.json();
    const url = payload?.url;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  } catch (e) {
    warn('fetchFallbackMemeUrl error', e);
    return null;
  }
}

export async function buildOverlayPayload(log: (...args: any[]) => void, warn: (...args: any[]) => void): Promise<OverlayPayload> {
  // 1. Try to get a remote quote first
  let caption = await fetchRemoteQuote(warn);

  // 2. Fallback to local array if remote fetch failed or timed out
  if (!caption) {
    caption = DEFAULT_CAPTIONS[Math.floor(Math.random() * DEFAULT_CAPTIONS.length)] || DEFAULT_CAPTIONS[0];
  }

  const mediaUrl = (await fetchFallbackMemeUrl(warn)) || '';
  
  log('buildOverlayPayload', { hasMedia: Boolean(mediaUrl), caption });
  
  return {
    title: "Time's up",
    caption,
    mediaUrl
  };
}
