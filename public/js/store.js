const state = { agents: null, run: null, deck: null, conn: 'connecting' };
const subscribers = new Set();

export const store = {
  get() { return state; },
  set(patch) {
    Object.assign(state, patch);
    for (const fn of subscribers) fn(state, patch);
  },
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
};
