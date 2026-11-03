import { NavLink, Outlet, Link, type RouteObject } from 'react-router';
import { Principal } from './principal.js';
import type { ApiClient } from './api/client.js';

interface PageProps {
  readonly title: string;
}

function NotBuiltYet({ title }: PageProps) {
  return (
    <section>
      <h2>{title}</h2>
      <p>This screen is not built yet.</p>
    </section>
  );
}

function NotFound() {
  return (
    <section>
      <h2>Page not found</h2>
      <p>
        <Link to="/">Back to Home</Link>
      </p>
    </section>
  );
}

const NAVIGATION = [
  { to: '/', label: 'Home', end: true },
  { to: '/investigations', label: 'Investigations', end: false },
  { to: '/sources', label: 'Sources', end: false },
] as const;

function Layout({ client }: { readonly client: ApiClient }) {
  return (
    <>
      <header>
        <h1>Neburyx</h1>
        <Principal client={client} />
        <nav aria-label="Main">
          <ul>
            {NAVIGATION.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
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
  return [
    {
      path: '/',
      element: <Layout client={client} />,
      children: [
        { index: true, element: <NotBuiltYet title="Home" /> },
        { path: 'investigations', element: <NotBuiltYet title="Investigations" /> },
        { path: 'sources', element: <NotBuiltYet title="Sources" /> },
        { path: 'explore', element: <NotBuiltYet title="Explore" /> },
        ...developmentRoutes(client),
        { path: '*', element: <NotFound /> },
      ],
    },
  ];
}
