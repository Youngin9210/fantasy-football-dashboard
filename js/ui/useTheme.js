import { useState, useEffect } from '../vendor/preact.js';

// Only [data-theme="light"] is special-cased in css/styles.css; dark is the
// bare :root default, so setting data-theme="dark" matches no rule and is
// harmless.
export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('ffTheme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ffTheme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}
