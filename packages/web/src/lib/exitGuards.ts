import { onBeforeUnmount } from 'vue';

const guards = new Set<() => Promise<boolean>>();
export let exitApproved = false;
export function registerExitGuard(guard: () => Promise<boolean>) {
  guards.add(guard);
  onBeforeUnmount(() => guards.delete(guard));
}
export async function prepareExit() {
  for (const guard of guards) if (!(await guard())) return false;
  return true;
}
export function approveExit() { exitApproved = true; }
