#!/bin/bash
# Run as root on cc-live (NOT cc-staging -- staging does not need
# the Linux user separation since no real keys are present)
# Creates knoxis-council user, sets up DB read-only access,
# ensures private key files are not readable by it.
set -euo pipefail
id knoxis-council 2>/dev/null || useradd -r -s /bin/false knoxis-council
id knoxis-trader  2>/dev/null || useradd -r -s /bin/false knoxis-trader
mkdir -p /var/lib/knoxis/keys
chmod 700 /var/lib/knoxis/keys
chown knoxis-trader:knoxis-trader /var/lib/knoxis/keys
mkdir -p /var/lib/knoxis
touch /var/lib/knoxis/council_proposals.json
chown knoxis-trader:knoxis-council /var/lib/knoxis/council_proposals.json
chmod 660 /var/lib/knoxis/council_proposals.json
# SQLite ACL: trader writes, council reads
touch /var/lib/knoxis/knoxis-limitless.db
chown knoxis-trader:knoxis-council /var/lib/knoxis/knoxis-limitless.db
chmod 640 /var/lib/knoxis/knoxis-limitless.db
echo "Setup complete. Verify:"
echo "  ls -la /var/lib/knoxis/keys/      (should be 700, knoxis-trader)"
echo "  ls -la /var/lib/knoxis/*.db       (should be 640)"
echo "  ls -la /var/lib/knoxis/*.json     (should be 660)"
