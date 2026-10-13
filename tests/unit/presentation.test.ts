import { expect, it } from 'vitest';
import { licenceLabel, licenceKey, selectStoreOffer } from '../../src/views/storefront.tsx';
import type { StoreOffer } from '../../src/services/catalogue.ts';
const offer = (billing: string, termType: string, recurringInterval: string | null): StoreOffer => ({ sku: 'long-name', name: 'CurseDelete 2 Business Edition (annual subscription, no device limit)', description: '', billing, kind: 'single', products: '', minQuantity: 1, maxQuantity: 1, needsOrganisation: false, components: [{ slug: 'cd', name: 'CurseDelete', description: '', imageUrl: null, major: 2, edition: 'Business', editionId: 'business', termType, termInterval: null, termIntervalCount: null }], prices: [{ currency: 'aud', unitAmount: billing === 'free' ? 0 : 7900, recurringInterval, recurringIntervalCount: recurringInterval ? 1 : null, taxRateBps: null, taxLabel: null }] });
it('derives concise licence labels from billing and term data, not the long offer name', () => {
  expect(licenceLabel(offer('recurring', 'subscription', 'year'))).toBe('Annual subscription');
  expect(licenceLabel(offer('recurring', 'subscription', 'month'))).toBe('Monthly subscription');
  expect(licenceLabel(offer('free', 'perpetual', null))).toBe('Perpetual');
});

it('resolves separate edition/version choices when the previous SKU no longer matches', () => {
  const community = { ...offer('free', 'perpetual', null), sku: 'community', components: [{ ...offer('free', 'perpetual', null).components[0]!, editionId: 'community', edition: 'Community' }] };
  const annual = { ...offer('recurring', 'subscription', 'year'), sku: 'annual' };
  const monthly = { ...offer('recurring', 'subscription', 'month'), sku: 'monthly' };
  const next = { ...community, sku: 'community-v3', components: [{ ...community.components[0]!, major: 3 }] };
  expect(selectStoreOffer([community, annual, monthly, next], { sku: 'annual', edition: 'community', version: '2' }).sku).toBe('community');
  expect(selectStoreOffer([community, annual, monthly, next], { sku: 'monthly', edition: 'business', version: '3' }).sku).toBe('community-v3');
  expect(selectStoreOffer([community, annual, monthly, next], { sku: 'monthly', edition: 'business', version: '2' }).sku).toBe('monthly');
});

it('distinguishes fixed terms by duration and preserves duration across versions', () => {
  const base = offer('one_time', 'fixed_term', null);
  const days = { ...base, sku: 'days', components: [{ ...base.components[0]!, termInterval: 'day', termIntervalCount: 30 }] };
  const months = { ...base, sku: 'months', components: [{ ...base.components[0]!, termInterval: 'month', termIntervalCount: 12 }] };
  const days3 = { ...days, sku: 'days3', components: [{ ...days.components[0]!, major: 3 }] };
  const months3 = { ...months, sku: 'months3', components: [{ ...months.components[0]!, major: 3 }] };
  expect(licenceLabel(days)).toBe('Fixed term: 30 days');
  expect(licenceLabel(months)).toBe('Fixed term: 12 months');
  expect(licenceKey(days)).not.toBe(licenceKey(months));
  expect(selectStoreOffer([days, months, days3, months3], { sku: 'months', version: '3', edition: 'business' }).sku).toBe('months3');
});
