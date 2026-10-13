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
export const CurrencySelect = ({ currencies, currency }: { currencies: string[]; currency: string }) => <div class="field"><label for="currency">Currency</label><select id="currency" name="currency" data-currency-picker>{currencies.map(cur => <option value={cur} selected={cur === currency}>{cur.toUpperCase()}</option>)}</select></div>;
export const Catalogue = ({ entries, currency, currencies }: { entries: StoreEntry[]; currency: string; currencies: string[] }) => <>
  <section class="page-intro"><h1>Software that gets to work.</h1><p>Explore RePass Cloud products and choose the licence that fits your use.</p></section>
  {entries.length ? <form method="get" action="/store" class="selection-form catalogue-currency"><CurrencySelect currencies={currencies} currency={currency} /><button class="secondary" type="submit">Show prices</button></form> : <div class="empty-state"><h2>Products are coming soon</h2><p>There are no products available to buy right now.</p></div>}
  <div class="product-list">{entries.map(entry => {
    return <article class="product-entry"><ProductArt imageUrl={entry.imageUrl} name={entry.name} /><div><h2><a data-store-link href={`${entry.href}?currency=${currency}`}>{entry.name}</a></h2><p>{entry.description || 'Choose an edition to see licence details and pricing.'}</p><p class="muted">{entry.offers.length} licence {entry.offers.length === 1 ? 'option' : 'options'} available</p></div><div class="product-entry-action">{currencies.map(cur => {
      const prices = entry.offers.flatMap(o => o.prices.filter(p => p.currency === cur));
      const lowest = prices.sort((a, b) => (a.unitAmount + Math.round(a.unitAmount * (a.taxRateBps ?? 0) / 10000)) - (b.unitAmount + Math.round(b.unitAmount * (b.taxRateBps ?? 0) / 10000)))[0];
      return lowest ? <p data-price={cur} hidden={cur !== currency}>{prices.length > 1 && lowest.unitAmount > 0 ? 'From ' : ''}<PriceLine {...lowest} /></p> : null;
    })}<a class="button" data-store-link href={`${entry.href}?currency=${currency}`}>Explore product</a></div></article>;
  })}</div>
</>;
/** Labels describe the selected licence using authoritative billing/term data. */
export function licenceLabel(offer: StoreOffer): string {
  const price = offer.prices[0];
  if (offer.billing === 'recurring' && price?.recurringInterval) {
    const count = price.recurringIntervalCount ?? 1;
    if (count === 1) return ({ year: 'Annual', month: 'Monthly', week: 'Weekly', day: 'Daily' }[price.recurringInterval] ?? price.recurringInterval) + ' subscription';
    return `Every ${count} ${price.recurringInterval}s`;
  }
  const component = offer.components[0];
  if (component?.termType === 'fixed_term' && component.termInterval && component.termIntervalCount) {
    return `Fixed term: ${component.termIntervalCount} ${component.termInterval}${component.termIntervalCount === 1 ? '' : 's'}`;
  }
  return 'Perpetual';
}
export function licenceKey(offer: StoreOffer): string {
  const component = offer.components[0]!;
  const recurring = offer.billing === 'recurring';
  const interval = recurring ? offer.prices[0]?.recurringInterval : component.termInterval;
  const count = recurring ? offer.prices[0]?.recurringIntervalCount : component.termIntervalCount;
  return [offer.billing, component.termType, interval ?? '', count ?? ''].join(':');
}
export function selectStoreOffer(offers: StoreOffer[], query: { sku?: string; version?: string; edition?: string }): StoreOffer {
  const requested = offers.find(o => o.sku === query.sku);
  const majors = offers.map(o => o.components[0]!.major);
  const askedVersion = Number(query.version);
  const major = majors.includes(askedVersion) ? askedVersion : requested?.components[0]!.major ?? Math.max(...majors);
  const versionOffers = offers.filter(o => o.components[0]!.major === major);
  const askedEdition = query.edition ?? requested?.components[0]!.editionId;
  const edition = versionOffers.some(o => o.components[0]!.editionId === askedEdition) ? askedEdition : versionOffers[0]!.components[0]!.editionId;
  const choices = versionOffers.filter(o => o.components[0]!.editionId === edition);
  return choices.find(o => o.sku === query.sku) ?? choices.find(o => requested && licenceKey(o) === licenceKey(requested)) ?? choices[0]!;
}
export const ProductToolbar = ({ entry, selected, currency, currencies }: { entry: StoreEntry; selected: StoreOffer; currency: string; currencies: string[] }) => <div class="store-toolbar" data-store-toolbar>
  <div class="field"><label for="licence">Licence type</label><select id="licence" name="sku" form="product-selection" data-licence-picker>{entry.offers.map(o => <option value={o.sku} selected={o.sku === selected.sku} disabled={o.components[0]!.major !== selected.components[0]!.major || o.components[0]!.editionId !== selected.components[0]!.editionId} hidden={o.components[0]!.major !== selected.components[0]!.major || o.components[0]!.editionId !== selected.components[0]!.editionId} data-licence-key={licenceKey(o)} data-major={o.components[0]!.major} data-edition={o.components[0]!.editionId} data-org={String(o.needsOrganisation)} data-min={o.minQuantity} data-max={o.maxQuantity} data-free={String(o.prices.every(p => p.unitAmount === 0))}>{licenceLabel(o)}</option>)}</select></div>
  <div class="field"><label for="currency">Currency</label><select id="currency" name="currency" form="product-selection" data-currency-picker>{currencies.map(cur => <option value={cur} selected={cur === currency}>{cur.toUpperCase()}</option>)}</select></div>
