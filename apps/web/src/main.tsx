import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './app.js';
import { createApiClient } from './api/client.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-ext-500.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-ext-400.css';
import './styles/tokens.css';
import './styles/base.css';

const root = document.getElementById('root');
if (root === null) throw new Error('the page has no #root element');
const router = createBrowserRouter(appRoutes(createApiClient()));
createRoot(root).render(
  <StrictMode>
    <App router={router} state={createClientState()} />
  </StrictMode>,
);
