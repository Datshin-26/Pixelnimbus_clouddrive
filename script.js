(() => {
const $ = id => document.getElementById(id);
const REGIONS = ['us-east-1','eu-west-1','ap-south-1'];
const QUOTA = 500 * 1024 * 1024, MAX = 25 * 1024 * 1024;
let objects = [], shares = [], regionFilter = 'all', tagFilter = 'all', currentId = null;

/* ---------- IndexedDB (data plane + control plane) ---------- */
let db;
const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open('PixelNimbusDB', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('objects', {keyPath:'id'}); d.createObjectStore('shares', {keyPath:'token'}); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode), s = t.objectStore(store), q = fn(s);
  t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error);
});

/* ---------- helpers ---------- */
const fmt = b => b >= 1048576 ? (b/1048576).toFixed(1)+' MB' : (b/1024).toFixed(1)+' KB';
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c=='x'?r:(r&3|8)).toString(16); });
const sha256 = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2,'0')).join('');
const sha256Text = s => sha256(new TextEncoder().encode(s));
const toast = m => { const t = $('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); };
const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const urlOf = o => o._url || (o._url = URL.createObjectURL(o.blob));
const open = id => $(id).classList.remove('hidden');
const close = id => $(id).classList.add('hidden');

/* ---------- render ---------- */
function render() {
  const used = objects.reduce((a,o) => a + o.size, 0);
  $('usedMB').textContent = (used/1048576).toFixed(1);
  $('quotaBar').style.width = Math.min(100, used/QUOTA*100) + '%';
  $('objCount').textContent = objects.length;
  $('shareCount').textContent = shares.filter(s => !s.expires || s.expires > Date.now()).length;

  const tags = [...new Set(objects.flatMap(o => o.tags))];
  const tf = $('tagFilter'); tf.innerHTML = '<option value="all">All Tags</option>' + tags.map(t => `<option>${esc(t)}</option>`).join('');
  tf.value = tags.includes(tagFilter) ? tagFilter : (tagFilter = 'all');

  const list = objects.filter(o => (regionFilter === 'all' || o.region === regionFilter) && (tagFilter === 'all' || o.tags.includes(tagFilter)));
  $('gallery').innerHTML = list.map(o => `<div class="obj" data-id="${o.id}"><img src="${urlOf(o)}" alt="${esc(o.name)}"><div class="info"><h4>${esc(o.name)}</h4><small>${fmt(o.size)} • ${o.region}</small><div style="margin-top:6px"><span class="badge">${o.storageClass}</span></div></div></div>`).join('');
  $('emptyState').classList.toggle('hidden', objects.length > 0);
}

/* ---------- upload ---------- */
async function ingest(files) {
  for (const f of files) {
    const item = document.createElement('div'); item.className = 'q-item';
    item.innerHTML = `<b>${esc(f.name)}</b> <span class="st">Validating…</span><div class="prog"><div></div></div>`;
    $('queue').prepend(item);
    const st = item.querySelector('.st'), pr = item.querySelector('.prog div');
    const step = (t, p) => { st.textContent = t; pr.style.width = p + '%'; return new Promise(r => setTimeout(r, 350)); };
    if (!f.type.startsWith('image/')) { st.textContent = '✕ Not an image'; continue; }
    if (f.size > MAX) { st.textContent = '✕ Exceeds 25 MB limit'; continue; }
    if (objects.reduce((a,o)=>a+o.size,0) + f.size > QUOTA) { st.textContent = '✕ Storage quota exceeded'; continue; }
    await step('Computing SHA-256…', 30);
    const hash = await sha256(await f.arrayBuffer());
    const region = $('regionSel').value;
    await step('Encrypting & multi-part upload…', 60);
    await step('Replicating to ' + REGIONS.filter(r => r !== region).join(', ') + '…', 85);
    const obj = { id: uuid(), name: f.name, size: f.size, mime: f.type, region, storageClass: $('classSel').value,
      tags: $('tagsInput').value.split(',').map(t => t.trim()).filter(Boolean), hash, created: Date.now(), blob: f, replicas: REGIONS };
    await tx('objects','readwrite', s => s.put(obj));
    objects.unshift(obj);
    await step('✓ Stored & verified', 100); render();
  }
}

/* ---------- detail ---------- */
function showDetail(id) {
  const o = objects.find(x => x.id === id); if (!o) return; currentId = id;
  $('dImg').src = urlOf(o); $('dTitle').textContent = o.name; $('dClass').textContent = o.storageClass;
  $('dDate').textContent = 'Uploaded ' + new Date(o.created).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  $('dId').textContent = o.id; $('dSize').textContent = fmt(o.size); $('dMime').textContent = o.mime;
  $('dRegion').textContent = o.region; $('dHash').textContent = o.hash;
  $('dZones').innerHTML = o.replicas.map(r => `<span class="chip ${r===o.region?'active':''}">${r}${r===o.region?' (primary)':' (replica)'}</span>`).join('');
  $('dTags').innerHTML = o.tags.length ? o.tags.map(t => `<span class="chip">#${esc(t)}</span>`).join('') : '<small>No tags</small>';
  open('detailModal');
}
function download(o) { const a = document.createElement('a'); a.href = urlOf(o); a.download = o.name; a.click(); }

/* ---------- share ---------- */
function openShare() {
  const o = objects.find(x => x.id === currentId); if (!o) return;
  $('shareThumb').src = urlOf(o); $('shareName').textContent = o.name; $('shareMeta').textContent = fmt(o.size) + ' • ' + o.region;
  $('linkResult').classList.add('hidden'); $('passInput').value = '';
  close('detailModal'); open('shareModal');
}
async function genLink() {
  const o = objects.find(x => x.id === currentId); if (!o) return;
  const exp = +$('expSel').value, pass = $('passInput').value.trim();
  const s = { token: uuid().replace(/-/g,''), objectId: o.id, expires: exp ? Date.now() + exp : 0,
    passHash: pass ? await sha256Text(pass) : '', allowDl: $('allowDl').checked };
  await tx('shares','readwrite', st => st.put(s)); shares.push(s);
  const link = location.href.split('#')[0] + '#share=' + s.token;
  $('linkOut').value = link; $('linkResult').classList.remove('hidden');
  $('qrBox').innerHTML = '';
  if (window.QRCode) new QRCode($('qrBox'), {text: link, width: 140, height: 140});
  else $('qrBox').textContent = 'QR unavailable offline';
  render();
}

/* ---------- shared view ---------- */
async function checkHash() {
  const m = location.hash.match(/share=([a-f0-9]+)/); if (!m) return;
  const s = shares.find(x => x.token === m[1]);
  ['lockBox','sharedBody'].forEach(i => $(i).classList.add('hidden')); $('sMsg').textContent = '';
  open('sharedModal');
  if (!s) { $('sMsg').textContent = 'This link is invalid or was created in a different browser.'; return; }
  if (s.expires && s.expires < Date.now()) { $('sMsg').textContent = 'This presigned link has expired.'; return; }
  const o = objects.find(x => x.id === s.objectId);
  if (!o) { $('sMsg').textContent = 'The shared object no longer exists.'; return; }
  const reveal = () => {
    $('lockBox').classList.add('hidden'); $('sharedBody').classList.remove('hidden');
    $('sImg').src = urlOf(o); $('sName').textContent = o.name; $('sSize').textContent = 'Size: ' + fmt(o.size);
    const d = $('sDownload'); d.classList.toggle('hidden', !s.allowDl); d.href = urlOf(o); d.download = o.name;
  };
  if (s.passHash) {
    $('lockBox').classList.remove('hidden'); $('unlockPass').value = ''; $('unlockErr').textContent = '';
    $('unlockBtn').onclick = async () => (await sha256Text($('unlockPass').value)) === s.passHash ? reveal() : ($('unlockErr').textContent = 'Incorrect passcode.');
  } else reveal();
}

/* ---------- events ---------- */
function bind() {
  const toggle = () => $('uploadPanel').classList.toggle('hidden');
  $('toggleUpload').onclick = toggle; $('closeUpload').onclick = () => close('uploadPanel');
  $('emptyUpload').onclick = () => { open('uploadPanel'); scrollTo({top:0,behavior:'smooth'}); };
  $('openArch').onclick = () => open('archModal');
  const dz = $('dropzone');
  dz.onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { ingest([...e.target.files]); e.target.value = ''; };
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => ingest([...e.dataTransfer.files]));
  $('regionChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return;
    regionFilter = b.dataset.region; document.querySelectorAll('#regionChips .chip').forEach(c => c.classList.toggle('active', c === b)); render(); };
  $('tagFilter').onchange = e => { tagFilter = e.target.value; render(); };
  $('gallery').onclick = e => { const c = e.target.closest('.obj'); if (c) showDetail(c.dataset.id); };
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m || e.target.classList.contains('close')) { m.classList.add('hidden'); if (m.id === 'sharedModal') history.replaceState(null,'',location.pathname); } });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); });
  $('dShare').onclick = openShare; $('genLink').onclick = genLink;
  $('copyBtn').onclick = () => { navigator.clipboard.writeText($('linkOut').value).then(() => toast('Link copied'), () => { $('linkOut').select(); toast('Press Ctrl+C to copy'); }); };
  $('dDownload').onclick = () => { const o = objects.find(x => x.id === currentId); if (o) download(o); };
  $('dDelete').onclick = async () => {
    if (!confirm('Delete this cloud object permanently?')) return;
    await tx('objects','readwrite', s => s.delete(currentId));
    for (const s of shares.filter(x => x.objectId === currentId)) await tx('shares','readwrite', st => st.delete(s.token));
    shares = shares.filter(x => x.objectId !== currentId); objects = objects.filter(x => x.id !== currentId);
    close('detailModal'); render(); toast('Object deleted');
  };
  window.addEventListener('hashchange', checkHash);
}

(async function init() {
  bind();
  try {
    db = await openDB();
    objects = (await tx('objects','readonly', s => s.getAll())).sort((a,b) => b.created - a.created);
    shares = await tx('shares','readonly', s => s.getAll());
  } catch (e) { toast('Storage unavailable: data will not persist'); }
  render(); checkHash();
})();
})();
