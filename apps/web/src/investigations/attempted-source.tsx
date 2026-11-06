import { useSourceName } from '../shell/use-current-source.js';
import { couldNotOpenIn } from './messages.js';

export function AttemptedSource({ sourceId }: { readonly sourceId: string }) {
  return <p>{couldNotOpenIn(useSourceName(sourceId))}</p>;
}
