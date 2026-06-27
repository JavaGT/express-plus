// public/files.mjs — the file-list page logic.
import { LiveChannel, LiveList } from './express-plus-client.mjs';

const token = localStorage.getItem('token');
if (!token) location.href = '/login.html'; // toy: a login page sets the token

const channel = new LiveChannel('/me/inbox', { token });

function row(doc) {
  const li = document.createElement('li');
  li.className = 'file' + (doc._shared || doc.sharedBy ? ' shared' : ' owned');
  li.innerHTML = `
    <a href="/editor.html#${doc.id}">${escapeHtml(doc.title || 'Untitled')}</a>
    <span class="meta">
      ${doc.sharedBy ? `shared by ${escapeHtml(doc.sharedBy.username)}` : 'owned'}
      · ${new Date(doc.updatedAt ?? doc.sharedAt).toLocaleString()}
    </span>`;
  return li;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

new LiveList({
  fetch: '/docs/feed',
  channel,
  render: (items) => {
    const list = document.getElementById('files');
    list.replaceChildren(...items.map(row));
  },
}).start();

// Example: sharing from the page. POSTs to the shares route; the server's
// Doc.onShare hook then emits 'share:added' back over the inbox channel, and
// the LiveList re-renders automatically.
window.shareDoc = async (docId, username) => {
  await fetch(`/docs/${docId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username }),
  });
};
