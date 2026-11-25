import { useEffect } from 'react';
import { useAnnounceWindow } from './use-window-channel.js';
import { popOutName } from './pop-out.js';
import { useWindowScope } from './use-window-channel.js';

/** While the Assistant page is shown: tells the other windows of the investigation that a page of it is open, and gives this window the name by which Pop out finds it (unless the window has a name already, which it keeps). */
export function useAssistantPageWindow(): void {
  useAnnounceWindow('assistant');
  const investigationId = useWindowScope()?.investigationId;
  useEffect(() => {
    if (investigationId === undefined || window.name !== '') return undefined;
    const name = popOutName(investigationId);
    window.name = name;
    return () => {
      if (window.name === name) window.name = '';
    };
  }, [investigationId]);
}
