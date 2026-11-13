import type { PatternDefinition, SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import type { Notice } from '../saved/use-row-actions.js';
import type { SaveMode } from '../saved/save-dialog.js';
import type { EditingView } from '../builder/pattern-editor.js';

/** What the run lane's view of a finished draft is given: the seam between the editor and the run (see the feature's README). */
export interface RunFlowProps {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly profile: SourceProfile;
  readonly definition: PatternDefinition;
  readonly editing: EditingView | undefined;
  /** Back to the editor, to the same draft. */
  readonly onEdit: () => void;
  readonly onSaved: (notice: Notice, mode: SaveMode) => void;
}

/** The place of the preview, the run and the save, built by the run lane; until then the panel shows the run section under the editor. */
export function RunFlow(_props: RunFlowProps): null {
  return null;
}
