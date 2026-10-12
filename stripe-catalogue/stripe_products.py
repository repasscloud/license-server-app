#!/usr/bin/env python3
"""Idempotent Stripe catalogue synchronizer. Python stdlib + optional AWS CLI for R2 images."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = 'https://api.stripe.com/v1'
TRUTHY = {'yes', 'y', 'true', '1'}
FALSY = {'no', 'n', 'false', '0'}


def boolean(value, field):
    value = value.strip().lower()
    if value in TRUTHY: return True
    if value in FALSY: return False
    raise ValueError(f'{field}: use yes or no (received {value!r})')


def api(method, route, key, fields=None, idem=None):
    body = urlencode(fields or []).encode() if method == 'POST' else None
    headers = {'Authorization': f'Bearer {key}', 'Accept': 'application/json'}
    if body is not None: headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if idem: headers['Idempotency-Key'] = idem
    request = Request(BASE + route, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=45) as response:
            return json.load(response)
    except HTTPError as exc:
        try: err = json.load(exc).get('error', {})
        except Exception: err = {}
        raise RuntimeError(f'Stripe HTTP {exc.code}: {err.get("message", exc.reason)}') from exc
    except URLError as exc:
        raise RuntimeError(f'Network error: {exc.reason}') from exc


def save_csv(path, headers, rows):
    # Atomic replacement after each completed row; preserves already-written IDs on later failure.
    fd, temp_name = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.tmp', dir=path.parent, text=True)
    try:
        with os.fdopen(fd, 'w', newline='', encoding='utf-8-sig') as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, lineterminator='\n')
            writer.writeheader(); writer.writerows(rows)
            handle.flush(); os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name): os.unlink(temp_name)


def image_url(row, args, base_dir, dry_run):
    url = row.get('_image:url', '').strip()
    source = row.get('_image:path', '').strip()
    if url and source:
        raise ValueError('Specify _image:url OR _image:path, not both')
    if url:
        if not url.startswith('https://'): raise ValueError('_image:url must begin with https://')
        return url
    if not source: return None
    file = (base_dir / source).resolve()
    if not file.is_file(): raise ValueError(f'Image not found: {file}')
    if not (args.r2_bucket and args.r2_endpoint and args.image_public_base):
        raise ValueError('Local image requires --r2-bucket, --r2-endpoint and --image-public-base; or use _image:url')
    digest = hashlib.sha256(file.read_bytes()).hexdigest()[:16]
    key = 'stripe-books/' + digest + '-' + re.sub(r'[^a-zA-Z0-9._-]+', '-', file.name)
    if not dry_run:
        cmd = ['aws', 's3', 'cp', str(file), f's3://{args.r2_bucket}/{key}', '--endpoint-url', args.r2_endpoint, '--only-show-errors']
        subprocess.run(cmd, check=True)
    return args.image_public_base.rstrip('/') + '/' + quote(key, safe='/')


def product_fields(row, url):
    fields = []
    for key in ['name', 'description', 'tax_code', 'statement_descriptor', 'url', 'unit_label']:
        value = row.get(key, '').strip()
        if value: fields.append((key, value))
    for field in ['active', 'shippable']:
        value = row.get(field, '').strip()
        if value: fields.append((field, 'true' if boolean(value, field) else 'false'))
    if url: fields.append(('images[0]', url))
    for key, value in row.items():
        if key.startswith('_meta:') and value.strip():
            meta_key = key[6:]
            if not meta_key: raise ValueError('Empty metadata key')
            fields.append((f'metadata[{meta_key}]', value.strip()))
    return fields


def unique_key(prefix, csv_path, row, suffix=''):
    identifier = row.get('_meta:sku', '') or row.get('name', '')
    value = f'{csv_path.resolve()}|{identifier}|{suffix}'
    return prefix + '-' + hashlib.sha256(value.encode()).hexdigest()[:40]


def process(row, args, path, key, dry_run):
    name = row.get('name', '').strip()
    if not name: raise ValueError('name is required')
    image = image_url(row, args, path.parent, dry_run)
    fields = product_fields(row, image)
    product_id = row.get('product_id', '').strip()
    action = 'UPDATE' if product_id else 'CREATE'
    if not product_id and not any(k == 'name' for k, _ in fields): raise ValueError('name required')
    if not product_id and not row.get('_meta:sku', '').strip():
        raise ValueError('_meta:sku required for safe create retries')
    print(f'  {action} product: {name}')
    if dry_run: return
    if product_id:
        existing = api('GET', f'/products/{quote(product_id)}', key)
        if existing.get('id') != product_id: raise ValueError('Product ID does not match Stripe')
        api('POST', f'/products/{quote(product_id)}', key, fields)
    else:
        result = api('POST', '/products', key, fields, unique_key('catalogue-product', path, row))
        product_id = result['id']; row['product_id'] = product_id
        save_csv(path, args.headers, args.rows)
        print('    product_id saved:', product_id)

    make_price = boolean(row.get('_price:create', 'no') or 'no', '_price:create')
    if not make_price: return
    amount = row.get('_price:amount', '').strip()
    currency = row.get('_price:currency', '').strip().lower()
    if not re.fullmatch(r'\d+', amount): raise ValueError('_price:amount is required as integer minor units (e.g. 1999)')
    if not re.fullmatch(r'[a-z]{3}', currency): raise ValueError('_price:currency is required, e.g. AUD')
    price_id = row.get('price_id', '').strip()
    if price_id:
        existing = api('GET', f'/prices/{quote(price_id)}', key)
        if existing.get('product') != product_id: raise ValueError('Price belongs to a different product')
        if existing.get('currency') != currency or existing.get('unit_amount') != int(amount):
            raise ValueError('Existing price differs; Stripe price amount/currency are immutable. Create a new price deliberately.')
        print('    price verified:', price_id)
    else:
        price = api('POST', '/prices', key,
                    [('product', product_id), ('currency', currency), ('unit_amount', amount)],
                    unique_key('catalogue-price', path, row, f'{currency}|{amount}'))
        price_id = price['id']; row['price_id'] = price_id
        save_csv(path, args.headers, args.rows)
        print('    price_id saved:', price_id)
    api('POST', f'/products/{quote(product_id)}', key, [('default_price', price_id)])


def main():
    parser = argparse.ArgumentParser(description='Create/update Stripe products and optionally prices from CSV')
    parser.add_argument('csv', type=Path)
    parser.add_argument('--apply', action='store_true', help='Actually call Stripe. Default is validation/dry run')
    parser.add_argument('--r2-bucket', default=os.getenv('STRIPE_IMAGE_R2_BUCKET', ''))
    parser.add_argument('--r2-endpoint', default=os.getenv('STRIPE_IMAGE_R2_ENDPOINT', ''))
    parser.add_argument('--image-public-base', default=os.getenv('STRIPE_IMAGE_PUBLIC_BASE', ''))
    args = parser.parse_args()
    path = args.csv.resolve()
    with path.open('r', newline='', encoding='utf-8-sig') as handle:
        reader = csv.DictReader(handle)
        args.headers = reader.fieldnames or []
        args.rows = list(reader)
    if len(set(args.headers)) != len(args.headers): parser.error('Duplicate CSV column')
    for required in ['product_id', 'price_id', 'name', '_meta:sku']:
        if required not in args.headers: parser.error(f'Missing CSV column: {required}')
    if not args.rows: parser.error('CSV has no products')
    skus = [r['_meta:sku'].strip() for r in args.rows]
    if not all(skus) or len(set(skus)) != len(skus): parser.error('_meta:sku must be nonempty and unique')
    key = os.getenv('STRIPE_SECRET_KEY', '') if args.apply else ''
    if args.apply and not key.startswith(('sk_test_', 'sk_live_', 'rk_test_', 'rk_live_')):
        parser.error('Set STRIPE_SECRET_KEY to a Stripe secret/restricted key')
    if args.apply:
        backup = path.with_suffix(path.suffix + '.bak')
        import shutil
        shutil.copy2(path, backup)
        print('Backup:', backup)
    errors = 0
    for index, row in enumerate(args.rows, 2):
        try:
            print(f'Row {index}:')
            process(row, args, path, key, dry_run=not args.apply)
        except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as exc:
            errors += 1
            print(f'  ERROR: {exc}', file=sys.stderr)
            # No silent retrial of uncertain HTTP outcomes; idempotency keys protect normal create retries.
    print(f'{"DRY RUN" if not args.apply else "APPLIED"}: {len(args.rows)} rows, {errors} error(s)')
    return 1 if errors else 0

if __name__ == '__main__': sys.exit(main())
