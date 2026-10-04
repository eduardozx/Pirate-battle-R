# ⚓ Pirate Battle

> **Shooter naval 2D com visão superior** — React + TypeScript + PixiJS, simulado em tempo real, com ranking e histórico persistidos via **TanStack Query + Axios + MSW**.

![stack](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=black)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat&logo=typescript&logoColor=white)
![pixi](https://img.shields.io/badge/PixiJS-render-EE1D1D?style=flat&logo=pixi.js&logoColor=white)
![tests](https://img.shields.io/badge/testes-271%20verdes-22C55E?style=flat)
![tests](https://img.shields.io/badge/lint-0%20erros-EAB308?style=flat)

---

## 📑 Sumário

- [✨ Destaques](#-destaques)
- [🚀 Setup](#-setup)
- [🎛️ Comandos](#️-comandos)
- [🕹️ Controles](#️-controles)
- [⚙️ Options](#️-options)
- [🏆 Ranking & Match History](#-ranking--match-history)
- [🌊 Cenários de rede](#-cenários-de-rede)
- [🏴 Regras de gameplay](#-regras-de-gameplay)
- [🧪 Testes](#-testes)
- [📊 Performance](#-performance)
- [🧵 A costura de teste](#-a-costura-de-teste)
- [🔍 Lint & tipos](#-lint--tipos)
- [🌍 Variáveis de ambiente](#-variáveis-de-ambiente)
- [🚢 Deploy](#-deploy)
- [🗂️ Estrutura do projeto](#️-estrutura-do-projeto)
- [📐 Documentação](#-documentação)
- [⚠️ Limitações conhecidas](#️-limitações-conhecidas)

---

## ✨ Destaques

- 🏝️ **Arena com ilhas sólidas** — navios e projéteis colidem de verdade; a ilha *para* o casco, não o deixa atravessar.
- 🎯 **Dois inimigos com IA distinta** — `Chaser` persegue e explode no impacto; `Shooter` aproxima e dispara dentro do alcance.
- ⏱️ **Simulação independente de FPS** — tempo contínuo com substeps, verificado em **30/60/144 fps**.
- 🧩 **Estado de combate fora do React** — a simulação nunca re-renderiza o React por frame; a UI recebe snapshots.
- 🗄️ **Ranking e histórico reais (mockados)** — Axios + TanStack Query + MSW, com loading, vazio, erro, retry, cache e **recuperação de registro pendente após refresh**.
- 🎮 **Controles de teclado e de toque** — dá pra navegar e disparar ao mesmo tempo, nos dois formatos.
- ✅ **271 testes verdes** (147 unit + 124 E2E) e lint sem nenhum problema.

---

## 🚀 Setup

```bash
git clone git@github.com:eduardozx/Pirate-battle-R.git
cd Pirate-battle-R
npm install        # ou: npm ci  (respeita o lockfile)
npm run dev        # http://localhost:5173
```

> ☝️ Não tem backend nem segredos: o MSW responde `/api/*` **dentro do navegador**, em dev e em produção.

---

## 🎛️ Comandos

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor dev com HMR + React StrictMode |
| `npm run build` | Typecheck (`tsc -b`) + bundle de produção |
| `npm run build:profile` | Mesmo bundle **com o profiler compilado** (é o que `measure:prod` mede) |
| `npm run preview` | Serve o build de produção localmente |
| `npm run typecheck` | Só tipos, sem emitir nada |
| `npm run lint` | ESLint sobre `src`, `tests`, `scripts` e configs |
| `npm test` | 147 testes de regras (headless, sem DOM) |
| `npm run test:e2e` | Suíte Playwright completa (sobe o dev server sozinha) |
| `npm run test:e2e:ui` | Playwright em modo interativo |
| `npm run test:e2e:report` | Abre o último relatório HTML |
| `npm run test:visual` | Só as baselines visuais (menu, arena, resultado) |
| `npm run measure` | Performance contra o dev server |
| `npm run measure:prod` | `build:profile` → `vite preview` → mede **aquilo** |

---

## 🕹️ Controles

| Tecla | Ação |
| --- | --- |
| `W` / `↑` | Avançar |
| `A` `D` / `←` `→` | Girar |
| `Space` | **Tiro frontal** (1 projétil) |
| `Q` | **Broadside esquerda** (3 projéteis paralelos) |
| `E` | **Broadside direita** (3 projéteis paralelos) |
| `P` / `Esc` | Pausar |

Navegar, girar e atirar são **independentes** — dá pra fazer tudo ao mesmo tempo.

### 📱 Controles de toque

- Em dispositivo com touch, o **pad virtual aparece sozinho** (movimento + rotação) ao lado dos botões de tiro.
- A arena é **landscape-only**: em retrato, aparece o pedido de rotação.
- O projeto Playwright `mobile` roda a suíte inteira num viewport de celular — e foi ele que pegou um overflow real de layout (corrigido com `align-items: safe center`).

---

## ⚙️ Options

| Opção | Faixa | Padrão |
| --- | --- | --- |
| **Game session time** | 60 – 180 s | 60 s |
| **Enemy spawn time** | positivo, com limites documentados | — |

- ✅ Validação na tela, com mensagens claras.
- ✅ Persiste em `localStorage` e **sobrevive a refresh**.
- ✅ Cada partida tira um **snapshot** da configuração ao começar — mudanças depois valem só pra próxima.
- ❌ **Partida abandonada não entra** no ranking nem no histórico.

---

## 🏆 Ranking & Match History

- Abas no menu principal, com **contratos tipados** para os dois recursos.
- **Axios** nas chamadas, **TanStack Query** nas consultas e no registro.
- Estados tratados: *loading*, *vazio*, *erro*, *atualização em segundo plano*, *cache*, *invalidação* e *retries*.
- Duas abas atualizam juntas após registrar uma partida e ao voltar a exibi-las.
- **Respostas atrasadas nunca sobrescrevem dados mais recentes** (há teste específico).
- Paginação nas duas abas; outros jogadores vêm de **fixtures**.
- Critério de desempate **determinístico** para empates com a mesma configuração.

---

## 🌊 Cenários de rede

Para testar os estados de falha **sem depender da sorte**:

| Cenário | Efeito |
| --- | --- |
| `ok` | Resposta normal e rápida |
| `timeout` | A requisição estoura o tempo |
| `server-error` | HTTP 500 |
| `slow` | Atraso proposital (mostra o loading) |
| `out-of-order` | Resposta chega **depois** de uma mais nova |
| `flaky` | Falha na primeira, sucesso na segunda (mostra o retry) |

- 🎛️ **Seleção** pelo painel de cenários na tela principal.
- 🧹 **`Reset mock state`** limpa o banco mockado (rankings e históricos) — é o botão pra recomeçar do zero.
- Os cenários são **dirigidos por seed**: o mesmo cenário falha no mesmo instante em qualquer máquina.

---

## 🏴 Regras de gameplay

| Item | Regra |
| --- | --- |
| Pontuação | **+1** por inimigo abatido pelos seus ataques |
| Chaser que se autodestrói | **não** pontua |
| Fim da partida | tempo **ou** vida do jogador a zero |
| No encerramento | movimento, ataques, dano, spawns e contagem **param na hora** |
| Reiniciar | vida, pontuação, cronômetro e entidades **restaurados do zero** |
| Vida | limitada; dano de projétil inimigo **e** de colisão com Chaser |
| Arena | água + ilhas que bloqueiam navios **e** projéteis |
| Projéteis | direção, velocidade, dano e alcance/vida; **1 dano por projétil**, removido ao acertar alvo/obstáculo, expirar ou sair da arena |
| Cooldowns | cada arma respeita o **seu** intervalo |
| Pausa | manual + automática ao perder foco/ocultar aba; **nenhum tempo acumulado** do período pausado |
| HUD | vida acima de **cada** navio (jogador e inimigos) + pontuação + tempo |

### ⚡ Power-ups

Soltos por inimigos, com pool de objetos e raio de coleta configurável — ver [`ARCHITECTURE.md`](./ARCHITECTURE.md) §12 para a tabela de balanceamento.

---

## 🧪 Testes

```bash
npm test                    # 147 testes de regras
npm run test:e2e            # 124 E2E: 62 desktop + 62 mobile
npm run test:e2e:report     # relatório HTML do último run
```

| Suíte | Resultado |
| --- | --- |
| 🧠 Unit (Vitest) | **147 / 147** |
| 🎭 E2E (Playwright) | **120 passed + 4 skipped** (os 4 são os specs de toque no desktop) |
| 📸 Baselines visuais | 14 screenshots versionados (menu, arena, resultado × 2 viewports) |
| 🔍 ESLint | **0 erros, 0 avisos** |
| 🧑‍💻 Checkout limpo | `git clone` + `npm ci` + tudo acima ✅ |

### 🐛 Reproduzindo uma falha

```bash
# um arquivo só, com log linear
npm run test:e2e -- tests/e2e/combat.spec.ts --reporter=line

# um teste específico, num projeto
npm run test:e2e -- tests/e2e/combat.spec.ts -g "cooldown" --project=desktop

# modo interativo / headed
npm run test:e2e -- tests/e2e/controls.spec.ts --headed
npm run test:e2e:ui
```

Falhou? A evidência fica em `test-results/`: **screenshot, vídeo e trace**.
Abra com:

```bash
npx playwright show-trace test-results/<arquivo>.zip
```

Cada roda também gera um **relatório HTML autocontido** em `playwright-report/`.
O resumo legível versionado está em [`docs/TEST-REPORT.md`](./docs/TEST-REPORT.md),
com o **mapeamento dos 12 itens exigidos do §8** para os specs que os provam.

**Por que dá pra confiar:** cenários de rede com seed · assert em **tempo de simulação**, não de parede · instrumentação **somente leitura** (snapshot + contadores + relógio: nada de spawn/dano/teleporte) · cada teste parte de estado isolado · `workers: 2` de propósito (4 estrelam os contextos WebGL).

---

## 📊 Performance

```bash
npm run measure        # dev server
npm run measure:prod   # build otimizado (build:profile → vite preview)
```

| | 🔧 dev | 📦 **otimizado** |
| --- | --- | --- |
| Pior custo de frame (p99) | 3,5 ms | **3,0 ms** (orçamento 16,67 ms) |
| Pior frame único | 7,6 ms | **4,0 ms** → 4,2× de folga |
| Partida de **3 minutos** | entidades 6/11 · p95 1,3 ms | **11,4 fps · frame p95 100 ms · 11 entidades no pico · p95 1,3 ms · 8,3× de folga** |
| Heap em 5 ciclos de entrada/saída | −3,33 MB | **−1,43 MB** |
| Erros de página | 0 | **0** |

> 📌 **Sobre o fps:** este container **não tem GPU** — o Chromium rasteriza em software (~100 ms entre frames). Por isso o número que importa é o **custo de CPU por frame**, que fica 5–10× dentro do orçamento de 60 fps. O p95 do tempo entre frames está registrado mesmo assim, com a causa explicada.

Método, hardware, navegador, resolução, **configuração das partidas medidas** e limitações: [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md).
Saídas brutas: [`docs/reports/`](./docs/reports/).

---

## 🧵 A costura de teste

Testes que precisam de partida final usam `?sessionSeconds=6`, `?powerUpPickupRadius=5000` etc. — tudo atrás de `import.meta.env.DEV`.

**Verificado, não assumido** — no build de produção a costura está *fora* do bundle:

```bash
npm run build
grep -o '__pbTest\|__pbProfile\|get("sessionSeconds")' dist/assets/*.js
# imprime nada
```

`npm run build:profile` é a exceção deliberada: mantém **só o profiler** (é assim que medimos CPU e entidades num bundle de produção) — o hook de teste continua fora.

---

## 🔍 Lint & tipos

```bash
npm run typecheck   # strict + noUncheckedIndexedAccess
npm run lint        # 0 erros / 0 avisos
```

O ESLint cobre regras de React, hooks, import e **`set-state-in-effect`** — e roda sem nenhum `eslint-disable` global.

---

## 🌍 Variáveis de ambiente

Nenhum segredo, nenhum backend pra apontar: o MSW responde tudo no navegador.

| Variável | Lida por | Significado |
| --- | --- | --- |
| `CI` | `playwright.config.ts` | Perfil de CI: 1 retry, proíbe `test.only`, reporter HTML e dev server iniciado pelo Playwright |
| `NODE_ENV` | Vite, React | `production` no `npm run build` |
| *(não é env)* `DEV` | `import.meta.env.DEV` |Fecha **toda** costura de teste |
| *(não é env)* `PROFILE` | `import.meta.env.PROFILE` | `true` **só** em `vite build --mode profile` |

---

## 🚢 Deploy

O `npm run build` gera um bundle **estático** em `dist/` — sem backend, porque o MSW responde `/api/*` de dentro do navegador (worker em `public/`). Qualquer host estático serve.

```bash
# Vercel (projeto já linkado em .vercel/)
npx vercel login
npx vercel --prod

# ou Netlify / Cloudflare Pages apontando pra dist/
```

Sem variáveis de ambiente obrigatórias. ✅ A versão publicada joga, persiste opções, registra partidas e mostra ranking/histórico — e `?sessionSeconds=6` publicado **não** encurta a partida.

---

## 🗂️ Estrutura do projeto

```
src/
├── game/            # motor: simulação, colisão, IA, spawns, pooling
│   ├── core/        # ciclo de frame, substeps, profiler
│   └── ...
├── render/          # PixiJS: arena, navios, projéteis, efeitos, barras de vida
├── ui/              # React: menu, options, HUD, pausa, resultado, abas
├── store/           # opções, HUD, estado de partida
├── records/         # Axiox + TanStack Query + contratos tipados
└── mocks/           # MSW: handlers, fixtures, cenários de falha

tests/
├── unit/            # 147 testes de regras (Vitest)
└── e2e/             # 13 specs + baselines (Playwright, desktop + mobile)

docs/
├── TEST-REPORT.md   # relatório de testes (§8)
├── PERFORMANCE.md   # método + números (§9)
├── PROGRESS.md      # portões e defeitos encontrados
└── reports/         # artefatos: HTML report + saídas brutas
```

---

## 📐 Documentação

| Arquivo | Conteúdo |
| --- | --- |
| [`README.md`](./README.md) | Este arquivo — setup, comandos, controles, limitações |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | React ↔ PixiJS, ciclo da simulação, colisões, ciclo de vida de recursos, persistência local, ranking/histórico (contratos, cache, registro pendente), limitações e balanceamento |
| [`docs/TEST-REPORT.md`](./docs/TEST-REPORT.md) | Relatório de testes: resultado, mapeamento do §8, como reproduzir |
| [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) | Performance: método, hardware, números, o que eles provam e o que não provam |
| [`docs/PROGRESS.md`](./docs/PROGRESS.md) | Estado por bloco, portões de verificação, defeitos encontrados e corrigidos |

---

---

Feito com 💙 e um pouco de ⚓ — divirta-se navegando!
