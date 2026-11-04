import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './app.js';
import { createApiClient } from './api/client.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';
import { createCytoscapeRenderer } from './canvas/cytoscape-renderer.js';
import { registerBuiltInMenuItems } from './workspace/built-in-menu-items.js';
import { registerBuiltInSlots } from './workspace/built-in-slots.js';
import { registerBuiltInTools } from './workspace/built-in-tools.js';
import { createMenuRegistry } from './workspace/menu-registry.js';
import { createSelectionActionRegistry } from './workspace/selection-actions.js';
import { createPanelRegistryFor } from './workspace/panel-registry.js';
import { createSlotRegistry } from './workspace/slots.js';
import { createToolRegistry } from './workspace/tool-registry.js';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-ext-500.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-ext-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-ext-500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/workspace.css';
import './styles/sources.css';

const root = document.getElementById('root');
if (root === null) throw new Error('the page has no #root element');
const state = createClientState();
const slots = createSlotRegistry();
registerBuiltInSlots(slots);
const tools = createToolRegistry();
registerBuiltInTools(tools);
const menus = createMenuRegistry();
registerBuiltInMenuItems(menus);
const router = createBrowserRouter(appRoutes(createApiClient(), state));
createRoot(root).render(
  <StrictMode>
    <App router={router} state={state} slots={slots} selectionActions={createSelectionActionRegistry()} tools={tools} menus={menus} panels={createPanelRegistryFor(state)} createRenderer={createCytoscapeRenderer} />
  </StrictMode>,
);
