import { Link, Outlet, type RouteObject } from 'react-router';
import type { ApiClient } from './api/client.js';
import { PageHeading } from './shell/page-heading.js';
import { PageShell } from './shell/page-shell.js';
import { createShellData, ShellDataProvider } from './shell/shell-data.js';

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

function BareExplore() {
  return (
    <main>
      <h1>Explore</h1>
      <p>{NOT_BUILT}</p>
    </main>
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
  ];
}

export function appRoutes(client: ApiClient): RouteObject[] {
  const shellData = createShellData(client);
  return [
    {
      path: '/',
      element: (
        <ShellDataProvider store={shellData}>
          <Outlet />
        </ShellDataProvider>
      ),
      children: [
        {
          element: <PageShell />,
          children: [
            { index: true, element: <NotBuiltYet title="Home" /> },
            { path: 'investigations', element: <NotBuiltYet title="Investigations" /> },
            { path: 'sources', element: <NotBuiltYet title="Sources" /> },
            ...developmentRoutes(client),
            { path: '*', element: <NotFound /> },
          ],
        },
        { path: 'explore', element: <BareExplore /> },
      ],
    },
  ];
}
