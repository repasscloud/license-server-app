/** @jsxImportSource hono/jsx */
export const SiteFooter = () => <footer class="site-footer">
  <div class="footer-content">
    <div class="footer-intro"><a class="footer-brand" href="https://repasscloud.com"><img src="/assets/brand.svg" alt="" width="34" height="34" loading="lazy" />RePass Cloud</a><p>Software licences, billing and account access, together in one place.</p></div>
    <nav class="footer-nav" aria-label="Footer"><h2>Your account</h2><a href="/store">Explore products</a><a href="/portal">Customer portal</a><a href="https://repasscloud.com/contact/">Contact support</a></nav>
    <div class="footer-payments"><h2>Payments</h2><p class="stripe-attribution">Payment is processed by <a href="https://stripe.com" rel="noopener noreferrer"><img src="/assets/stripe.svg" width="60" height="25" alt="Stripe" /></a>.</p><p>Promotion codes can be entered at checkout.</p></div>
  </div>
  <div class="footer-bottom"><span>© {new Date().getUTCFullYear()} RePass Cloud Pty Ltd.</span><nav aria-label="Legal"><a href="https://repasscloud.com/legal/privacy-policy/">Privacy</a><a href="https://repasscloud.com/legal/terms-of-service/">Terms</a><a href="https://repasscloud.com/legal/refund-policy/">Refunds</a></nav></div>
</footer>;
