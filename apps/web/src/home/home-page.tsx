import { PageHeading } from '../shell/page-heading.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { HOME_COPY } from './copy.js';
import { HomeSearch } from './home-search.js';
import { HomePatternsProvider } from './home-patterns.js';
import { LibraryCards } from './library-cards.js';
import { OpenLinkEntry } from './open-link-entry.js';
import { PatternCard } from './pattern-card.js';
import { RecentList } from './recent-list.js';
import { SourceHealthCard } from './source-health-card.js';

export function HomePage() {
  const sources = answeredData(useShellData().sources)?.items;
  const [only, ...others] = sources ?? [];
  return (
    <HomePatternsProvider>
      <section className="home-page">
        <PageHeading title={HOME_COPY.title} description={HOME_COPY.description} source={only !== undefined && others.length === 0 ? { alias: only.alias, synthetic: only.synthetic } : null} />
        <HomeSearch />
        <OpenLinkEntry />
        <LibraryCards />
        <RecentList />
        <PatternCard />
        <SourceHealthCard />
      </section>
    </HomePatternsProvider>
  );
}
