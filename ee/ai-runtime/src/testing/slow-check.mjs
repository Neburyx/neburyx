export function slow(input) {
  const until = Date.now() + input.ms;
  while (Date.now() < until);
  return { echoed: input.ms };
}

export function fails() {
  throw new Error('the check failed');
}

export function never() {
  for (;;);
}
