import { HomePage } from '../home/home-page.js';
import { PageHeading } from '../shell/page-heading.js';
import { FIRST_RUN_COPY } from './copy.js';
import { FirstRunPage } from './first-run-page.js';
import { useStartPage } from './use-start-page.js';

export function StartPage() {
  const page = useStartPage();
  if (page === 'home') return <HomePage />;
  if (page === 'first-run') return <FirstRunPage />;
  return (
    <section>
      <PageHeading title={FIRST_RUN_COPY.title} description="" source={null} />
      <p role="status">{FIRST_RUN_COPY.loading}</p>
    </section>
  );
}
