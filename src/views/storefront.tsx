/** @jsxImportSource hono/jsx */
import type { StoreOffer, StoreComponent } from '../services/catalogue.ts';
import { COUNTRIES } from '../lib/countries.ts';
import { newId } from '../lib/ids.ts';
import { Csrf, money } from './layout.tsx';

export type StoreEntry = { key: string; href: string; name: string; description: string; imageUrl: string | null; offers: StoreOffer[] };
export function storeEntries(offers: StoreOffer[]): StoreEntry[] {
  const entries = new Map<string, StoreEntry>();
  for (const offer of offers) {
    const component = offer.components[0]!;
    const bundle = offer.kind === 'bundle' || offer.components.length > 1;
    const key = bundle ? `bundle:${offer.sku}` : component.slug;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, href: bundle ? `/store/bundles/${encodeURIComponent(offer.sku)}` : `/store/products/${encodeURIComponent(component.slug)}`,
        name: bundle ? offer.name : component.name, description: bundle ? offer.description : component.description,
        imageUrl: bundle ? null : component.imageUrl, offers: [] };
      entries.set(key, entry);
    }
    entry.offers.push(offer);
  }
  return [...entries.values()];
}
export const ProductArt = ({ imageUrl, name }: { imageUrl: string | null; name: string }) => imageUrl
  ? <img class="product-art" src={imageUrl} alt={`${name} logo`} width="112" height="112" loading="lazy" />
  : <span class="product-art monogram" aria-hidden="true">{name.slice(0, 2)}</span>;
export const PriceLine = (p: StoreOffer['prices'][number]) => {
  if (p.unitAmount === 0) return <b>Free</b>;
  const term = p.recurringInterval ? ` per ${p.recurringIntervalCount && p.recurringIntervalCount > 1 ? `${p.recurringIntervalCount} ` : ''}${p.recurringInterval}` : '';
  if (!p.taxRateBps) return <><b>{money(p.unitAmount, p.currency)}</b>{term}</>;
  const tax = Math.round(p.unitAmount * p.taxRateBps / 10000);
  return <><b>{money(p.unitAmount + tax, p.currency)}</b> incl. {p.taxLabel}{term}<br /><span class="muted price-note">{money(p.unitAmount, p.currency)} + {p.taxLabel} {p.taxRateBps / 100}% ({money(tax, p.currency)})</span></>;
};
export const StripeAttribution = () => <p class="stripe-attribution">Payment is processed by <a href="https://stripe.com" rel="noopener noreferrer"><img src="/assets/stripe.svg" width="60" height="25" alt="Stripe" /></a>. Promotion codes can be entered at checkout.</p>;
export const CurrencySelect = ({ currencies, currency }: { currencies: string[]; currency: string }) => <div class="field"><label for="currency">Currency</label><select id="currency" name="currency" data-currency-picker>{currencies.map(cur => <option value={cur} selected={cur === currency}>{cur.toUpperCase()}</option>)}</select></div>;
export const Catalogue = ({ entries, currency, currencies }: { entries: StoreEntry[]; currency: string; currencies: string[] }) => <>
  <section class="page-intro"><h1>Software that gets to work.</h1><p>Explore RePass Cloud products and choose the licence that fits your use.</p></section>
  {entries.length ? <form method="get" action="/store" class="selection-form catalogue-currency"><CurrencySelect currencies={currencies} currency={currency} /><button class="secondary" type="submit">Show prices</button></form> : <div class="empty-state"><h2>Products are coming soon</h2><p>There are no products available to buy right now.</p></div>}
  <div class="product-list">{entries.map(entry => {
    const prices = entry.offers.flatMap(o => o.prices.filter(p => p.currency === currency));
    const lowest = prices.sort((a, b) => (a.unitAmount + Math.round(a.unitAmount * (a.taxRateBps ?? 0) / 10000)) - (b.unitAmount + Math.round(b.unitAmount * (b.taxRateBps ?? 0) / 10000)))[0];
    return <article class="product-entry"><ProductArt imageUrl={entry.imageUrl} name={entry.name} /><div><h2><a href={`${entry.href}?currency=${currency}`}>{entry.name}</a></h2><p>{entry.description || 'Choose an edition to see licence details and pricing.'}</p><p class="muted">{entry.offers.length} licence {entry.offers.length === 1 ? 'option' : 'options'} available</p></div><div class="product-entry-action">{lowest ? <p>{prices.length > 1 ? 'From ' : ''}<PriceLine {...lowest} /></p> : null}<a class="button" href={`${entry.href}?currency=${currency}`}>Explore product</a></div></article>;
  })}</div>
