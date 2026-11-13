import { useState } from 'react';
import type { PatternDefinition } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import type { SaveContext } from '../builder/pattern-editor.js';
import { SavePatternDialog, type SaveMode } from './save-dialog.js';
import { SAVED_COPY } from './saved-copy.js';
import type { Notice } from './use-row-actions.js';
import type { ListedPattern } from '@neburyx/contracts';

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly definition: PatternDefinition | undefined;
  readonly context: SaveContext;
  readonly nameOf: (type: string) => string;
  /** The saved pattern the builder was opened from, when it was. */
  readonly editing: ListedPattern | undefined;
  readonly onSaved: (notice: Notice, mode: SaveMode) => void;
}

/** Save pattern in the run section: one button for a new pattern, and Save changes beside Save as new for a pattern opened from the list; each is disabled with its reason until the definition is whole and valid. */
export function SaveControls({ client, sourceId, definition, context, nameOf, editing, onSaved }: Props) {
  const [mode, setMode] = useState<SaveMode | undefined>(undefined);
  const reasonId = 'pattern-save-reason';
  const blocked = context.block !== undefined || definition === undefined;
  const buttons: ReadonlyArray<{ readonly label: string; readonly mode: SaveMode; readonly primary: boolean }> =
    editing === undefined ? [{ label: SAVED_COPY.saveButton, mode: { kind: 'new' }, primary: false }] : [{ label: SAVED_COPY.saveChanges, mode: { kind: 'change', item: editing }, primary: true }, { label: SAVED_COPY.saveAsNew, mode: { kind: 'new' }, primary: false }];
  return (
    <>
      <div className="patterns-actions">
        {buttons.map((button) => (
          <button key={button.label} type="button" className={button.primary ? 'primary' : 'secondary'} disabled={blocked} aria-describedby={blocked ? reasonId : undefined} onClick={() => setMode(button.mode)}>
            {button.label}
          </button>
        ))}
      </div>
      {blocked && context.block !== undefined ? (
        <p className="search-panel-note" id={reasonId}>
          {context.block}
        </p>
      ) : null}
      {mode === undefined || definition === undefined ? null : (
        <SavePatternDialog
          client={client}
          sourceId={sourceId}
          mode={mode}
          definition={definition}
          anchor={context.anchor}
          nameOf={nameOf}
          onClose={() => setMode(undefined)}
          onDone={(notice) => {
            setMode(undefined);
            onSaved(notice, mode);
          }}
        />
      )}
    </>
  );
}
