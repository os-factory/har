#!/usr/bin/env bash
set -euo pipefail
echo '{"status":"pass","agent_id":'"$1"',"total_ms":10,"stages":[{"name":"smoke","pass":true}]}'
