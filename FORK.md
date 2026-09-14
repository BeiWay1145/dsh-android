# This is a FORK, not the upstream plugin

Upstream: **https://github.com/ZSeven-W/dsh-android** (author: ZSeven-W)
This fork: **https://github.com/BeiWay1145/dsh-android**

## Why this file exists

This repo started life as a clone of upstream `main`, so it carried upstream's
`name`, `version` and `repository` fields verbatim. With a copy also installed
into a DSH profile **and** a rollback copy of the real upstream sitting beside
it, a version-based upgrade check reads all three as the same package — and
reports "upgrade available, rc.6 → rc.8" for a tree that already contains
local commits. Acting on that would silently overwrite this fork.

The identity fields are now distinct on purpose:

| field | value |
|---|---|
| `name` | `@beiway1145/dsh-android` |
| `version` | `0.1.0-rc.8+beiway.1` (build metadata records the upstream base) |
| `repository` | `https://github.com/BeiWay1145/dsh-android.git` |
| `private` | `true` (never publish this as upstream's package) |
| `forkOf` | machine-readable pointer back to upstream |

**Do not compare `version` against upstream's releases.** The suffix says what
this is built ON, not that it matches a release.

## What this fork adds on top of upstream `0.1.0-rc.8`

1. **`android_query` / `android_assert`** — semantic screen reading. The
   screenshot is attached to the tool result through the plugin's own
   attachment/image-block seam, so the CALLING model does the reading. Cost
   lands on the caller's route (inside DSH's meter and prefix cache) instead of
   a second bundled vision service.
2. **Repaired image seam** — delivery was silently dead: the services were
   sampled once at `apply()` time (cordis `ctx.get` returns `undefined` unless
   the providing fiber is already active) and the probe accepted only one of the
   two commit entry points. Now resolved lazily through live getters.
3. **`screenFingerprint`** — a ~130 ms window-state digest, used to avoid
   spending ~2.4 s `uiautomator` dumps that cannot return anything new.
4. **Gated dump retry** — the failure path no longer spends a second full dump
   when a cheap fingerprint proves the screen never moved.
5. **`if_moved` on `android_ui_tree`** — opt-in caching; a repeat read of an
   unmoved screen returns the cached tree with `cached: true` and spends no
   dump. Default off, so existing behaviour is unchanged.

Six commits, all on top of upstream `bbcf60d` + `209c0f6`.

## Upgrading

Upstream remains the source of truth for `dsh-android`'s feature work. When
upstream moves:

```bash
git fetch origin main
git rebase origin/main      # this fork's commits replay on top
```

If a rebase conflicts in `src/uitree.ts`, check whether upstream has landed its
own fix for the same thing — `bbcf60d` already anchored the dump on
`<hierarchy>` (issue #6), which is why this fork no longer carries that patch.
