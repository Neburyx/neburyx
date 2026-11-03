const GROUP_POLL_MS = 50;
const AFTER_KILL_WAIT_MS = 2000;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return true;
}

export async function terminateGroup(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  if (await waitUntilGone(pid, graceMs)) return;
  signalGroup(pid, 'SIGKILL');
  await waitUntilGone(pid, AFTER_KILL_WAIT_MS);
}
