import { expect, it } from 'vitest';
import { Layout } from '../../src/views/layout.tsx';
it('groups account controls together and puts payment attribution in the footer', async () => {
  const html = await Layout({ title: 'Portal', realm: 'customer', who: 'buyer@example.test' })!.toString();
  expect(html).toContain('class="account-controls"');
  const main = html.split('<main')[1]!.split('</main>')[0]!;
  expect(main).not.toContain('Payment is processed');
  const footer = html.split('<footer')[1]!;
  expect(footer).toContain('Payment is processed');
  expect(footer.match(/href="https:\/\/repasscloud.com"/g)).toHaveLength(1);
});
