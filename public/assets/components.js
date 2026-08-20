export function text(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value == null ? '' : String(value);
  if (className) node.className = className;
  return node;
}

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.href) node.href = options.href;
  if (options.name) node.name = options.name;
  if (options.value !== undefined) node.value = String(options.value);
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.title) node.title = options.title;
  if (options.disabled) node.disabled = true;
  if (options.checked) node.checked = true;
  if (options.required) node.required = true;
  for (const [name, value] of Object.entries(options.attrs || {})) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  const values = Array.isArray(children) ? children : [children];
  for (const child of values.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function queryHash(params) {
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  return new URLSearchParams(clean).toString();
}

export function pill(value, tone = 'neutral') {
  return el('span', { className: `pill ${tone}`, text: value });
}

export function button(label, tone = 'secondary', options = {}) {
  return el('button', {
    className: `button ${tone}`,
    text: label,
    type: options.type || 'button',
    disabled: options.disabled,
    attrs: options.attrs,
  });
}

export function emptyState(title, body, action) {
  return el('div', { className: 'empty-state' }, [
    el('span', { className: 'empty-icon', text: '◇', attrs: { 'aria-hidden': 'true' } }),
    text('h3', title),
    text('p', body, 'muted'),
    action || null,
  ]);
}

export function skeleton(rows = 3) {
  const root = el('div', { className: 'skeleton-stack', attrs: { 'aria-label': '載入中' } });
  for (let index = 0; index < rows; index += 1) root.append(el('div', { className: 'skeleton-row' }));
  return root;
}
