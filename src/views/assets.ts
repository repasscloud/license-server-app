// Static stylesheet served from /assets/app.css (CSP forbids inline styles and scripts).
export const APP_CSS = `
:root{--bg:#f7f8fa;--fg:#1b1f24;--muted:#5b6470;--card:#fff;--line:#d9dee5;--accent:#0b5cad;--accent-fg:#fff;--danger:#b42318;--ok:#067647;--warn:#b54708;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e9ed;--muted:#9aa4b0;--card:#171b21;--line:#2a313a;--accent:#5aa2f0;--accent-fg:#0b0e12;--danger:#f97066;--ok:#47cd89;--warn:#fdb022;--code:#1f252d}}
*{box-sizing:border-box}html{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
body{margin:0}a{color:var(--accent)}header.top{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header.top .brand{font-weight:700;margin-right:8px}header.top nav{display:flex;gap:12px;flex-wrap:wrap}header.top nav a{text-decoration:none}header.top .who{margin-left:auto;color:var(--muted);font-size:.9em}
main{max-width:1180px;margin:0 auto;padding:16px}h1{font-size:1.45rem;margin:.2em 0 .6em}h2{font-size:1.15rem;margin:1.4em 0 .5em}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}.stat b{display:block;font-size:1.5rem}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.93em}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
form.inline{display:inline}label{display:block;font-weight:600;margin:.5em 0 .2em}input,select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:100%;max-width:520px}
input[type=checkbox]{width:auto}:is(input,select,textarea)+button{margin-left:8px}textarea{min-height:120px;max-width:100%}.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1 1 200px}
button,.button{display:inline-block;font:inherit;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);border-radius:6px;padding:6px 12px;cursor:pointer;text-decoration:none;margin:4px 4px 4px 0}
button.secondary,.button.secondary{background:transparent;color:var(--accent)}button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
.flash{padding:10px 12px;border-radius:6px;margin:0 0 12px;border:1px solid var(--line)}.flash.ok{border-color:var(--ok)}.flash.err{border-color:var(--danger)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.82em;border:1px solid var(--line)}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--danger);border-color:var(--danger)}.badge.warn{color:var(--warn);border-color:var(--warn)}
.muted{color:var(--muted)}.secret{font-size:1.1em;padding:10px;display:block;margin:8px 0}details{margin:6px 0}summary{cursor:pointer;color:var(--accent)}
@media (max-width:640px){main{padding:12px 16px}th,td{padding:5px 6px}}
.currency-picker{display:flex;gap:8px;align-items:center;margin:0 0 16px}.currency-picker label{margin:0}.currency-picker select{width:auto}
`;

/** Store currency switcher (served from /assets/store.js; no inline script under CSP). */
export const STORE_JS = `(() => {
  const picker = document.querySelector('[data-currency-picker]');
  if (!picker) return;
  const apply = (cur) => {
    for (const card of document.querySelectorAll('[data-offer]')) {
      let has = false;
      for (const p of card.querySelectorAll('[data-price]')) { const on = p.dataset.price === cur; p.hidden = !on; has = has || on; }
      card.querySelector('[data-price-missing]').hidden = has;
      card.querySelector('[data-currency-field]').value = cur;
      card.querySelector('[data-buy]').disabled = !has;
    }
    const u = new URL(location.href); u.searchParams.set('currency', cur); history.replaceState(null, '', u);
  };
  picker.addEventListener('change', () => apply(picker.value));
})();
`;
