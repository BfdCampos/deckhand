export function createHistory() {
  const undoStack = [];
  const redoStack = [];

  return {
    push(entry) {
      undoStack.push(entry);
      redoStack.length = 0;
    },
    takeUndo: () => undoStack.pop() || null,
    takeRedo: () => redoStack.pop() || null,
    putUndo: (entry) => undoStack.push(entry),
    putRedo: (entry) => redoStack.push(entry),
    remove(entry) {
      for (const stack of [undoStack, redoStack]) {
        const i = stack.indexOf(entry);
        if (i !== -1) stack.splice(i, 1);
      }
    },
    clear() {
      const had = undoStack.length + redoStack.length > 0;
      undoStack.length = 0;
      redoStack.length = 0;
      return had;
    },
    get size() { return undoStack.length; },
  };
}
