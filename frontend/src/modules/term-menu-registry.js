// Addon-contributed entries of the Term menu (⌘M). Kept apart from
// term-menu.js so addon-host.js can register without importing the menu.

const items = new Map(); // "addonId:id" -> { addonId, id, label, hint, run }

export function registerTermMenuItem(addonId, desc) {
  if (!desc || typeof desc.run !== 'function' || !desc.label) {
    throw new Error('registerTermMenuItem needs {id, label, run(ctx)}');
  }
  const key = `${addonId}:${desc.id || desc.label}`;
  items.set(key, { addonId, id: desc.id || desc.label, label: desc.label, hint: desc.hint || '', run: desc.run });
  return () => {
    if (items.get(key)?.run === desc.run) items.delete(key);
  };
}

export function removeAddonTermMenuItems(addonId) {
  for (const [key, item] of items) {
    if (item.addonId === addonId) items.delete(key);
  }
}

export function listTermMenuItems() {
  return [...items.values()];
}
