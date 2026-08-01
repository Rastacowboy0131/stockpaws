#!/usr/bin/env bash
# Fork test: starts anvil forking Robinhood Chain mainnet, then runs the
# end-to-end execution tests against the fork. No real transactions ever
# leave this machine; everything happens on the local fork.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL="${ANVIL_BIN:-$HOME/bin/anvil}"
RPC_UPSTREAM="${FORK_RPC:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${ANVIL_PORT:-8546}"

if ! "$ANVIL" --version >/dev/null 2>&1; then
  echo "anvil not usable at $ANVIL (set ANVIL_BIN). On glibc<2.29 hosts use the musl/alpine foundry build." >&2
  exit 1
fi

echo "starting anvil fork of $RPC_UPSTREAM on port $PORT ..."
"$ANVIL" --fork-url "$RPC_UPSTREAM" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

# wait for RPC
for i in $(seq 1 30); do
  if curl -s -m 2 -X POST "http://127.0.0.1:$PORT" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q result; then
    break
  fi
  sleep 1
done

RPC_URL="http://127.0.0.1:$PORT" \
EXECUTION_MODE=live \
MASTER_SEED="test test test test test test test test test test test junk" \
node test/fork.test.js
