import { html, render } from './vendor/preact.js';
import { App } from './ui/App.js';

render(html`<${App} />`, document.getElementById('root'));
