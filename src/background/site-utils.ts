export function getTrackableHost(url?: string) {
  try {
    if (!url) return null;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host || null;
  } catch (_e) {
    return null;
  }
}

export function sanitizeFaviconUrl(url?: string) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  return '';
}

export function hostToDisplayName(host: string) {
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
