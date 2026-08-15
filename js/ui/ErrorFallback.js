import { html } from '../vendor/preact.js';

export function ErrorFallback({ error, reset }) {
  return html`<div class="panel" style="margin:16px;padding:16px;">
    <div class="panel-header">Something broke</div>
    <p class="hint">${error.message}</p>
    <button class="btn primary" onClick=${reset}>Try again</button>
    <button class="btn" onClick=${() => location.reload()}>Reload page</button>
  </div>`;
}
