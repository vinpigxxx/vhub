const $ = (s) => document.querySelector(s);
let me = null;
let categories = [];

async function api(url, options={}) {
  const r = await fetch(url, { credentials:'include', ...options });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(v='') {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function poster(url) {
  return url ? `<img src="${escapeHtml(url)}" alt="">` : '<div></div>';
}

async function loadCategories() {
  categories = await api('/api/categories');
  $('#categoryChips').innerHTML = categories.map(c => `<button class="chip" data-category="${c.slug}">${escapeHtml(c.name)}</button>`).join('');
  $('#uploadCategory').innerHTML = '<option value="">No category</option>' + categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  document.querySelectorAll('[data-category]').forEach(b => b.onclick = () => loadVideos(b.dataset.category));
}

async function loadVideos(category='') {
  const qs = category ? '?category='+encodeURIComponent(category) : '';
  const videos = await api('/api/videos'+qs);
  $('#resultCount').textContent = `${videos.length} videos`;
  $('#videoGrid').innerHTML = videos.map(v => `
    <article class="poster-card" onclick="location.hash='watch/${encodeURIComponent(v.slug)}'">
      <div class="poster">${poster(v.poster_url)}</div>
      <div class="poster-info"><h3>${escapeHtml(v.title)}</h3><div class="meta">${Number(v.view_count).toLocaleString()} views · ${escapeHtml(v.category || 'Uncategorized')}</div></div>
    </article>`).join('');
  const hot = videos.slice(0,5);
  $('#heroStrip').innerHTML = hot.map(v => `
    <article class="hero-card" onclick="location.hash='watch/${encodeURIComponent(v.slug)}'">
      ${poster(v.poster_url)}<div class="overlay"><strong>${escapeHtml(v.title)}</strong><div class="meta">${Number(v.view_count).toLocaleString()} views</div></div>
    </article>`).join('');
}

async function renderWatch(slug) {
  const v = await api('/api/videos/'+encodeURIComponent(slug));
  $('#hero').classList.add('hidden');
  $('#categories').classList.add('hidden');
  $('#browse').classList.add('hidden');
  $('#watch').classList.remove('hidden');
  $('#watchContent').innerHTML = `
    <div class="watch-layout">
      <div><div class="player"><video controls poster="${escapeHtml(v.poster_url || '')}" src="${escapeHtml(v.stream_url || '')}"></video></div></div>
      <div class="watch-copy"><h1>${escapeHtml(v.title)}</h1><div class="meta">${Number(v.view_count).toLocaleString()} views · ${escapeHtml(v.creator || 'VHub')}</div><p>${escapeHtml(v.description || '')}</p><p class="meta">Category: ${escapeHtml(v.category || 'Uncategorized')}</p></div>
    </div>`;
  await api('/api/videos/'+v.id+'/view', {method:'POST'}).catch(()=>{});
}

function showHome() {
  ['hero','categories','browse'].forEach(id => $('#'+id).classList.remove('hidden'));
  ['watch','upload','my-videos','admin'].forEach(id => $('#'+id).classList.add('hidden'));
}

async function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('watch/')) return renderWatch(decodeURIComponent(hash.slice(6)));
  showHome();
  if (hash === 'upload') {
    if (!me) return openAuth();
    $('#upload').classList.remove('hidden');
  }
  if (hash === 'my-videos') { if (!me) return openAuth(); $('#my-videos').classList.remove('hidden'); await loadMyVideos(); }
  if (hash === 'admin') {
    if (!me || me.role !== 'admin') return openAuth();
    $('#admin').classList.remove('hidden');
    await loadAdmin();
  }
}

function openAuth() { $('#authModal').classList.remove('hidden'); }
function closeAuth() { $('#authModal').classList.add('hidden'); }
window.closeAuth = closeAuth;

function refreshAccount() {
  $('#account').innerHTML = me
    ? `<span>${escapeHtml(me.display_name)}</span> <button onclick="logout()">Logout</button>`
    : '<button onclick="openAuth()">Login</button>';
  document.querySelectorAll('[data-auth-only]').forEach(a => a.style.display = me ? '' : 'none');
  document.querySelectorAll('[data-admin-only]').forEach(a => a.style.display = me?.role === 'admin' ? '' : 'none');
}
window.openAuth = openAuth;

async function logout() { await api('/api/auth/logout',{method:'POST'}); me=null; refreshAccount(); route(); }

document.querySelectorAll('[data-tab]').forEach(btn => btn.onclick = () => {
  const register = btn.dataset.tab === 'register';
  $('#loginForm').classList.toggle('hidden', register);
  $('#registerForm').classList.toggle('hidden', !register);
});

$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#authStatus').textContent='';
  try { me=(await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))})).user; closeAuth(); refreshAccount(); route(); }
  catch(err){ $('#authStatus').textContent=err.message; }
};

$('#registerForm').onsubmit = async e => {
  e.preventDefault(); $('#authStatus').textContent='';
  try { me=(await api('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))})).user; closeAuth(); refreshAccount(); route(); }
  catch(err){ $('#authStatus').textContent=err.message; }
};

$('#uploadForm').onsubmit = async e => {
  e.preventDefault();
  const status=$('#uploadStatus'); status.textContent='Uploading…';
  try {
    const data=await api('/api/videos',{method:'POST',body:new FormData(e.target)});
    status.textContent=`Accepted: ${data.message}`;
    e.target.reset();
  } catch(err){ status.textContent=err.message; }
};

$('#categoryForm').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:new FormData(e.target).get('name')})}); e.target.reset(); await loadCategories(); }
  catch(err){ alert(err.message); }
};

async function loadMyVideos() {
  const videos = await api('/api/my/videos');
  $('#myVideoCount').textContent = videos.length + ' uploads';
  $('#myVideoGrid').innerHTML = videos.length ? videos.map(v => `
    <article class="poster-card">
      <div class="poster"><div class="video-placeholder">\${escapeHtml(v.status)}</div></div>
      <div class="poster-info"><h3>\${escapeHtml(v.title)}</h3><div class="meta">\${Number(v.view_count).toLocaleString()} views · \${escapeHtml(v.category || 'Uncategorized')}</div><div class="status">Status: \${escapeHtml(v.status)}</div></div>
    </article>`).join('') : '<div class="panel"><p>No uploads yet.</p><a class="primary" href="#upload">Upload your first video</a></div>';
}

async function loadAdmin() {
  const [stats, videos] = await Promise.all([api('/api/admin/stats'), api('/api/admin/videos')]);
  $('#adminStats').textContent=`${stats.users} users · ${stats.videos} videos · ${stats.views} views`;
  $('#adminList').innerHTML=videos.map(v=>`
    <div class="admin-row">
      ${poster(v.poster_url)}
      <div><strong>${escapeHtml(v.title)}</strong><div class="meta">${escapeHtml(v.creator||'')} · ${escapeHtml(v.status)}</div></div>
      <select onchange="setVideoStatus('${v.id}',this.value)">
        ${['processing','published','rejected'].map(s=>`<option ${s===v.status?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>`).join('');
}
window.setVideoStatus = async (id,status) => { await api('/api/admin/videos/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); loadAdmin(); };

$('#browseBtn').onclick=()=>document.querySelector('#browse').scrollIntoView({behavior:'smooth'});
window.addEventListener('hashchange', route);

(async function init(){
  try { me=(await api('/api/me')).user; } catch {}
  refreshAccount();
  await loadCategories();
  await loadVideos();
  await route();
})();