</>;
export const ProductDetail = ({ entry, selected, currency, currencies, csrf, email, country }: { entry: StoreEntry; selected: StoreOffer; currency: string; currencies: string[]; csrf: string; email: string | null; country: string }) => {
  const major = selected.components[0]!.major;
  const majors = [...new Set(entry.offers.map(o => o.components[0]!.major))].sort((a, b) => b - a);
  return <>
    <p class="breadcrumb"><a href="/store">All products</a> / {entry.name}</p>
    <section class="product-heading"><ProductArt imageUrl={entry.imageUrl} name={entry.name} /><div><h1>{entry.name}</h1><p>{entry.description}</p></div></section>
    <div class="product-detail">
      <section class="product-options"><h2>Choose your licence</h2><form method="get" action={entry.href} class="selection-form" data-product-selector>
        {entry.key.startsWith('bundle:') ? null : <div class="field"><label for="version">Version</label><select id="version" name="version" data-version-picker>{majors.map(v => <option value={String(v)} selected={v === major}>Version {v}</option>)}</select></div>}
        <div class="field edition-field"><label for="edition">Edition and billing</label><select id="edition" name="sku" data-edition-picker>{entry.offers.map(o => <option value={o.sku} selected={o.sku === selected.sku} hidden={o.components[0]!.major !== major} disabled={o.components[0]!.major !== major} data-major={o.components[0]!.major} data-org={String(o.needsOrganisation)} data-min={o.minQuantity} data-max={o.maxQuantity} data-free={String(o.prices.every(p => p.unitAmount === 0))}>{o.name}</option>)}</select></div>
        <CurrencySelect currencies={currencies} currency={currency} /><button class="secondary" type="submit">Update selection</button>
      </form>
      <div aria-live="polite" aria-atomic="true" class="offer-summary">{entry.offers.map(o => <section data-offer-summary={o.sku} hidden={o.sku !== selected.sku}><h3>{o.name}</h3><p class="description">{o.description || o.products}</p>{o.components.length > 1 ? <ul>{o.components.map((c: StoreComponent) => <li>{c.name} v{c.major}: {c.edition}</li>)}</ul> : null}{o.prices.map(p => <p class="price" data-price={p.currency} hidden={p.currency !== currency}><PriceLine {...p} /></p>)}</section>)}</div>
      <details class="edition-comparison"><summary>Compare all licence options</summary>{entry.offers.map(o => <article><h3><a href={`${entry.href}?sku=${encodeURIComponent(o.sku)}&version=${o.components[0]!.major}&currency=${currency}`}>{o.name}</a></h3><p>{o.description || o.products}</p><PriceLine {...o.prices.find(p => p.currency === currency)!} /></article>)}</details>
      <StripeAttribution />
      <p class="muted">Already a customer? Use the same email address to add this licence to your account.</p>
    </section>
    <section class="purchase-panel"><h2>Your details</h2><p class="muted">Your licence and receipt will be sent to this email address.</p>
      <form method="post" action="/checkout" data-checkout-form><Csrf token={csrf} />
        <input type="hidden" name="sku" value={selected.sku} data-sku-field /><input type="hidden" name="currency" value={currency} data-currency-field />
        <input type="hidden" name="idempotencyKey" value={newId('req').replace('req_', 'ck_')} />
        <div data-quantity-fields hidden={selected.minQuantity === selected.maxQuantity}><label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min={selected.minQuantity} max={selected.maxQuantity} value={String(selected.minQuantity)} required /></div>
        <label for="buyer-email">Email</label><input id="buyer-email" name="email" type="email" required autocomplete="email" readonly={!!email} value={email ?? ''} />
        <label for="buyer-name">Your name</label><input id="buyer-name" name="name" required maxlength={200} autocomplete="name" />
        <fieldset data-organisation-fields hidden={!selected.needsOrganisation} disabled={!selected.needsOrganisation}><legend>Organisation details</legend>
          <label for="business">Business or institution name</label><input id="business" name="businessName" required maxlength={200} autocomplete="organization" />
          <label for="country">Country</label><select id="country" name="country" required autocomplete="country"><option value="">Select your country</option>{COUNTRIES.map(c => <option value={c.code} selected={c.code === country}>{c.name}</option>)}</select>
          <label for="business-id">Business identifier <span class="muted">(optional)</span></label><input id="business-id" name="businessIdentifier" maxlength={64} placeholder="ABN, VAT or EIN" />
        </fieldset>
        <button class="purchase-button" type="submit" data-buy>{selected.prices.every(p => p.unitAmount === 0) ? 'Register licence' : 'Continue to Stripe'}</button>
      </form>
    </section></div>
  </>;
};
