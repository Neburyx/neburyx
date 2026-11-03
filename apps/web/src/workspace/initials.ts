export function initialsOf(displayName: string): string {
  const words = displayName.split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  const last = words.at(-1);
  if (first === undefined || last === undefined) return '';
  const letters = words.length === 1 ? [...first].slice(0, 1) : [...first].slice(0, 1).concat([...last].slice(0, 1));
  return letters.join('').toUpperCase();
}
