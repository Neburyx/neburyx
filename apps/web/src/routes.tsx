import { Link, Outlet, type RouteObject } from 'react-router';
import type { ApiClient } from './api/client.js';
import { ProfileProvider } from './canvas/profile-context.js';
import { createProfileStore } from './canvas/profile-store.js';
import { PageHeading } from './shell/page-heading.js';
import { EXPLORE_PATH } from './shell/navigation.js';
import { PageShell } from './shell/page-shell.js';
import { SourcesPage } from './sources/sources-page.js';
import { createExcerpts } from './sources/excerpts.js';
import { ExcerptsProvider } from './sources/excerpts-context.js';
import { createTestRuns } from './sources/test-runs.js';
import { TestRunsProvider } from './sources/test-runs-context.js';
import { createShellData, ShellDataProvider } from './shell/shell-data.js';
import type { ClientState } from './state/client-state.js';
import { DeepLinkPage } from './investigations/deep-link-page.js';
import { ExploreInvestigation } from './investigations/explore-investigation.js';
import { WorkspaceShell } from './workspace/workspace-shell.js';

const NOT_BUILT = 'This screen is not built yet.';

function NotBuiltYet({ title }: { readonly title: string }) {
  return (
    <section>
      <PageHeading title={title} description={NOT_BUILT} />
    </section>
  );
}

function NotFound() {
  return (
    <section>
      <PageHeading title="Page not found" description="There is no page at this address." />
      <p>
        <Link to="/">Back to Home</Link>
      </p>
    </section>
  );
}

function developmentRoutes(client: ApiClient): RouteObject[] {
  if (!__DEV_TOOLS__) return [];
  return [
    {
      path: 'dev/fixture',
      lazy: async () => {
        const { FixturePage } = await import('./dev/fixture-page.js');
        return { element: <FixturePage client={client} /> };
      },
    },
    {
      path: 'dev/open-link',
      lazy: async () => {
        const { OpenLinkPage } = await import('./dev/open-link-page.js');
        return { element: <OpenLinkPage /> };
      },
    },
    {
      path: 'dev/open-entity',
      lazy: async () => {
        const { OpenEntityPage } = await import('./dev/open-entity-page.js');
        return { element: <OpenEntityPage client={client} /> };
      },
    },
  ];
}

function workspaceDevelopmentRoutes(): RouteObject[] {
  if (!__DEV_TOOLS__) return [];
  return [
    {
      path: 'dev/frame-sample',
      lazy: async () => {
        const { FrameSamplePage } = await import('./dev/frame-sample-page.js');
        return { element: <FrameSamplePage /> };
      },
    },
  ];
}

export function appRoutes(client: ApiClient, state: ClientState): RouteObject[] {
  const shellData = createShellData(client);
  const testRuns = createTestRuns(client, shellData);
  const excerpts = createExcerpts(client);
  const profile = createProfileStore(client, state.investigation);
  return [
    {
      path: '/',
      element: (
        <ShellDataProvider store={shellData}>
          <ProfileProvider store={profile}>
            <TestRunsProvider runs={testRuns}>
              <ExcerptsProvider excerpts={excerpts}>
                <Outlet />
              </ExcerptsProvider>
            </TestRunsProvider>
          </ProfileProvider>
        </ShellDataProvider>
      ),
      children: [
        {
          element: <PageShell />,
          children: [
            { index: true, element: <NotBuiltYet title="Home" /> },
            { path: 'investigations', element: <NotBuiltYet title="Investigations" /> },
            { path: 'sources', element: <SourcesPage /> },
            ...developmentRoutes(client),
            { path: ':sourceId/entity/:entityType/:stableId', element: <DeepLinkPage client={client} /> },
            { path: '*', element: <NotFound /> },
          ],
        },
        { path: EXPLORE_PATH, element: <WorkspaceShell /> },
        { path: `${EXPLORE_PATH}/:investigationId`, element: <ExploreInvestigation client={client} /> },
        ...workspaceDevelopmentRoutes(),
      ],
    },
  ];
}
