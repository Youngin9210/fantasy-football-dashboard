import { html, render, useErrorBoundary } from './vendor/preact.js';
import { App } from './ui/App.js';
import { ErrorFallback } from './ui/ErrorFallback.js';
import { useTheme } from './ui/useTheme.js';

function Root() {
  const [error, resetError] = useErrorBoundary();
  const [, toggleTheme] = useTheme();
  return error
    ? html`<${ErrorFallback} error=${error} reset=${resetError} />`
    : html`<${App} toggleTheme=${toggleTheme} />`;
}

render(html`<${Root} />`, document.getElementById('root'));
