# Serve-args fixtures

Contract for the single engine launch-arg builder
(`desktop/control/src/types.rs` `build_serve_args`). It MUST produce
byte-identical `argv` for every profile in `canonical-profile.json`,
enforced by `cargo test -p ninfier-control` (CI: **CI / Rust control**).
(The former Node sidecar copy and its `scripts/args-parity.mjs` check are
gone with `apps/sidecar`.)

- `canonical-profile.json` — the input profiles the builder is run against
  (full profile, auto KV capacity, minimal/unset).
- `expected-args.json` — the expected argv per profile. Hand-edit alongside
  intentional builder changes and review the diff: it is the source of truth
  the test holds the builder to.
