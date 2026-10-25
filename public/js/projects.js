import { mountChrome, h, toast, confirmDialog, $ } from './ui.js';
import { icons } from './icons.js';
import { listProjects, deleteProject, deleteAllProjects } from './store.js';

mountChrome('/projects');
const urls = [];

async function render() {
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  let items = [];
  try { items = await listProjects(); } catch { toast('Browser storage is unavailable here, so Projects cannot be shown.', { type: 'error' }); }
  const list = $('#list');
  list.replaceChildren();
  $('#empty').hidden = items.length > 0;
  $('#bulk').hidden = items.length === 0;
  for (const it of items) {
    const url = URL.createObjectURL(it.blob);
    urls.push(url);
    const date = new Date(it.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const dl = h('a', { class: 'btn btn-sm', href: url, download: `careerstudio-${it.id}.jpg`, html: `${icons.download}<span>Download</span>` });
    const del = h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger', 'aria-label': `Delete photo saved ${date}`, html: icons.trash });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete this photo?', 'It will be removed from this device. This cannot be undone.', 'Delete', { danger: true }))) return;
      await deleteProject(it.id);
      toast('Photo deleted.');
      render();
    });
    list.append(h('article', { class: 'project' },
      h('img', { src: url, alt: `Saved photo, ${date}` }),
      h('div', { class: 'meta' }, `${date} · ${it.width}×${it.height}`),
      h('div', { class: 'row' }, dl, del)));
  }
}

$('#delete-all').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete all saved photos?', 'Every photo in Projects will be removed from this device. This cannot be undone.', 'Delete all', { danger: true }))) return;
  await deleteAllProjects();
  toast('All saved photos deleted.');
  render();
});

render();
