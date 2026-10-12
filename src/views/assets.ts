// External assets keep the UI compatible with the strict script/style CSP.
export const APP_CSS = `
:root{color-scheme:light;--bg:#f4f3f7;--fg:#18141f;--muted:#5c5569;--card:#fff;--line:#e3e0ea;--accent:#6a1fc4;--accent-hover:#4c1192;--accent-fg:#fff;--tint:#f1e9fc;--danger:#b3261e;--ok:#1b7a43;--warn:#945600;--code:#eeebf3}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#15111c;--fg:#f4f1f8;--muted:#b7afc5;--card:#211b2c;--line:#3b324a;--accent:#c5a0fa;--accent-hover:#dcc3ff;--accent-fg:#221139;--tint:#322342;--danger:#ffaaa2;--ok:#86d8a4;--warn:#efc176;--code:#322b3e}}
:root[data-theme=dark]{color-scheme:dark;--bg:#15111c;--fg:#f4f1f8;--muted:#b7afc5;--card:#211b2c;--line:#3b324a;--accent:#c5a0fa;--accent-hover:#dcc3ff;--accent-fg:#221139;--tint:#322342;--danger:#ffaaa2;--ok:#86d8a4;--warn:#efc176;--code:#322b3e}
*{box-sizing:border-box}[hidden]{display:none!important}html{font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--fg);background:var(--bg)}body{margin:0;min-height:100vh;display:flex;flex-direction:column;border-top:4px solid transparent;border-image:linear-gradient(90deg,#ffbe16,#e35f9a 48%,#ab2df3) 1}a{color:var(--accent);text-underline-offset:3px}a:hover{color:var(--accent-hover)}p{max-width:76ch;margin:.65em 0 1em}h1,h2,h3{line-height:1.25;letter-spacing:-.025em}h1{font-size:clamp(1.7rem,3vw,2.4rem);margin:0 0 24px}h2{font-size:1.25rem;margin:28px 0 16px}h3{font-size:1.1rem;margin:20px 0 12px}h1 code{font-size:.5em;vertical-align:middle}h1 .badge{font-size:.38em;vertical-align:middle}.card h2:first-child,.card h1:first-child{margin-top:0}
.skip-link{position:absolute;left:16px;top:-80px;z-index:20;background:var(--card);padding:12px}.skip-link:focus{top:12px}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
header.top{display:flex;gap:24px;align-items:center;flex-wrap:wrap;padding:22px max(24px,calc((100vw - 1280px)/2));border-bottom:1px solid var(--line);background:var(--card)}.brand{display:inline-flex;align-items:center;gap:12px;color:var(--fg);text-decoration:none;font-weight:750;font-size:1.1rem;line-height:1.2;white-space:nowrap}.brand small{display:block;color:var(--muted);font-size:.75rem;font-weight:500;margin-top:4px}.brand img{flex-shrink:0}.top nav{display:flex;gap:6px 18px;flex-wrap:wrap;align-items:center;flex:1}.top nav a{color:var(--muted);text-decoration:none;font-weight:550;font-size:.9rem;padding:6px 0}.top nav a:hover,.top nav a[aria-current=page]{color:var(--accent)}.top nav a[aria-current=page]{border-bottom:2px solid var(--accent)}.top .who{font-size:.82rem;color:var(--muted);overflow-wrap:anywhere}.realm-admin .top nav{order:3;flex-basis:100%;border-top:1px solid var(--line);padding-top:14px}.theme-toggle{margin-left:auto!important;white-space:nowrap;font-size:.85rem}
main{width:100%;max-width:1280px;margin:0 auto;padding:40px 28px 64px;flex:1}.realm-public main{max-width:1180px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin:0 0 24px}.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-bottom:24px}.grid .card{margin:0}.stat{border-top:3px solid var(--accent)}.stat b{display:block;font-size:2rem;margin-top:8px}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}.row>div{flex:1 1 220px;min-width:0}.row>form.card{flex:1 1 300px;min-width:0}.row>label{flex:1 1 220px}.row>input,.row>select{flex:1 1 160px}.row>button{align-self:flex-end}
.table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;margin:20px 0 28px;max-width:100%}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}th{background:var(--bg);color:var(--muted);font-weight:650;white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--bg)}td p{margin:0}td form{min-width:180px}td input,td select{min-width:140px}td details[open]{min-width:280px;max-width:350px}.key-action{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.key-action[open]{padding:18px}.key-action summary{font-weight:650}.key-action-row .key-action,.key-action-row .key-action[open]{margin:0;max-width:none;min-width:0}.key-action-row form{max-width:860px}.key-action-row td{padding:12px 16px}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;background:var(--code);padding:3px 6px;border-radius:5px;overflow-wrap:anywhere;word-break:break-word}pre{overflow-x:auto}.secret{display:block;padding:16px;font-size:1.05em;margin:12px 0}
form.inline{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px}label{display:block;font-weight:600;font-size:.9rem;margin:16px 0 6px}input,select,textarea{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 12px;width:100%;max-width:100%;min-height:44px}input:hover,select:hover,textarea:hover{border-color:var(--muted)}input[readonly]{background:var(--bg)}input[type=checkbox],input[type=radio]{width:18px;min-width:18px;min-height:18px;height:18px;vertical-align:middle;margin:0 5px 2px 0;accent-color:var(--accent)}input[type=hidden]{display:none}textarea{min-height:140px;resize:vertical}fieldset{border:0;padding:0;margin:24px 0 0;min-width:0}legend{font-weight:650;border-top:1px solid var(--line);padding:20px 0 0;width:100%}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:600 .9rem/1.4 system-ui,sans-serif;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);border-radius:6px;padding:11px 18px;cursor:pointer;text-decoration:none;margin:18px 8px 0 0;min-height:44px}button:hover,.button:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--accent-fg)}button.secondary,.button.secondary{background:transparent;color:var(--accent);border-color:var(--line)}button.secondary:hover,.button.secondary:hover{background:var(--tint);border-color:var(--accent)}button.danger{background:var(--danger);border-color:var(--danger);color:var(--card)}button:disabled{opacity:.5;cursor:not-allowed}.inline button{margin:0 6px 4px 0}.flash{padding:16px 20px;border-radius:8px;margin:0 0 28px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line)}.flash.ok{border-left-color:var(--ok)}.flash.err{border-left-color:var(--danger)}.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:.78rem;line-height:1.4;background:var(--bg);border:1px solid var(--line);white-space:nowrap}.badge.ok{color:var(--ok)}.badge.bad{color:var(--danger)}.badge.warn{color:var(--warn)}.muted{color:var(--muted)}details{margin:14px 0}summary{cursor:pointer;color:var(--accent);padding:4px 0}details.card>summary{font-weight:650}details.card[open]>summary{padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:16px}details form{margin-top:16px}.table-empty{margin:0;padding:24px;color:var(--muted)}.empty-state{padding:40px 28px;border:1px dashed var(--line);border-radius:12px;background:var(--card)}.site-footer{display:flex;gap:24px;flex-wrap:wrap;border-top:1px solid var(--line);padding:24px max(28px,calc((100vw - 1224px)/2));font-size:.85rem;color:var(--muted)}.site-footer span{margin-right:auto;font-weight:650}.site-footer a{color:var(--muted)}
.page-intro{padding:16px 0 28px;max-width:780px}.page-intro h1{font-size:clamp(2.3rem,5vw,3.5rem);margin-bottom:18px}.page-intro p,.product-heading p{font-size:1.1rem;color:var(--muted)}.selection-form{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end}.selection-form .field{flex:1 1 160px;min-width:0}.selection-form .edition-field{flex:3 1 290px}.product-options .selection-form .field:not(.edition-field){flex:1 1 85px}.selection-form label{margin-top:0}.selection-form button{margin:0}.catalogue-currency{max-width:340px;margin-bottom:30px}.product-list{display:grid;gap:24px}.product-entry{display:grid;grid-template-columns:112px 1fr minmax(175px,220px);align-items:center;gap:28px;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:14px}.product-entry h2{font-size:1.7rem;margin:0 0 14px}.product-entry h2 a{color:var(--fg);text-decoration:none}.product-entry p{margin:8px 0;white-space:pre-line}.product-entry-action{border-left:1px solid var(--line);padding-left:28px}.product-entry-action .button{width:100%}.product-art{width:112px;height:112px;object-fit:contain;border-radius:12px;flex-shrink:0}.monogram{display:grid;place-items:center;background:var(--fg);color:var(--card);font-size:2rem;font-weight:750}.breadcrumb{font-size:.9rem;color:var(--muted);margin:0 0 32px}.product-heading{display:flex;align-items:center;gap:28px;padding-bottom:36px;margin-bottom:32px;border-bottom:1px solid var(--line)}.product-heading h1{margin:0 0 12px;font-size:clamp(2rem,4vw,3rem)}.product-heading p{margin:0;white-space:pre-line}.product-detail{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(300px,1fr);gap:48px}.product-options>h2{margin:0 0 20px}.offer-summary{margin-top:28px;padding:24px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.offer-summary h3{font-size:1.35rem;margin:0 0 16px}.description{white-space:pre-line}.price{font-size:1.3rem;margin-bottom:0}.price-note{font-size:.9rem}.purchase-panel{background:var(--card);border:1px solid var(--line);padding:28px;border-radius:12px;align-self:start}.purchase-panel h2{margin:0 0 14px}.purchase-button{width:100%;margin-top:28px}.edition-comparison{margin:24px 0}.edition-comparison article{padding:16px 0;border-top:1px solid var(--line)}.stripe-attribution{font-size:.85rem;color:var(--muted);margin-top:24px}.stripe-attribution a{display:inline-flex;vertical-align:middle;background:white;padding:4px 8px;border-radius:4px}.stripe-attribution img{display:block;object-fit:contain}.realm-customer main>div.card:only-child,.realm-admin main>div.card:only-child{max-width:760px;margin:20px auto}.realm-customer .card .card{border-radius:8px;margin-top:24px}
@media(max-width:900px){header.top{gap:16px;padding:18px 24px}.top nav{order:3;flex-basis:100%;border-top:1px solid var(--line);padding-top:12px}.top .who{margin-left:auto}.product-detail{gap:28px}.product-entry{grid-template-columns:80px 1fr;gap:20px}.product-entry .product-art{width:80px;height:80px}.product-entry-action{grid-column:2;border:0;padding:0}.product-entry-action .button{width:auto}.product-heading .product-art{width:88px;height:88px}}
@media(max-width:640px){main{padding:28px 18px 40px}header.top{padding:16px 18px}.top .who{order:4;flex-basis:100%}.card{padding:20px}.row{gap:16px}.row>form.card{flex-basis:100%}.product-detail{grid-template-columns:1fr;gap:28px}.product-heading{align-items:flex-start;gap:18px}.product-heading .product-art{width:64px;height:64px}.product-entry{padding:22px;grid-template-columns:56px 1fr;gap:16px}.product-entry .product-art{width:56px;height:56px;font-size:1.3rem}.product-entry h2{font-size:1.35rem}.product-entry-action{grid-column:1/-1}.selection-form .field,.product-options .selection-form .field:not(.edition-field){flex-basis:100%}.catalogue-currency .field{flex-basis:150px}.purchase-panel{padding:22px}.site-footer{padding:24px 18px;gap:14px}.site-footer span{flex-basis:100%}th,td{padding:12px}h1{overflow-wrap:anywhere}.realm-admin .top nav{flex-wrap:nowrap;overflow-x:auto;padding-bottom:8px;gap:18px}.realm-admin .top nav a{white-space:nowrap}}
@media(prefers-reduced-motion:no-preference){button,a,input,select,textarea{transition:background-color .15s,border-color .15s,color .15s}}
`;

