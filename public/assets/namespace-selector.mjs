import { clear, text } from './components.js';

export async function mountNamespaceSelector(select, linkedClients) {
  const namespaces = [...new Set(linkedClients.map((client) => client.namespace))];
  clear(select);
  for (const namespace of namespaces) {
    const option = text('option', namespace);
    option.value = namespace;
    select.append(option);
  }
  const current = new URLSearchParams(location.search).get('namespace');
  if (current && namespaces.includes(current)) select.value = current;
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('namespace', select.value);
    location.assign(url);
  });
}
