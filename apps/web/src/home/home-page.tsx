import { PageHeading } from '../shell/page-heading.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { HOME_COPY } from './copy.js';
import { HomeSearch } from './home-search.js';
import { OpenLinkEntry } from './open-link-entry.js';
import { RecentList } from './recent-list.js';

export function HomePage() {
  const sources = answeredData(useShellData().sources)?.items;
  const [only, ...others] = sources ?? [];
  return (
    <section className="home-page">
      <PageHeading title={HOME_COPY.title} description={HOME_COPY.description} source={only !== undefined && others.length === 0 ? { alias: only.alias, synthetic: only.synthetic } : null} />
      <HomeSearch />
      <OpenLinkEntry />
      <RecentList />
    </section>
  );
}
