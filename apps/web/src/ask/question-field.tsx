import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import type { BlockedToken } from './ask-model.js';
import { ASK_COPY } from './copy.js';

interface QuestionFieldProps {
  readonly text: string;
  readonly blocked: readonly BlockedToken[];
  readonly disabled: boolean;
  readonly focus: { readonly tick: number; readonly caret: number | undefined };
  readonly describedBy: string;
  readonly invalid: boolean;
  readonly onText: (text: string) => void;
  readonly onSubmit: () => void;
}

function segments(text: string, blocked: readonly BlockedToken[]): Array<{ readonly text: string; readonly marked: boolean }> {
  const out: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const token of [...blocked].sort((left, right) => left.start - right.start)) {
    if (token.start < at || token.end > text.length) continue;
    if (token.start > at) out.push({ text: text.slice(at, token.start), marked: false });
    out.push({ text: text.slice(token.start, token.end), marked: true });
    at = token.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out;
}

/** The question: a plain text field with a copy of its text drawn behind it, where each blocked word is underlined in red. Enter only asks for a preview. */
export function QuestionField({ text, blocked, disabled, focus, describedBy, invalid, onText, onSubmit }: QuestionFieldProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus.tick === 0 || field.current === null) return;
    field.current.focus();
    const caret = focus.caret ?? field.current.value.length;
    field.current.setSelectionRange(caret, caret);
  }, [focus]);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };
  return (
    <div className="ask-field">
      <div className="ask-mirror" aria-hidden="true" ref={mirror}>
        {segments(text, blocked).map((part, index) => (part.marked ? <mark key={index} className="ask-blocked">{part.text}</mark> : <span key={index}>{part.text}</span>))}
        {'\n'}
      </div>
      <textarea
        ref={field}
        className="ask-input"
        rows={3}
        value={text}
        disabled={disabled}
        placeholder={ASK_COPY.placeholder}
        aria-label={ASK_COPY.fieldLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onText(event.target.value)}
        onKeyDown={keyDown}
        onScroll={(event) => {
          if (mirror.current !== null) mirror.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