export const APP_JS = `(() => {
  const root = document.documentElement;
  try { const saved = localStorage.getItem('repass-theme'); if (saved === 'light' || saved === 'dark') root.dataset.theme = saved; } catch {}
  document.addEventListener('DOMContentLoaded', () => {
    const theme = document.querySelector('[data-theme-toggle]');
    const dark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const label = () => { if (theme) { theme.textContent = dark() ? '☀ Light mode' : '☾ Dark mode'; theme.setAttribute('aria-label', 'Switch to ' + (dark() ? 'light' : 'dark') + ' mode'); } };
    if (theme) { theme.hidden = false; label(); theme.addEventListener('click', () => { root.dataset.theme = dark() ? 'light' : 'dark'; try { localStorage.setItem('repass-theme', root.dataset.theme); } catch {} label(); }); }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
    for (const link of document.querySelectorAll('header nav a')) {
      if (new URL(link.href).pathname === location.pathname || (link.pathname !== '/admin' && link.pathname !== '/portal' && location.pathname.startsWith(link.pathname + '/'))) link.setAttribute('aria-current', 'page');
    }
    for (const wrap of document.querySelectorAll('.table-wrap')) {
      const table = wrap.querySelector('table');
      if (table && table.tBodies.length && [...table.tBodies].every(body => !body.rows.length)) {
        const message = document.createElement('p'); message.className = 'table-empty'; message.textContent = 'No records yet.'; wrap.append(message);
      }
      if (wrap.scrollWidth > wrap.clientWidth) { wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Scrollable data table'); }
    }
    // Connect legacy server-rendered field labels to adjacent controls as well.
    for (const label of document.querySelectorAll('label:not([for])')) {
      const control = label.nextElementSibling;
      if (control && control.matches('input:not([type=hidden]), select, textarea')) {
        if (!control.id) control.id = 'field-' + [...document.querySelectorAll('input, select, textarea')].indexOf(control);
        label.htmlFor = control.id;
      }
    }
    for (const el of document.querySelectorAll('input[type=email]')) {
      el.setAttribute('autocapitalize', 'none'); el.setAttribute('spellcheck', 'false');
      const lower = () => { el.value = el.value.trim().toLowerCase(); };
      el.addEventListener('blur', lower); lower();
    }
    const selector = document.querySelector('[data-product-selector]');
    if (!selector) {
      const currency = document.querySelector('[data-currency-picker]');
      if (currency) currency.addEventListener('change', () => currency.form.requestSubmit());
      return;
    }
    const editions = selector.querySelector('[data-edition-picker]');
    const version = selector.querySelector('[data-version-picker]');
    const currency = selector.querySelector('[data-currency-picker]');
    const checkout = document.querySelector('[data-checkout-form]');
    const apply = (changedVersion = false) => {
      for (const option of editions.options) { option.hidden = !!version && option.dataset.major !== version.value; option.disabled = option.hidden; }
      if (changedVersion || editions.selectedOptions[0].disabled) editions.value = [...editions.options].find(o => !o.disabled).value;
      const choice = editions.selectedOptions[0];
      for (const panel of document.querySelectorAll('[data-offer-summary]')) {
        panel.hidden = panel.dataset.offerSummary !== choice.value;
        for (const price of panel.querySelectorAll('[data-price]')) price.hidden = price.dataset.price !== currency.value;
      }
      checkout.querySelector('[data-sku-field]').value = choice.value;
      checkout.querySelector('[data-currency-field]').value = currency.value;
      const org = checkout.querySelector('[data-organisation-fields]'); org.hidden = choice.dataset.org !== 'true'; org.disabled = org.hidden;
      const quantity = checkout.querySelector('[name=quantity]'); quantity.min = choice.dataset.min; quantity.max = choice.dataset.max;
      checkout.querySelector('[data-quantity-fields]').hidden = quantity.min === quantity.max;
      quantity.value = String(Math.min(Number(quantity.max), Math.max(Number(quantity.min), Number(quantity.value) || Number(quantity.min))));
      checkout.querySelector('[data-buy]').textContent = choice.dataset.free === 'true' ? 'Register licence' : 'Continue to Stripe';
      // New selection uses a fresh key; an actual retry of the same form retains its key.
      const key = checkout.querySelector('[name=idempotencyKey]');
      if (crypto.randomUUID) key.value = 'ck_' + crypto.randomUUID();
      const url = new URL(location.href); url.searchParams.set('sku', choice.value); url.searchParams.set('currency', currency.value); if (version) url.searchParams.set('version', version.value); history.replaceState(null, '', url);
    };
    if (version) version.addEventListener('change', () => apply(true));
    editions.addEventListener('change', () => { if (version) version.value = editions.selectedOptions[0].dataset.major; apply(); });
    currency.addEventListener('change', () => apply()); apply();
    // A GET submission still renders this same selection on the server.
    selector.querySelector('button[type=submit]').hidden = true;
  });
})();
`;
