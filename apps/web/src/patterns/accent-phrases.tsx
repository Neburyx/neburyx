import type { ReactNode } from 'react';

export function accentPhrases(text: string, phrases: readonly string[]): ReactNode {
  const found = phrases.filter((phrase) => phrase !== '' && text.includes(phrase));
  if (found.length === 0) return text;
  const pattern = new RegExp(`(${found.map((phrase) => phrase.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return text.split(pattern).map((part, index) => (found.includes(part) ? <span className="pattern-words-tag" key={index}>{part}</span> : part));
}
