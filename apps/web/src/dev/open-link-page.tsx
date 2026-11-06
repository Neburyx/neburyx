import { OpenDeepLinkPrompt } from '../investigations/open-deep-link-prompt.js';
import { PageHeading } from '../shell/page-heading.js';

export function OpenLinkPage() {
  return (
    <section data-dev-tool="neburyx-dev-open-link-route">
      <PageHeading title="Open a deep link" description="Development only: where Home will place the prompt that opens a link, until it does." />
      <OpenDeepLinkPrompt />
    </section>
  );
}
