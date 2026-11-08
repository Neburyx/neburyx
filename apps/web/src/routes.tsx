import { Link, Outlet, type RouteObject } from 'react-router';
import type { ApiClient } from './api/client.js';
import { ProfileProvider } from './canvas/profile-context.js';
import { createProfileStore } from './canvas/profile-store.js';
import { PageHeading } from './shell/page-heading.js';
import { EXPLORE_PATH } from './shell/navigation.js';
import { PageShell } from './shell/page-shell.js';
import { SearchPage } from './search/search-page.js';
import { ApiClientProvider } from './api/client-context.js';
import { createWorkspacePresence, WorkspacePresenceProvider } from './workspace/workspace-presence.js';
import { SearchShortcut } from './search/search-shortcut.js';
import { SourcesPage } from './sources/sources-page.js';
import { createExcerpts } from './sources/excerpts.js';
import { ExcerptsProvider } from './sources/excerpts-context.js';
import { createTestRuns } from './sources/test-runs.js';
import { TestRunsProvider } from './sources/test-runs-context.js';
import { answeredData, createShellData, ShellDataProvider } from './shell/shell-data.js';
import { createCoverageStore } from './api/coverage-store.js';
import { createPreviewStore } from './api/preview-store.js';
import { CoverageProvider } from './workspace/coverage-context.js';
import { PreviewProvider } from './workspace/preview-context.js';
import { ExpandProvider } from './workspace/expand-context.js';
import { createHeavyGuard } from './api/heavy-guard.js';
import { createExpandStore } from './api/expand-store.js';
import type { ClientState } from './state/client-state.js';
import type { BannerController } from './banner/banner-controller.js';
import { bannerReporter } from './banner/banner-reporter.js';
import { createRequestTracker } from './banner/request-tracker.js';
import { sourceNameOf } from './shell/current-source.js';
import { StartPage } from './first-run/start-page.js';
import { RecentProvider } from './home/recent-context.js';
import { createRecentInvestigations } from './home/recent-store.js';
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

export function appRoutes(client: ApiClient, state: ClientState, banner?: BannerController): RouteObject[] {
  const shellData = createShellData(client);
  const testRuns = createTestRuns(client, shellData);
  const excerpts = createExcerpts(client);
  const profile = createProfileStore(client, state.investigation);
  const person = (): string => answeredData(shellData.getState().me)?.principal.id ?? '';
  const report = banner === undefined ? undefined : bannerReporter(banner, (sourceId) => sourceNameOf(answeredData(shellData.getState().sources)?.items ?? [], sourceId));
  const sourceItems = () => answeredData(shellData.getState().sources)?.items ?? [];
  const tracker =
    banner === undefined
      ? undefined
      : createRequestTracker(banner, {
          titleOf: (ref) => state.loadedGraph().nodes.find((node) => node.ref.sourceId === ref.sourceId && node.ref.entityType === ref.entityType && node.ref.stableId === ref.stableId)?.display.title,
          timeoutOf: (sourceId) => sourceItems().find((source) => source.id === sourceId)?.timeoutMs,
        });
  const previews = createPreviewStore(client, person, report, tracker);
  const coverage = createCoverageStore(client, person, report);
  const expansions = createExpandStore(client, state, person, report, banner === undefined ? undefined : createHeavyGuard(previews, banner, state), tracker);
  const recent = createRecentInvestigations(client);
  const presence = createWorkspacePresence();
  return [
    {
      path: '/',
      element: (
        <ApiClientProvider client={client}>
          <WorkspacePresenceProvider presence={presence}>
            <ShellDataProvider store={shellData}>
              <ProfileProvider store={profile}>
                <PreviewProvider store={previews}>
                <CoverageProvider store={coverage}>
                <ExpandProvider store={expansions}>
                <TestRunsProvider runs={testRuns}>
                  <ExcerptsProvider excerpts={excerpts}>
                    <SearchShortcut />
                    <RecentProvider recent={recent}>
                      <Outlet />
                    </RecentProvider>
                  </ExcerptsProvider>
                </TestRunsProvider>
                </ExpandProvider>
                </CoverageProvider>
                </PreviewProvider>
              </ProfileProvider>
            </ShellDataProvider>
          </WorkspacePresenceProvider>
        </ApiClientProvider>
      ),
      children: [
        {
          element: <PageShell />,
          children: [
            { index: true, element: <StartPage /> },
            { path: 'investigations', element: <NotBuiltYet title="Investigations" /> },
            { path: 'search', element: <SearchPage client={client} /> },
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
