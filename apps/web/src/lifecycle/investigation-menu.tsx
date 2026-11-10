import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { useClientState } from '../state/context.js';
import type { InvestigationStatus } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { utcDateTime } from '../views/format.js';
import { ActionMenu, type ActionMenuItem } from './action-menu.js';
import { DeleteInvestigationDialog } from './delete-dialog.js';
import { INVESTIGATIONS_PATH } from '../shell/navigation.js';
import { MENU_BUTTON_LABEL, MENU_LABEL, investigationDeleted } from './copy.js';
import { refreshRecord } from './refresh-record.js';
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
  const [deleting, setDeleting] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  // focus goes back once the dialog is gone: while it is open the workspace behind it is inert and cannot take focus
  const dialogOpen = renaming || deleting;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen) button.current?.focus();
    wasOpen.current = dialogOpen;
  }, [dialogOpen]);

  if (status === undefined) return null;
  const items: readonly ActionMenuItem[] = lifecycleActionsOf(status, busy).map((action) => ({
    ...action,
    run: (close) => {
      if (action.id === 'rename') {
        close(false);
        setRenaming(true);
        return;
      }
      if (action.id === 'delete') {
        close(false);
        setDeleting(true);
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
      {deleting ? <WorkspaceDeleteDialog client={client} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

/** The delete of the investigation on screen. A write of the draft that is going on is awaited and the changes not yet sent are dropped, since the investigation is going away; a failed write does not stop the delete. After it the page is the Investigations page, with the date until which the investigation can be restored. */
function WorkspaceDeleteDialog({ client, onClose }: { readonly client: ApiClient; readonly onClose: () => void }) {
  const state = useClientState();
  const navigate = useNavigate();
  const record = useStoreSelector(state.investigation, (held) => held.record);
  const id = useStoreSelector(state.investigation, (held) => held.id);
  if (record === null || id === null) return null;
  return (
    <DeleteInvestigationDialog
      target={{ id, version: record.version }}
      send={async (target) => {
        const sync = draftSyncOf(state, client);
        const held = await sync.hold({ discardPending: true });
        const result = await client.deleteInvestigation(target.id, target.version);
        if (held.kind === 'held') held.hold.release();
        // nothing more is written for an investigation that is gone, neither the changes that were waiting nor those sent as the page is left
        if (result.ok) sync.discard(target.id);
        return result;
      }}
      onDeleted={(answer) => {
        state.forget(id);
        void navigate(INVESTIGATIONS_PATH, { state: { notice: investigationDeleted(utcDateTime(answer.purgeAfter)) } });
      }}
      onGone={() => {
        draftSyncOf(state, client).discard(id);
        state.forget(id);
        void navigate(INVESTIGATIONS_PATH);
      }}
      refresh={() => refreshRecord(client, state, id)}
      onClose={onClose}
    />
  );
}
