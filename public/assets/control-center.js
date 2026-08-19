import { mountNamespaceSelector } from './namespace-selector.mjs';

// The server-delivered page keeps the same module entrypoint for local and
// container deployments. Credentials remain in HttpOnly cookies; this module
// only reads the URL namespace and renders server responses with textContent.
const select = document.querySelector('#namespace-selector');
if (select) {
  fetch('/v1/control/me', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => response.json())
    .then((me) => mountNamespaceSelector(select, me.linked_clients || []))
    .catch(() => select.replaceChildren());
}
