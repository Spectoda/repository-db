# repository-db — pravidla pro agenta

Public engine `@spectoda/repository-db`. Repo je veřejné; platí tvrdá hranice
obsahu.

## Hranice

- Engine drží jen generickou Git-backed YAML mechaniku: config kontrakt,
  boundary guard, collections CRUD, status model, publish/conflict lifecycle,
  generated manifest policy, credential preflight.
- Sem nikdy nepatří Spectoda business data, doménová schémata (Deals, Products,
  …), secrets, tokeny, interní URL ani zákaznické hodnoty. Doménové schéma
  žije v owner modulu aplikace (pilot: `modules/deals/app/v3`), později jako
  samostatný schema package (`@spectoda/deals-data-schema`).
- Testy používají výhradně syntetické fixture repo v temp adresáři; žádná
  reálná data.

## Invarianty enginu

- Každá Git operace běží přes `git -C <mountRoot>` a před ní platí boundary
  guard: mount = repo root, origin = `data_repo.remote`, branch =
  `data_repo.branch`. Operace z parent code repa musí selhat.
- Publish je jediná cesta, kterou engine commituje a pushuje. Drží lock,
  validate, generated manifest check a deterministické Repository-Db-*
  trailery validované parserem (`src/trailers.ts`).
- `git rebase --autostash` nad už načteným `origin/<branch>` umí skončit exit 0
  a přitom nechat konfliktní markery (conflicted autostash apply). Konflikt se
  proto detekuje ze stavu repa (rebase dir, unmerged paths), nikdy jen z exit
  kódu.
- Při aktivním konfliktu jsou writes i publish blokované do explicitního
  `conflict --resolved` / `conflict --abort`.
- Credential preflight nikdy nezapisuje credentials; jen ověřuje externí
  mechanismus (gh, ssh-agent, credential helper) před mutací working tree.

## Vývoj

- Bun-first: `bun test`, `bunx tsc --noEmit`. Žádné dependencies kromě `yaml`.
- V Bunu `spawnSync`/`execSync` nedědí runtime mutace `process.env` — env
  předávej explicitně (`env: { ...process.env }`).
- Změny chování doplň testem ve `tests/` a záznamem v `CHANGELOG.md`.
