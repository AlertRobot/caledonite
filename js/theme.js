// Themes and colours. Saved on this phone only.
export const THEMES = {
  classic: { label: 'Classic', mood: 'Calm and clear', preview: { bg: '#F3F5F8', card: '#FFFFFF', ink: '#14171C', line: '#DDE2E8', font: "'Bricolage Grotesque', sans-serif", dots: ['#2456C7', '#F08A3C', '#1D6A48'] }, name: 'Classic' },
  starship: { label: 'STARSHIP', mood: 'Sci-fi control deck', preview: { bg: '#0A0F1F', card: '#111933', ink: '#E8EEFF', line: '#2C3B6B', font: "'Chakra Petch', sans-serif", dots: ['#7AA2FF', '#FFA25C', '#2DD4BF'] }, name: 'Starship' },
  dragonfire: { label: 'Dragonfire', mood: 'Mystical, dragons', preview: { bg: '#15100E', card: '#221714', ink: '#F5E7D6', line: '#4A2F24', font: "'Cinzel', serif", dots: ['#8DB4E8', '#F28C28', '#F3D28A'] }, name: 'Dragonfire' },
  fairytale: { label: 'Fairytale', mood: 'Cartoon kingdom', preview: { bg: '#EFE3C8', card: '#FFF9EA', ink: '#2B1D10', line: '#3B2A1A', font: "'Grenze Gotisch', serif", dots: ['#2E5DA8', '#E07B39', '#6B3FA0'] }, name: 'Fairytale' }
};
export const PALETTES = {
  ocean: { name: 'Ocean', swatch: '#2456C7' },
  garden: { name: 'Garden', swatch: '#1D6A48' },
  berry: { name: 'Berry', swatch: '#A8326E' },
  sunset: { name: 'Sunset', swatch: '#B84E15' },
  slate: { name: 'Slate', swatch: '#27272A' }
};
const KEY = 'caledonite.look';
export function getLook() {
  let l = {};
  try { l = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { l = {}; }
  return { theme: THEMES[l.theme] ? l.theme : 'classic', palette: PALETTES[l.palette] ? l.palette : 'ocean', mode: ['auto', 'light', 'dark'].includes(l.mode) ? l.mode : 'auto' };
}
export function setLook(patch) {
  const l = Object.assign(getLook(), patch);
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch (e) { /* private mode */ }
  applyLook(l);
}
export function applyLook(l = getLook()) {
  const r = document.documentElement;
  r.dataset.theme = l.theme;
  r.dataset.palette = l.palette;
  let dark = false;
  if (l.theme === 'starship' || l.theme === 'dragonfire') dark = true;
  else if (l.theme === 'classic') dark = l.mode === 'dark' || (l.mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  r.dataset.mode = dark ? 'dark' : 'light';
  requestAnimationFrame(() => {
    const bg = getComputedStyle(r).getPropertyValue('--bg').trim();
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    if (bg) m.content = bg;
  });
}
