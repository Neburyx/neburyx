import { useId, type ReactNode } from 'react';

export function EmptyState({ title, sentence, level = 2, icon = false, children }: { readonly title: string; readonly sentence: string; readonly level?: 2 | 3; readonly icon?: boolean; readonly children?: ReactNode }) {
  const titleId = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className="empty-state" aria-labelledby={titleId}>
      {icon ? <span className="empty-state-icon" aria-hidden="true"><span className="icon icon-investigations" /></span> : null}
      <Heading id={titleId}>{title}</Heading>
      <p>{sentence}</p>
      {children === undefined ? null : <div className="empty-state-actions">{children}</div>}
    </section>
  );
}
