// Shared reactive theme state (Svelte 5 runes in a module)
// mode: 'system' | 'light' | 'dark'

let _mode = $state('system');
let _systemDark = $state(false);

export const theme = {
  get mode()     { return _mode; },
  get isDark()   { return _mode === 'dark' || (_mode === 'system' && _systemDark); },
  get resolved() { return this.isDark ? 'dark' : 'light'; },

  /** Call once from layout onMount — reads localStorage, sets up system listener. */
  init() {
    try {
      const saved = localStorage.getItem('theme-mode');
      if (saved === 'light' || saved === 'dark' || saved === 'system') _mode = saved;
    } catch { /* SSR / private browsing */ }

    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      _systemDark = mq.matches;
      mq.addEventListener('change', (e) => { _systemDark = e.matches; });
    }
  },

  /** Cycle: system → dark → light → system */
  toggle() {
    _mode = _mode === 'system' ? 'dark' : _mode === 'dark' ? 'light' : 'system';
    try { localStorage.setItem('theme-mode', _mode); } catch { /* ignore */ }
  },
};
