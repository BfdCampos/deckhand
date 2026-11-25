const stack = [];
const attached = new WeakSet();

function onKeyDown(event) {
  if (event.key !== 'Escape' || event.isComposing) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.handler(event) === true) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
}

export function attachEscape(doc) {
  if (!doc || attached.has(doc)) return () => {};
  attached.add(doc);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    attached.delete(doc);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}

attachEscape(document);

export function pushEscape(handler) {
  const entry = { handler };
  stack.push(entry);
  return function pop() {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
  };
}
