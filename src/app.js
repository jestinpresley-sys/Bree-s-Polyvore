import { aiRemoveBackground, hasEmbeddedModel } from './ai-cutout.js';


  const state = {
    view: 'make',
    board: null,
    clippings: [],
    selectedId: null,
    boardsCache: null,
    dirty: false,
    zCounter: 0,
  };
  const itemEls = new Map();

  function uid(prefix){
    if (window.crypto && crypto.randomUUID) return prefix + '_' + crypto.randomUUID();
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
  }

  function freshBoard(){
    return { id: uid('board'), name: '', items: [], updatedAt: Date.now() };
  }

  // ---------------- storage ----------------
  // Cloud sync (Supabase) keeps boards available across devices; localStorage
  // is always kept as an offline-first cache so the app still works with no
  // connection (and works at all when no Supabase project is configured).
  const STORAGE_KEY = 'cuttingTable.boards';
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const BOARD_ROW_ID = 'bree';
  const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  function readLocalBoards(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    }catch(err){
      return [];
    }
  }
  function writeLocalBoards(list){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); return true; }
    catch(err){ return false; }
  }

  async function loadBoards(){
    if(cloudEnabled){
      try{
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/boards?id=eq.${BOARD_ROW_ID}&select=data`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        if(res.ok){
          const rows = await res.json();
          const cloudList = rows[0] && Array.isArray(rows[0].data) ? rows[0].data : null;
          if(cloudList){ writeLocalBoards(cloudList); return cloudList; }
        }
      }catch(err){ /* offline or unreachable — fall back to local cache */ }
    }
    return readLocalBoards();
  }

  async function saveBoards(list){
    const localOk = writeLocalBoards(list);
    if(!cloudEnabled) return localOk;
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/boards?on_conflict=id`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ id: BOARD_ROW_ID, data: list, updated_at: new Date().toISOString() }),
      });
      return res.ok || localOk;
    }catch(err){
      return localOk;
    }
  }

  // ---------------- image handling ----------------
  function loadAndCompress(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onerror = ()=> reject(new Error('read failed'));
      reader.onload = (e)=>{
        const img = new Image();
        img.onerror = ()=> reject(new Error('decode failed'));
        img.onload = ()=>{
          const maxDim = 480;
          let w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, maxDim / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          let dataUrl;
          try{ dataUrl = canvas.toDataURL('image/jpeg', 0.72); }
          catch(err){ reject(err); return; }
          resolve({ src: dataUrl, w, h });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------- background clipping ----------------
  function loadImageElement(src){
    return new Promise((resolve, reject)=>{
      const img = new Image();
      img.onload = ()=> resolve(img);
      img.onerror = ()=> reject(new Error('decode failed'));
      img.src = src;
    });
  }

  async function getImageData(src){
    const img = await loadImageElement(src);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function imageDataToDataUrl(imageData){
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width; canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Flood-fills background color inward from the image border, so a
  // contiguous plain background gets clipped without touching unrelated
  // areas of similar color inside the subject. No ML model involved \u2014
  // this is a pure color-distance technique, so busy or textured
  // backgrounds won't clip cleanly.
  function computeCutout(imageData, sensitivity){
    const w = imageData.width, h = imageData.height;
    const data = imageData.data;
    const out = new Uint8ClampedArray(data);
    const n = w * h;
    const visited = new Uint8Array(n);

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    function addBorder(y, x){
      const idx = (y * w + x) * 4;
      rSum += data[idx]; gSum += data[idx+1]; bSum += data[idx+2]; count++;
    }
    for(let x = 0; x < w; x++){ addBorder(0, x); addBorder(h - 1, x); }
    for(let y = 0; y < h; y++){ addBorder(y, 0); addBorder(y, w - 1); }
    const bgR = rSum / count, bgG = gSum / count, bgB = bSum / count;

    const threshold = 15 + (sensitivity / 100) * 110;
    const queue = new Int32Array(n);
    let qTail = 0;

    function tryMark(y, x){
      if(x < 0 || x >= w || y < 0 || y >= h) return;
      const p = y * w + x;
      if(visited[p]) return;
      visited[p] = 1;
      const idx = p * 4;
      const dr = data[idx] - bgR, dg = data[idx+1] - bgG, db = data[idx+2] - bgB;
      const dist = Math.sqrt(dr*dr + dg*dg + db*db);
      if(dist <= threshold){
        out[idx + 3] = 0;
        queue[qTail++] = p;
      }
    }
    for(let x = 0; x < w; x++){ tryMark(0, x); tryMark(h - 1, x); }
    for(let y = 0; y < h; y++){ tryMark(y, 0); tryMark(y, w - 1); }

    let qHead = 0;
    while(qHead < qTail){
      const p = queue[qHead++];
      const y = (p / w) | 0, x = p % w;
      tryMark(y - 1, x); tryMark(y + 1, x); tryMark(y, x - 1); tryMark(y, x + 1);
    }

    // Soften the hard cutout edge with a small blur on the alpha channel only.
    const alpha = new Uint8ClampedArray(n);
    for(let i = 0; i < n; i++) alpha[i] = out[i * 4 + 3];
    const blurred = boxBlurAlpha(alpha, w, h, 1);
    for(let i = 0; i < n; i++) out[i * 4 + 3] = blurred[i];

    return new ImageData(out, w, h);
  }

  function boxBlurAlpha(alpha, w, h, radius){
    const tmp = new Float32Array(w * h);
    const res = new Uint8ClampedArray(w * h);
    for(let y = 0; y < h; y++){
      for(let x = 0; x < w; x++){
        let sum = 0, cnt = 0;
        for(let dx = -radius; dx <= radius; dx++){
          const xx = x + dx;
          if(xx >= 0 && xx < w){ sum += alpha[y * w + xx]; cnt++; }
        }
        tmp[y * w + x] = sum / cnt;
      }
    }
    for(let x = 0; x < w; x++){
      for(let y = 0; y < h; y++){
        let sum = 0, cnt = 0;
        for(let dy = -radius; dy <= radius; dy++){
          const yy = y + dy;
          if(yy >= 0 && yy < h){ sum += tmp[yy * w + x]; cnt++; }
        }
        res[y * w + x] = Math.round(sum / cnt);
      }
    }
    return res;
  }

  function debounce(fn, wait){
    let t;
    return function(...args){
      clearTimeout(t);
      t = setTimeout(()=> fn.apply(this, args), wait);
    };
  }

  let cutoutState = null; // { mode, src, onApply, currentDataUrl, originalImageData }

  async function openCutoutModal(src, onApply){
    const modal = document.getElementById('cutoutModal');
    const previewImg = document.getElementById('cutoutPreview');
    const applyBtn = document.getElementById('cutoutApplyBtn');
    modal.hidden = false;
    applyBtn.disabled = true;
    previewImg.src = src;
    cutoutState = { mode: null, src, onApply, currentDataUrl: null, originalImageData: null };
    setCutoutMode('ai');
  }

  function setCutoutMode(mode){
    if(!cutoutState) return;
    cutoutState.mode = mode;
    document.getElementById('cutoutModeAi').classList.toggle('active', mode === 'ai');
    document.getElementById('cutoutModeQuick').classList.toggle('active', mode === 'quick');
    document.getElementById('cutoutSliderRow').style.display = mode === 'quick' ? 'flex' : 'none';
    document.getElementById('cutoutHint').textContent = mode === 'ai'
      ? (hasEmbeddedModel
          ? 'Uses the built-in AI model \u2014 fully offline, handles busier backgrounds too. First run in a session may take a few extra seconds.'
          : 'Uses an AI model \u2014 this build has no embedded model, so it needs internet right now (fine for local testing with "npm run dev").')
      : 'Instant, color-based clip. Works best on plain, solid-color backgrounds.';
    if(mode === 'ai') runAiCutout();
    else runQuickCutout();
  }

  async function runAiCutout(){
    if(!cutoutState) return;
    const applyBtn = document.getElementById('cutoutApplyBtn');
    const loading = document.getElementById('cutoutLoading');
    applyBtn.disabled = true;
    loading.hidden = false;
    loading.textContent = 'Removing background\u2026';
    try{
      const dataUrl = await aiRemoveBackground(cutoutState.src, ({ current, total })=>{
        if(total) loading.textContent = 'Loading model\u2026 ' + Math.round((current / total) * 100) + '%';
      });
      if(!cutoutState || cutoutState.mode !== 'ai') return; // modal closed or mode switched mid-flight
      cutoutState.currentDataUrl = dataUrl;
      document.getElementById('cutoutPreview').src = dataUrl;
      applyBtn.disabled = false;
      loading.hidden = true;
    }catch(err){
      console.error(err);
      showToast('AI cutout unavailable \u2014 switched to quick cutout.');
      setCutoutMode('quick');
    }
  }

  async function runQuickCutout(){
    if(!cutoutState) return;
    const applyBtn = document.getElementById('cutoutApplyBtn');
    const loading = document.getElementById('cutoutLoading');
    applyBtn.disabled = true;
    loading.hidden = false;
    try{
      if(!cutoutState.originalImageData){
        cutoutState.originalImageData = await getImageData(cutoutState.src);
      }
      document.getElementById('cutoutSlider').value = 35;
      updateQuickPreview();
      applyBtn.disabled = false;
    }catch(err){
      showToast("Couldn't process that image.");
      closeCutoutModal();
    }
    loading.hidden = true;
  }

  function updateQuickPreview(){
    if(!cutoutState || cutoutState.mode !== 'quick' || !cutoutState.originalImageData) return;
    const slider = document.getElementById('cutoutSlider');
    const sensitivity = Number(slider.value);
    const src = cutoutState.originalImageData;
    const clone = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    const result = computeCutout(clone, sensitivity);
    const dataUrl = imageDataToDataUrl(result);
    cutoutState.currentDataUrl = dataUrl;
    document.getElementById('cutoutPreview').src = dataUrl;
  }
  const debouncedUpdateQuickPreview = debounce(updateQuickPreview, 80);

  function closeCutoutModal(){
    document.getElementById('cutoutModal').hidden = true;
    cutoutState = null;
  }

  function isCutoutModalOpen(){
    const modal = document.getElementById('cutoutModal');
    return modal && !modal.hidden;
  }

  // ---------------- toast ----------------
  let toastTimer = null;
  function showToast(msg){
    const toastEl = document.getElementById('toast');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(()=> toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{
      toastEl.classList.remove('show');
      setTimeout(()=>{ toastEl.hidden = true; }, 300);
    }, 2700);
  }

  function formatDate(ts){
    try{ return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
    catch(e){ return ''; }
  }

  // ---------------- canvas rendering ----------------
  function applyItemTransform(el, item){
    el.style.left = (item.x * 100) + '%';
    el.style.top = (item.y * 100) + '%';
    el.style.width = (item.w * 100) + '%';
    el.style.height = (item.h * 100) + '%';
    el.style.transform = 'rotate(' + item.rot + 'deg)';
    el.style.zIndex = item.z;
  }

  function updateEmptyHint(){
    const hint = document.getElementById('canvasEmptyHint');
    if(hint) hint.style.display = state.board.items.length ? 'none' : 'flex';
  }

  function selectItem(id){
    state.selectedId = id;
    itemEls.forEach((el, itemId)=> el.classList.toggle('selected', itemId === id));
  }
  function deselectAll(){
    state.selectedId = null;
    itemEls.forEach(el => el.classList.remove('selected'));
  }

  function removeItem(id){
    const idx = state.board.items.findIndex(i => i.id === id);
    if(idx === -1) return;
    state.board.items.splice(idx, 1);
    const el = itemEls.get(id);
    if(el) el.remove();
    itemEls.delete(id);
    if(state.selectedId === id) state.selectedId = null;
    state.dirty = true;
    updateEmptyHint();
  }

  function renderCanvasItem(item){
    const el = document.createElement('div');
    el.className = 'collage-item';
    el.dataset.id = item.id;
    applyItemTransform(el, item);

    const img = document.createElement('img');
    img.src = item.src; img.alt = ''; img.draggable = false;
    el.appendChild(img);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'item-del';
    delBtn.setAttribute('aria-label', 'Remove clipping');
    delBtn.textContent = '\u00d7';
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', e => { e.stopPropagation(); removeItem(item.id); });
    el.appendChild(delBtn);

    const cutBtn = document.createElement('button');
    cutBtn.type = 'button';
    cutBtn.className = 'item-cut';
    cutBtn.setAttribute('aria-label', 'Clip background');
    cutBtn.title = 'Clip background';
    cutBtn.textContent = '\u2702';
    cutBtn.addEventListener('pointerdown', e => e.stopPropagation());
    cutBtn.addEventListener('click', e => {
      e.stopPropagation();
      openCutoutModal(item.src, (newSrc)=>{
        item.src = newSrc;
        const liveEl = itemEls.get(item.id);
        if(liveEl){ const imgEl = liveEl.querySelector('img'); if(imgEl) imgEl.src = newSrc; }
        state.dirty = true;
      });
    });
    el.appendChild(cutBtn);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'item-resize';
    resizeHandle.setAttribute('aria-hidden', 'true');
    resizeHandle.addEventListener('pointerdown', e => { e.stopPropagation(); startResize(e, item, el); });
    el.appendChild(resizeHandle);

    const rotWrap = document.createElement('div');
    rotWrap.className = 'item-rotate-wrap';
    const rotHandle = document.createElement('div');
    rotHandle.className = 'item-rotate';
    rotHandle.setAttribute('aria-hidden', 'true');
    rotHandle.addEventListener('pointerdown', e => { e.stopPropagation(); startRotate(e, item, el); });
    rotWrap.appendChild(rotHandle);
    el.appendChild(rotWrap);

    el.addEventListener('pointerdown', e => startDrag(e, item, el));

    document.getElementById('canvasBoard').appendChild(el);
    itemEls.set(item.id, el);
    if(state.selectedId === item.id) el.classList.add('selected');
    updateEmptyHint();
  }

  function renderCanvasAll(){
    const canvasBoard = document.getElementById('canvasBoard');
    canvasBoard.querySelectorAll('.collage-item').forEach(n => n.remove());
    itemEls.clear();
    state.board.items.slice().sort((a,b)=> a.z - b.z).forEach(renderCanvasItem);
    updateEmptyHint();
  }

  // ---------------- interactions ----------------
  function startDrag(e, item, el){
    e.preventDefault();
    selectItem(item.id);
    state.zCounter++;
    item.z = state.zCounter;
    el.style.zIndex = item.z;
    const rect = document.getElementById('canvasBoard').getBoundingClientRect();
    const startX = item.x, startY = item.y;
    const startClientX = e.clientX, startClientY = e.clientY;
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    state.dirty = true;

    function onMove(ev){
      const dxFrac = (ev.clientX - startClientX) / rect.width;
      const dyFrac = (ev.clientY - startClientY) / rect.height;
      let nx = startX + dxFrac, ny = startY + dyFrac;
      nx = Math.min(Math.max(nx, -item.w + 0.08), 1 - 0.08);
      ny = Math.min(Math.max(ny, -item.h + 0.08), 1 - 0.08);
      item.x = nx; item.y = ny;
      applyItemTransform(el, item);
    }
    function onUp(){
      try{ el.releasePointerCapture(e.pointerId); }catch(err){}
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  function startResize(e, item, el){
    e.preventDefault();
    selectItem(item.id);
    const rect = document.getElementById('canvasBoard').getBoundingClientRect();
    const startWpx = item.w * rect.width;
    const rot = item.rot, ar = item.ar || 1;
    const startClientX = e.clientX, startClientY = e.clientY;
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    state.dirty = true;

    function onMove(ev){
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      const rad = -rot * Math.PI / 180;
      const localDx = dx * Math.cos(rad) - dy * Math.sin(rad);
      let newWpx = Math.min(Math.max(startWpx + localDx, 24), rect.width * 1.8);
      let newHpx = newWpx / ar;
      item.w = newWpx / rect.width;
      item.h = newHpx / rect.height;
      applyItemTransform(el, item);
    }
    function onUp(){
      try{ el.releasePointerCapture(e.pointerId); }catch(err){}
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  function startRotate(e, item, el){
    e.preventDefault();
    selectItem(item.id);
    const rect = document.getElementById('canvasBoard').getBoundingClientRect();
    const centerX = rect.left + (item.x + item.w/2) * rect.width;
    const centerY = rect.top + (item.y + item.h/2) * rect.height;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    const startRot = item.rot;
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    state.dirty = true;

    function onMove(ev){
      const angle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
      const deltaDeg = (angle - startAngle) * 180 / Math.PI;
      item.rot = startRot + deltaDeg;
      applyItemTransform(el, item);
    }
    function onUp(){
      try{ el.releasePointerCapture(e.pointerId); }catch(err){}
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // ---------------- tray ----------------
  function renderTray(){
    const tray = document.getElementById('tray');
    tray.innerHTML = '';
    if(!state.clippings.length){
      const empty = document.createElement('div');
      empty.className = 'tray-empty';
      empty.textContent = 'No clippings yet. Add photos above to start pinning together a look.';
      tray.appendChild(empty);
      return;
    }
    state.clippings.forEach(c=>{
      const div = document.createElement('div');
      div.className = 'clip-thumb';
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.setAttribute('aria-label', 'Add clipping to board');
      const img = document.createElement('img');
      img.src = c.src; img.alt = '';
      div.appendChild(img);

      const cutBtn = document.createElement('button');
      cutBtn.type = 'button';
      cutBtn.className = 'clip-cut';
      cutBtn.setAttribute('aria-label', 'Clip background');
      cutBtn.title = 'Clip background';
      cutBtn.textContent = '\u2702';
      cutBtn.addEventListener('click', e=>{
        e.stopPropagation();
        openCutoutModal(c.src, (newSrc)=>{ c.src = newSrc; renderTray(); });
      });
      div.appendChild(cutBtn);

      div.addEventListener('click', ()=> addItemFromClipping(c));
      div.addEventListener('keydown', e=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); addItemFromClipping(c); } });
      tray.appendChild(div);
    });
  }

  function addItemFromClipping(c){
    let w = 0.34;
    let h = 0.272 / (c.ar || 1);
    h = Math.min(Math.max(h, 0.1), 0.85);
    w = Math.min(Math.max(w, 0.1), 0.85);
    const jitterX = (Math.random() - 0.5) * 0.06;
    const jitterY = (Math.random() - 0.5) * 0.06;
    let x = 0.5 - w/2 + jitterX;
    let y = 0.5 - h/2 + jitterY;
    x = Math.min(Math.max(x, 0.02), 0.98 - w);
    y = Math.min(Math.max(y, 0.02), 0.98 - h);
    state.zCounter++;
    const item = { id: uid('item'), src: c.src, ar: c.ar || 1, x, y, w, h, rot: 0, z: state.zCounter };
    state.board.items.push(item);
    state.dirty = true;
    renderCanvasItem(item);
    selectItem(item.id);
  }

  // ---------------- boards / gallery ----------------
  function buildBoardCard(b){
    const card = document.createElement('div');
    card.className = 'board-card';

    const preview = document.createElement('div');
    preview.className = 'board-preview';
    const items = (b.items || []).slice().sort((x,y)=> x.z - y.z);
    if(!items.length){
      const ph = document.createElement('div');
      ph.className = 'board-preview-empty';
      ph.textContent = 'Empty board';
      preview.appendChild(ph);
    } else {
      items.forEach(it=>{
        const img = document.createElement('img');
        img.src = it.src; img.alt = '';
        img.style.left = (it.x * 100) + '%';
        img.style.top = (it.y * 100) + '%';
        img.style.width = (it.w * 100) + '%';
        img.style.height = (it.h * 100) + '%';
        img.style.transform = 'rotate(' + it.rot + 'deg)';
        img.style.zIndex = it.z;
        preview.appendChild(img);
      });
    }
    card.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'board-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'board-name';
    nameEl.textContent = b.name || 'Untitled board';
    const dateEl = document.createElement('div');
    dateEl.className = 'board-date';
    const count = items.length;
    dateEl.textContent = formatDate(b.updatedAt) + ' \u00b7 ' + count + (count === 1 ? ' piece' : ' pieces');
    meta.appendChild(nameEl); meta.appendChild(dateEl);
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'board-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button'; openBtn.className = 'btn btn-ghost'; openBtn.textContent = 'Open';
    openBtn.addEventListener('click', ()=> openBoard(b.id));
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn btn-danger-ghost'; delBtn.textContent = 'Delete';
    let confirming = false, confirmTimer = null;
    delBtn.addEventListener('click', ()=>{
      if(!confirming){
        confirming = true;
        delBtn.textContent = 'Sure?';
        delBtn.classList.add('confirming');
        confirmTimer = setTimeout(()=>{ confirming = false; delBtn.textContent = 'Delete'; delBtn.classList.remove('confirming'); }, 3000);
      } else {
        clearTimeout(confirmTimer);
        deleteBoard(b.id);
      }
    });
    actions.appendChild(openBtn); actions.appendChild(delBtn);
    card.appendChild(actions);
    return card;
  }

  async function renderGallery(){
    const container = document.getElementById('galleryContent');
    container.innerHTML = '<div class="gallery-loading">Loading boards\u2026</div>';
    const list = await loadBoards();
    state.boardsCache = list;
    container.innerHTML = '';
    if(!list.length){
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      empty.textContent = 'No boards yet. Make one and save it to see it here.';
      container.appendChild(empty);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'boards-grid';
    list.slice().sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0)).forEach(b=> grid.appendChild(buildBoardCard(b)));
    container.appendChild(grid);
  }

  async function openBoard(id){
    const list = state.boardsCache || await loadBoards();
    const found = list.find(b => b.id === id);
    if(!found){ showToast('Board not found.'); return; }
    state.board = JSON.parse(JSON.stringify(found));
    state.zCounter = state.board.items.reduce((m, it)=> Math.max(m, it.z||0), 0);
    state.dirty = false;
    document.getElementById('nameInput').value = state.board.name || '';
    deselectAll();
    renderCanvasAll();
    switchView('make');
  }

  async function deleteBoard(id){
    const list = state.boardsCache || await loadBoards();
    const next = list.filter(b => b.id !== id);
    const ok = await saveBoards(next);
    if(ok){
      state.boardsCache = next;
      renderGallery();
      showToast('Board deleted.');
    } else {
      showToast("Couldn't delete \u2014 try again.");
    }
  }

  async function handleSave(){
    if(!state.board.items.length){
      showToast('Add at least one clipping before saving.');
      return;
    }
    const nameInput = document.getElementById('nameInput');
    state.board.name = nameInput.value.trim() || 'Untitled board';
    nameInput.value = state.board.name;
    state.board.updatedAt = Date.now();
    const list = state.boardsCache || await loadBoards();
    const idx = list.findIndex(b => b.id === state.board.id);
    const boardCopy = JSON.parse(JSON.stringify(state.board));
    if(idx === -1) list.push(boardCopy); else list[idx] = boardCopy;
    const ok = await saveBoards(list);
    if(ok){
      state.boardsCache = list;
      state.dirty = false;
      showToast('Board saved.');
    } else {
      showToast("Couldn't save \u2014 try removing a photo or two and retry.");
    }
  }

  // ---------------- view switching ----------------
  function switchView(name){
    state.view = name;
    const makeView = document.getElementById('view-make');
    const boardsView = document.getElementById('view-boards');
    const tabMake = document.getElementById('tabMake');
    const tabBoards = document.getElementById('tabBoards');
    if(name === 'make'){
      makeView.classList.add('active'); boardsView.classList.remove('active');
      tabMake.classList.add('active'); tabBoards.classList.remove('active');
      tabMake.setAttribute('aria-selected','true'); tabBoards.setAttribute('aria-selected','false');
    } else {
      boardsView.classList.add('active'); makeView.classList.remove('active');
      tabBoards.classList.add('active'); tabMake.classList.remove('active');
      tabBoards.setAttribute('aria-selected','true'); tabMake.setAttribute('aria-selected','false');
      renderGallery();
    }
  }

  // ---------------- top-level handlers ----------------
  async function onFileChange(e){
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if(!files.length) return;
    let added = 0;
    for(const f of files){
      if(!f.type || !f.type.startsWith('image/')) continue;
      try{
        const { src, w, h } = await loadAndCompress(f);
        state.clippings.push({ id: uid('clip'), src, ar: (w && h) ? (w / h) : 1 });
        added++;
      }catch(err){ /* skip unreadable file */ }
    }
    renderTray();
    if(added) showToast(added === 1 ? 'Added 1 photo.' : 'Added ' + added + ' photos.');
    else showToast("Couldn't read that file.");
  }

  function onNewBoard(){
    if(state.dirty && !confirm('Start a new board? Unsaved changes to the current one will be lost.')) return;
    state.board = freshBoard();
    state.zCounter = 0;
    state.dirty = false;
    document.getElementById('nameInput').value = '';
    deselectAll();
    renderCanvasAll();
  }

  function onKeyDown(e){
    if(isCutoutModalOpen()){
      if(e.key === 'Escape') closeCutoutModal();
      return;
    }
    if(state.view !== 'make') return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea') return;
    if((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId){
      e.preventDefault();
      removeItem(state.selectedId);
    }
    if(e.key === 'Escape'){ deselectAll(); }
  }

  // ---------------- init ----------------
  function initAppInner(){
    state.board = freshBoard();

    document.getElementById('tabMake').addEventListener('click', ()=> switchView('make'));
    document.getElementById('tabBoards').addEventListener('click', ()=> switchView('boards'));
    document.getElementById('uploadBtn').addEventListener('click', ()=> document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', onFileChange);
    document.getElementById('newBoardBtn').addEventListener('click', onNewBoard);
    document.getElementById('saveBtn').addEventListener('click', handleSave);

    const nameInput = document.getElementById('nameInput');
    nameInput.addEventListener('input', ()=>{ state.dirty = true; });
    nameInput.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); nameInput.blur(); } });

    const canvasBoard = document.getElementById('canvasBoard');
    canvasBoard.addEventListener('pointerdown', e=>{ if(e.target === e.currentTarget) deselectAll(); });

    document.getElementById('cutoutSlider').addEventListener('input', debouncedUpdateQuickPreview);
    document.getElementById('cutoutModeAi').addEventListener('click', ()=> setCutoutMode('ai'));
    document.getElementById('cutoutModeQuick').addEventListener('click', ()=> setCutoutMode('quick'));
    document.getElementById('cutoutCancelBtn').addEventListener('click', closeCutoutModal);
    document.getElementById('cutoutApplyBtn').addEventListener('click', ()=>{
      if(cutoutState && cutoutState.currentDataUrl && cutoutState.onApply){
        cutoutState.onApply(cutoutState.currentDataUrl);
        showToast('Background clipped.');
      }
      closeCutoutModal();
    });
    document.getElementById('cutoutModal').addEventListener('pointerdown', e=>{
      if(e.target === e.currentTarget) closeCutoutModal();
    });

    document.addEventListener('keydown', onKeyDown);

    renderTray();
    renderCanvasAll();
    switchView('make');
  }

export function initApp(){
  initAppInner();
}
