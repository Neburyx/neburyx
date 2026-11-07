import { useNavigate } from 'react-router';
import { demoCaseLabel, demoCasePath, type DemoCaseEntry } from './demo-case.js';

/** Opens the demo case by going to the address of its deep link, so it takes the path every entity opens by. */
export function OpenDemoCase({ entry, label, offered, className }: { readonly entry: DemoCaseEntry; readonly label: string; readonly offered: number; readonly className: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className={className} onClick={() => void navigate(demoCasePath(entry))}>
      {demoCaseLabel(label, entry, offered)}
    </button>
  );
}
