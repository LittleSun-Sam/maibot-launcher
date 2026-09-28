import { reactive } from 'vue';

export const toastState = reactive({ items: [] });

let seq = 0;

export function toast(message, type = 'info', duration = 2600) {
  const id = ++seq;
  toastState.items.push({ id, message: String(message), type });
  window.setTimeout(() => {
    const idx = toastState.items.findIndex((t) => t.id === id);
    if (idx > -1) toastState.items.splice(idx, 1);
  }, duration);
}
