/** Small same-origin UI primitives shared by the vanilla Control Center pages. */
export function text(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value == null ? '' : String(value);
  if (className) node.className = className;
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function queryHash(params) {
  return new URLSearchParams(params).toString();
}
