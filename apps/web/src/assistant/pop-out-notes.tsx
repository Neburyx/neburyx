import { Link, useInRouterContext } from 'react-router';
import { popOutAddress } from '../windows/pop-out.js';
import { ASSISTANT_COPY } from './copy.js';

/** The line under the header after a press of Pop out that opened nothing: the browser blocked the window (with a link that opens the chat in this window, so that the person chooses to leave the graph), or the window of the open page cannot be switched to. */
export function PopOutNote({ kind, investigationId }: { readonly kind: 'refused' | 'unreachable'; readonly investigationId: string | null }) {
  const router = useInRouterContext();
  return (
    <p className="ask-note assistant-popout-refused" role="status">
      {kind === 'refused' ? ASSISTANT_COPY.popOutRefused : ASSISTANT_COPY.popOutUnreachable}
      {kind === 'refused' && router && investigationId !== null ? (
        <>
          {' '}
          <Link to={popOutAddress(investigationId)}>{ASSISTANT_COPY.popOutOpenHere}</Link>
        </>
      ) : null}
    </p>
  );
}
