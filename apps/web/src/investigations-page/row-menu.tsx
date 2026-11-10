import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { InvestigationListItem } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { useClientStateWhenProvided } from '../state/context.js';
import { isReadOnlyStatus, type InvestigationStatus } from '../state/investigation-state.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { ActionMenu, type ActionMenuItem } from '../lifecycle/action-menu.js';
import { lifecycleActionsOf } from '../lifecycle/menu-items.js';
import { RenameDialogView } from '../lifecycle/rename-dialog.js';
import { messageOf } from '../lifecycle/status-flow.js';
import { OPEN, ROW_MENU_BUTTON, ROW_MENU_LABEL, rowLeft } from './copy.js';

const TARGET_OF: Readonly<Record<'reopen' | 'close' | 'archive', InvestigationStatus>> = { reopen: 'open', close: 'closed', archive: 'archived' };

export interface RowMenuProps {
  readonly item: InvestigationListItem;
  readonly client: ApiClient;
  /** The status the list is filtered to: a row that changes status leaves the list. */
  readonly statusFilter: InvestigationStatus;
  readonly onChanged: (item: InvestigationListItem) => void;
  readonly onLeft: (item: InvestigationListItem, note: string) => void;
  readonly onNotice: (failure: ApiFailure | undefined) => void;
}

/** The "···" menu of one row: Open, then what the investigation's status allows (Rename, Close, Reopen, Archive); a change shows on the row from the server's answer. */
export function RowMenu({ item, client, statusFilter, onChanged, onLeft, onNotice }: RowMenuProps) {
  const navigate = useNavigate();
  const workspace = useClientStateWhenProvided();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const busyNow = useRef(false);

  // focus returns once the dialog is gone: while it is open the page behind it is inert and cannot take focus
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) button.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  const keepWorkspaceRecord = (title: string, status: InvestigationStatus, version: number): void => {
    const held = workspace?.investigation.getState();
    if (workspace !== undefined && held?.id === item.id && held.record !== null) workspace.describeInvestigation({ ...held.record, title, status, readOnly: isReadOnlyStatus(status), version });
  };

  const refresh = async (): Promise<boolean> => {
    const read = await client.getInvestigation(item.id);
    if (!read.ok) return false;
    const { investigation } = read.value;
    keepWorkspaceRecord(investigation.title, investigation.status, investigation.version);
    if (investigation.status === statusFilter) onChanged({ ...item, ...investigation });
    else onLeft({ ...item, ...investigation }, rowLeft(investigation.title, investigation.status));
    return true;
  };

  const move = async (target: InvestigationStatus): Promise<void> => {
    if (busyNow.current) return;
    busyNow.current = true;
    setBusy(true);
    onNotice(undefined);
    const result = await client.changeInvestigationStatus(item.id, target, item.version);
    busyNow.current = false;
    setBusy(false);
    if (!result.ok) {
      onNotice(result.failure);
      if (result.failure.code === 'CONFLICT') await refresh();
      return;
    }
    const { investigation } = result.value;
    keepWorkspaceRecord(investigation.title, investigation.status, investigation.version);
    const next = { ...item, title: investigation.title, status: investigation.status, version: investigation.version };
    if (investigation.status === statusFilter) onChanged(next);
    else onLeft(next, rowLeft(investigation.title, investigation.status));
  };

  const items: readonly ActionMenuItem[] = [
    { id: 'open', label: OPEN, disabled: false, run: (close) => (close(false), void navigate(`${EXPLORE_PATH}/${item.id}`)) },
    ...lifecycleActionsOf(item.status, busy).map((action) => ({
      ...action,
      run: (close: (restoreFocus: boolean) => void) => {
        if (action.id === 'rename') {
          close(false);
          setRenaming(true);
          return;
        }
        close(true);
        void move(TARGET_OF[action.id]);
      },
    })),
  ];

  return (
    <>
      <ActionMenu buttonRef={button} buttonLabel={ROW_MENU_BUTTON(item.title)} menuLabel={ROW_MENU_LABEL(item.title)} items={items} align="end" />
      {renaming ? (
        <RenameDialogView
          client={client}
          target={{ id: item.id, title: item.title, version: item.version, readOnly: isReadOnlyStatus(item.status) }}
          onRenamed={({ title, version }) => {
            keepWorkspaceRecord(title, item.status, version);
            onChanged({ ...item, title, version });
          }}
          refresh={refresh}
          onReadOnlyRefusal={() => void refresh()}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </>
  );
}
