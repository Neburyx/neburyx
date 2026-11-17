import { HELP_LINKS, opensInNewTab } from '../help/links.js';
import { COPY } from './copy.js';

export function EnterpriseLink({ address = HELP_LINKS.enterprise }: { readonly address?: string }) {
  return (
    <p className="sources-enterprise">
      <a href={address} {...(opensInNewTab(address) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {COPY.enterpriseInterest}
      </a>
    </p>
  );
}
