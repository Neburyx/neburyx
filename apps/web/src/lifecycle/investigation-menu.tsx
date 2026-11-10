import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { useClientState } from '../state/context.js';
import type { InvestigationStatus } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import { ActionMenu, type ActionMenuItem } from './action-menu.js';
import { MENU_BUTTON_LABEL, MENU_LABEL } from './copy.js';
import { lifecycleActionsOf } from './menu-items.js';
import { RenameDialog } from './rename-dialog.js';
import { changeStatus, statusChangeBusy } from './status-flow.js';

const TARGET_OF: Readonly<Record<'reopen' | 'close' | 'archive', InvestigationStatus>> = { reopen: 'open', close: 'closed', archive: 'archived' };

/** The "···" menu next to the title: Rename, Close and Archive of an open investigation, Reopen and Archive of a closed one, Reopen of an archived one, with Rename disabled while it cannot be changed. */
export function InvestigationMenu({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const status = useStoreSelector(state.investigation, (held) => held.record?.status);
  const busy = useStoreSelector(statusChangeBusy(state), (value) => value);
  const [renaming, setRenaming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  // focus goes back once the dialog is gone: while it is open the workspace behind it is inert and cannot take focus
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) button.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  if (status === undefined) return null;
  const items: readonly ActionMenuItem[] = lifecycleActionsOf(status, busy).map((action) => ({
    ...action,
    run: (close) => {
      if (action.id === 'rename') {
        close(false);
        setRenaming(true);
        return;
      }
      close(true);
      void changeStatus({ client, state, banner }, TARGET_OF[action.id]);
    },
  }));

  return (
    <>
      <ActionMenu buttonRef={button} buttonLabel={MENU_BUTTON_LABEL} menuLabel={MENU_LABEL} items={items} />
      {renaming ? <RenameDialog client={client} onClose={() => setRenaming(false)} /> : null}
    </>
  );
}
