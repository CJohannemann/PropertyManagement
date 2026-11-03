#!/usr/bin/env python3
"""
Adds any `location` block from deploy/nginx-property-management.conf that
the live nginx site is missing — without touching anything else in it.

    sudo python3 deploy/sync-nginx-locations.py            # show what's missing
    sudo python3 deploy/sync-nginx-locations.py --apply    # add it, test, reload

Why this exists: the live file is copied from the repo once, then certbot
rewrites it in place to add TLS. Blocks added to the repo afterwards never
reach it — and re-copying the repo file would throw away certbot's TLS
lines. That is how /storage/v1/ went missing on the VPS: every photo and
document upload got nginx's "405 Not Allowed".

It only ever ADDS blocks, into the server block that serves HTTPS (the one
certbot gave `listen 443`), just before `location / {` so the more specific
prefixes are declared first. Existing blocks, even ones that differ from the
repo, are left exactly as they are. With --apply it backs the file up, runs
`nginx -t`, and restores the backup if the test fails.
"""
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_CONF = os.path.join(HERE, 'nginx-property-management.conf')
LIVE_CONF = os.environ.get(
    'PM_NGINX_CONF', '/etc/nginx/sites-available/property-management')


def blocks(text):
    """Every top-level-in-server `location ... { ... }` block, keyed by its
    opening line (e.g. 'location /storage/v1/'), with the comment lines
    directly above it kept so the inserted block explains itself."""
    out = {}
    lines = text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = re.match(r'\s*(location\s+[^{]+?)\s*\{', lines[i])
        if not m:
            i += 1
            continue
        key = re.sub(r'\s+', ' ', m.group(1).strip())
        # Comments immediately above.
        start = i
        while start > 0 and lines[start - 1].strip().startswith('#'):
            start -= 1
        depth, j = 0, i
        while j < len(lines):
            depth += lines[j].count('{') - lines[j].count('}')
            j += 1
            if depth == 0:
                break
        out[key] = ''.join(lines[start:j])
        i = j
    return out


def https_server_span(text):
    """(start, end) offsets of the server block that listens on 443, or of
    the only server block if there is no TLS one yet."""
    spans = []
    for m in re.finditer(r'(?m)^\s*server\s*\{', text):
        depth, k = 0, m.start()
        while k < len(text):
            if text[k] == '{':
                depth += 1
            elif text[k] == '}':
                depth -= 1
                if depth == 0:
                    break
            k += 1
        spans.append((m.start(), k))
    tls = [s for s in spans if re.search(r'listen\s+[^;]*443', text[s[0]:s[1]])]
    if tls:
        return tls[0]
    with_root = [s for s in spans if 'location / ' in text[s[0]:s[1]] or 'location /{' in text[s[0]:s[1]]]
    return (with_root or spans or [None])[0]


def main():
    apply = '--apply' in sys.argv
    repo = open(REPO_CONF).read()
    if not os.path.exists(LIVE_CONF):
        sys.exit(f'No live config at {LIVE_CONF} (set PM_NGINX_CONF to point elsewhere).')
    live = open(LIVE_CONF).read()

    span = https_server_span(live)
    if span is None:
        sys.exit('Could not find a server block in the live config.')
    server_text = live[span[0]:span[1]]
    live_keys = set(blocks(server_text))
    missing = {k: v for k, v in blocks(repo).items() if k not in live_keys}

    if not missing:
        print('The live nginx config already has every location block in the repo. Nothing to do.')
        return

    print('Missing from the live config:')
    for k in missing:
        print(f'  {k}')
    if not apply:
        print('\nRun again with --apply to add them.')
        return

    # Insert before `location / {` in the TLS server block, else at its end.
    root = re.search(r'(?m)^[ \t]*location\s+/\s*\{', server_text)
    insert_at = span[0] + (root.start() if root else len(server_text))
    addition = '\n'.join(v.rstrip('\n') + '\n' for v in missing.values()) + '\n'
    updated = live[:insert_at] + addition + live[insert_at:]

    backup = f'{LIVE_CONF}.bak-{time.strftime("%Y%m%d%H%M%S")}'
    shutil.copy2(LIVE_CONF, backup)
    with open(LIVE_CONF, 'w') as f:
        f.write(updated)

    test = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if test.returncode != 0:
        shutil.copy2(backup, LIVE_CONF)
        print(test.stderr)
        sys.exit(f'nginx -t failed — the original config is restored (backup kept at {backup}).')

    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print(f'Added {len(missing)} block(s) and reloaded nginx. Backup: {backup}')


if __name__ == '__main__':
    main()
