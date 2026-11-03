import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './app.js';
import { createApiClient } from './api/client.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';
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
