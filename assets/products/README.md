# Product images

Public images for Stripe products (shown at Stripe Checkout). This repository is public, so once a file is on `main`
its raw URL can go in the catalogue CSV's `_image:url` column:

```text
https://raw.githubusercontent.com/repasscloud/license-server-app/main/assets/products/<file>
```

Use stable, descriptive names, for example `cursedelete-2.png`, and PNG or JPEG at least 600 × 600 px. Replacing a file under
the same name changes the image once Stripe refetches it. A new name plus an `_image:url` update and a re-run of the Stripe
script is more predictable. The license server itself never reads these files. See `stripe-catalogue/README-LICENSE-SERVER.md`.
