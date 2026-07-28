# Pokémon statechart example

A standalone React and Vite application demonstrating parent, child, parallel,
and invoked Effect machines with a live PokéAPI integration.

This project intentionally installs `@typeonce/effect-machine@0.1.0` from npm.
It does not use the repository's local source or a workspace dependency.

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
