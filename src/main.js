import { initApp } from './app.js';

// Casual passcode gate: this app is hosted at a public URL with no login,
// and its Supabase anon key (visible to anyone who views source) is what
// actually reads/writes the boards data. This passcode is NOT real security
// — it's a speed bump so a random visitor who stumbles on the link can't
// immediately poke around, nothing more. Don't reuse it for anything where
// that distinction matters.
const PASSCODE = 'Bestie2026!';
const UNLOCK_KEY = 'cuttingTable.unlocked';

function boot() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

function unlock() {
  document.getElementById('lockOverlay').hidden = true;
  boot();
}

if (localStorage.getItem(UNLOCK_KEY) === '1') {
  unlock();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('lockForm');
    const input = document.getElementById('lockInput');
    const error = document.getElementById('lockError');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value === PASSCODE) {
        try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (err) { /* ignore */ }
        unlock();
      } else {
        error.textContent = 'Wrong passcode — try again.';
        input.value = '';
        input.focus();
      }
    });
    input.focus();
  });
}
