import { useEffect, useRef, useState } from 'react';
import { copyText } from '../workspace/clipboard.js';
import { COPIED, COPY, COPY_ALL, COULD_NOT_COPY } from './copy.js';
import type { InspectorTabProps } from './inspector-tabs.js';
import { propertyText } from './property-text.js';

type CopyStatus = { readonly kind: 'copied'; readonly of: string } | { readonly kind: 'failed' };

export function PropertiesTab({ node }: InspectorTabProps) {
  const [status, setStatus] = useState<CopyStatus | undefined>(undefined);
  const latest = useRef(0);
  useEffect(() => setStatus(undefined), [node.ref.entityType, node.ref.stableId]);
  const copy = async (text: string, of: string): Promise<void> => {
    const request = (latest.current += 1);
    try {
      await copyText(text);
      if (request === latest.current) setStatus({ kind: 'copied', of });
    } catch {
      if (request === latest.current) setStatus({ kind: 'failed' });
    }
  };
  const lines = node.properties.map((property) => ({ key: property.key, text: propertyText(property) }));
  return (
    <div className="inspector-properties">
      <div className="inspector-copy-all">
        <button type="button" className="neighbor-types-link" onClick={() => void copy(lines.map((line) => `${line.key}: ${line.text}`).join('\n'), COPY_ALL)}>
          {COPY_ALL}
        </button>
        {status?.kind === 'copied' && status.of === COPY_ALL ? <span role="status">{COPIED}</span> : null}
        {status?.kind === 'failed' ? <span role="alert">{COULD_NOT_COPY}</span> : null}
      </div>
      <dl className="inspector-rows">
        {lines.map((line) => (
          <div key={line.key} className="inspector-row">
            <dt>{line.key}</dt>
            <dd>{line.text}</dd>
            <button type="button" className="neighbor-types-link" aria-label={`${COPY} ${line.key}`} onClick={() => void copy(line.text, line.key)}>
              {COPY}
            </button>
            {status?.kind === 'copied' && status.of === line.key ? <span role="status">{COPIED}</span> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}
