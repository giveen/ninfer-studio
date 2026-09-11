# Serve-args parity fixtures

Shared contract between the two engine launch-arg builders. Both MUST produce
byte-identical `argv` for every profile in `canonical-profile.json`:

| Side | Builder | Enforced by |
|---|---|---|
| TS (sidecar / dev) | `apps/sidecar/serve-args.js` `buildServeArgs(profile)` | `node scripts/args-parity.mjs` (CI: **CI / Sidecar + args parity**) |
| Rust (desktop control plane) | `desktop/control/src/types.rs` `build_serve_args(...)` | `cargo test -p ninfier-control` (CI: **CI / Rust control**) |

- `canonical-profile.json` — the input profiles both builders are run against
  (full profile, auto KV capacity, minimal/unset).
- `expected-args.json` — the expected argv per profile. Generated from the TS
  builder; the Rust test asserts against the same file.

## When the builders drift

1. Change the profile(s) and/or a builder.
2. Regenerate the expected argv from the TS side:

   ```sh
   node scripts/args-parity.mjs --update
   ```

3. Review the diff in `expected-args.json` — it is the single source of truth
   both sides are held to.
4. Port any new/changed flag to the OTHER builder so `cargo test` passes too.

Never regenerate without porting: a one-sided update silently breaks the
other side's launches.