</div>;
export const ProductDetail = ({ entry, selected, currency, csrf, email, country }: { entry: StoreEntry; selected: StoreOffer; currency: string; currencies: string[]; csrf: string; email: string | null; country: string }) => {
  const major = selected.components[0]!.major;
  const majors = [...new Set(entry.offers.map(o => o.components[0]!.major))].sort((a, b) => b - a);
  const editions = [...new Map(entry.offers.map(o => [o.components[0]!.editionId, o.components[0]!])).values()];
  return <>
    <p class="breadcrumb"><a href={`/store?currency=${currency}`} data-store-link>All products</a> / {entry.name}</p>
    <section class="product-heading"><ProductArt imageUrl={entry.imageUrl} name={entry.name} /><div><h1>{entry.name}</h1><p>{entry.description}</p></div></section>
    <div class="product-detail">
      <section class="product-options"><h2>Choose your edition</h2><form id="product-selection" method="get" action={entry.href} class="selection-form" data-product-selector>
        {entry.key.startsWith('bundle:') ? null : <div class="field"><label for="version">Version</label><select id="version" name="version" data-version-picker>{majors.map(v => <option value={String(v)} selected={v === major}>{v}</option>)}</select></div>}
        <div class="field edition-field"><label for="edition">Edition</label><select id="edition" name="edition" data-edition-picker>{editions.map(c => <option value={c.editionId} selected={c.editionId === selected.components[0]!.editionId} disabled={!entry.offers.some(o => o.components[0]!.major === major && o.components[0]!.editionId === c.editionId)} data-versions={entry.offers.filter(o => o.components[0]!.editionId === c.editionId).map(o => o.components[0]!.major).join(',')}>{c.edition}</option>)}</select></div>
        <button class="secondary" type="submit">Update selection</button>
      </form>
      <div aria-live="polite" aria-atomic="true" class="offer-summary">{entry.offers.map(o => <section data-offer-summary={o.sku} hidden={o.sku !== selected.sku}><h3>{o.kind === 'bundle' ? 'Bundle licence' : o.components[0]!.edition}</h3><p class="licence-summary">{licenceLabel(o)}</p><p class="description">{o.description || 'Select this licence for your product.'}</p>{o.components.length > 1 ? <ul>{o.components.map((c: StoreComponent) => <li>{c.name} v{c.major}: {c.edition}</li>)}</ul> : null}{o.prices.map(p => <p class="price" data-price={p.currency} hidden={p.currency !== currency}><PriceLine {...p} /></p>)}</section>)}</div>
      <details class="edition-comparison"><summary>Compare all licence options</summary>{entry.offers.map(o => <article><h3><a data-store-link href={`${entry.href}?sku=${encodeURIComponent(o.sku)}&version=${o.components[0]!.major}&edition=${encodeURIComponent(o.components[0]!.editionId)}&currency=${currency}`}>{o.components[0]!.edition} · {licenceLabel(o)}</a></h3><p>{o.description}</p>{o.prices.map(p => <p data-price={p.currency} hidden={p.currency !== currency}><PriceLine {...p} /></p>)}</article>)}</details>
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
