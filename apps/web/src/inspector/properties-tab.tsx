import { CopyButton } from '../workspace/copy-button.js';
import { COPY_ALL, COPY_ALL_LABEL, copyLabel } from './copy.js';
import type { InspectorTabProps } from './inspector-tabs.js';
import { propertyText } from './property-text.js';

export function PropertiesTab({ node }: InspectorTabProps) {
  const lines = node.properties.map((property) => ({ key: property.key, text: propertyText(property) }));
  return (
    <div className="inspector-properties">
      <div className="inspector-copy-all">
        <CopyButton align="start" label={COPY_ALL_LABEL} caption={COPY_ALL} text={lines.map((line) => `${line.key}: ${line.text}`).join('\n')} />
      </div>
      <dl className="inspector-rows">
        {lines.map((line) => (
          <div key={line.key} className="inspector-row">
            <dt>{line.key}</dt>
            <dd>{line.text}</dd>
            <CopyButton label={copyLabel(line.key)} text={line.text} />
          </div>
        ))}
      </dl>
    </div>
  );
}
