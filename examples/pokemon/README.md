# Pokémon statechart example

A standalone React and Vite application demonstrating parent, child, parallel,
and invoked Effect machines with a live PokéAPI integration.

This project installs `@typeonce/effect-machine` from the repository root
through a local `file:` dependency. It keeps an independent lockfile and
dependency graph while validating the current library build.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the displayed Vite URL and select **Machine**. The application loads a
random team of six Pokémon. You can select a team member, search by Pokémon
name, replace from a search result, or replace a team member with a random
Pokémon.

Run the complete standalone validation with:

```sh
pnpm check
```
