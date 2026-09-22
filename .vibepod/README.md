# The VibePod sandbox

This project is developed inside [VibePod](https://vibepod.dev), which runs the
coding agent in a container. `overlay/` adds this project's tooling to that
container.

## Why anything is here at all

The pod is rebuilt from its base image every time it starts, and there is no
`sudo` inside it. Two consequences follow, and the second is the one that bites:

1. A tool installed by hand from inside the pod is gone at the next start.
2. On a machine that has never run this project, it was never there to begin
   with — so "I installed it once" is not a state anyone else, or you on a new
   laptop, ever reaches.

`overlay/Dockerfile` is a `FROM`-less fragment VibePod appends to the agent's
base image, with `overlay/` as the build context. It is committed, so the
toolchain arrives with the checkout.

Note the split: **binaries** belong in the image, **Claude's own configuration
does not**. `CLAUDE_CONFIG_DIR` is `/claude`, a mount from the host, and the
mount covers whatever the image put there.

## What it installs, and why those four

Everything here is already required by `Taskfile.yml` or `AGENTS.md`, and none
of it is in the base image:

| tool   | needed for                                                        |
| ------ | ----------------------------------------------------------------- |
| `gh`   | reading and merging pull requests without leaving the pod          |
| `task` | `task check`, `task fix` — the documented entry point to everything |
| `uv`   | `task pull`, which fetches the latest swim from Garmin Connect     |
| `prek` | the git hook that refuses to commit an unscrubbed `.fit`           |

`prek` is the one worth arguing for. `task setup` prints a loud warning and
carries on when it is missing, which means the guardrail against committing a
watch serial number is absent exactly when nobody is looking at the output.

Plus `chromium`, from apt rather than aqua — see below.

## Driving the site in a real browser

`chromium` is installed with apt, not listed in `aqua.yaml`, and the reason is
worth writing down because the question comes up every time: aqua installs one
release binary per package, and a browser is not one binary. It needs around
twenty system shared libraries — `libglib`, `libnss3`, `libasound`, `libgbm` —
and nothing aqua does can place those. Debian's `chromium` package names every
one of them as a dependency, which makes that single package Playwright's
entire system-dependency list, and leaves a browser behind rather than a 115 MB
browser download on every pod start.

Playwright is not in the image, because it is an npm package and this project
keeps Biome as its only dev dependency. Install it outside the repository and
point it at the browser already there:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright
node -e "
  const { chromium } = require('playwright');
  chromium.launch({ executablePath: process.env.CHROME_PATH }).then(async b => {
    const p = await b.newPage();
    await p.goto('http://localhost:8080/?demo=1');
    await p.screenshot({ path: 'shot.png' });
    await b.close();
  });
"
```

`task web` serves the built site on :8080 first.

## How it installs them

Through [aqua](https://aquaproj.github.io), one pinned version per tool in
`overlay/aqua.yaml`. Three things that buys over four `curl | tar` blocks:

- the right build per architecture, so the same fragment works on an arm64 Mac
  and an amd64 one;
- checksums and GitHub artifact attestations verified against the registry;
- one place where the versions are written down, rather than four URLs.

aqua itself is verified against its release checksums — nothing else would —
and then `aqua cp` copies the real executables into `/usr/local/bin`, so aqua
does not ship in the final image. `aqua install` is deliberately not used: it
writes shims that fetch on first use, at runtime, for a tool the image is
supposed to already have.

## Changing it

Edit `overlay/aqua.yaml`, restart the pod. VibePod hashes the overlay directory,
so an edit rebuilds and an unchanged directory reuses the cached image.

```sh
uvx vibepod run claude --rebuild-overlay   # force a rebuild
uvx vibepod run claude --no-overlay        # start from the plain base image
```

Bumping a version by hand is fine; find the current one with
`gh release view --repo cli/cli --json tagName`.
