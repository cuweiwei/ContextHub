import { clear, text } from './components.js';

export function selectedNamespace(linkedClients) {
  const namespaces = [...new Set(linkedClients.map((client) => client.namespace))];
  const requested = new URLSearchParams(location.search).get('namespace');
  return requested && namespaces.includes(requested) ? requested : (namespaces[0] || '');
}

export function mountNamespaceSelector(select, linkedClients) {
  const namespaces = [...new Set(linkedClients.map((client) => client.namespace))];
  const selected = selectedNamespace(linkedClients);
  clear(select);
  for (const namespace of namespaces) {
    const label = namespace === 'personal' ? '個人 · personal' : namespace === 'work' ? '工作 · work' : namespace;
    const option = text('option', label);
    option.value = namespace;
    option.selected = namespace === selected;
    select.append(option);
  }
  select.disabled = namespaces.length < 2;
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('namespace', select.value);
    location.assign(url);
  });
  return selected;
}
