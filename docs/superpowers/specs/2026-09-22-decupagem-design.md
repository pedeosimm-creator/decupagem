# decupagem — design

Data: 2026-09-22

## Problema

Pedro é editor de vídeo profissional (rap, casamentos, aftermovies) e sofre pra
achar uma ferramenta boa pra decupagem rápida — revisar fotos e vídeos recém
descarregados de um job, decidir o que manter/descartar/organizar, sem travar
com arquivos pesados. As dores específicas são vídeo em **LOG** (imagem lavada,
difícil julgar foco/exposição) e fotos em **RAW/ARW** (Sony), que a maioria dos
visualizadores genéricos do Windows não abre ou abre devagar.

## Objetivo

App desktop Electron, interface simplificada e focada só nisso: revisar,
decidir (manter/excluir/mover pra pasta), renomear rápido, e opcionalmente já
cortar/reenquadrar sem abrir o editor de vídeo.

## Referência visual

Herda a linguagem visual do `gerenciador-arquivos` existente (Videos/gerenciador-arquivos):
fundo creme (`--bg: #faf8f6`), painéis brancos, acento laranja queimado
(`--accent: #e08a2e`), cantos bem arredondados (22/16/12/9px), blobs
desfocados de fundo, sem chrome nativo do Windows (janela customizada com
controles próprios). Ver [[design-preservar-estetica]] — não achatar essa
estética, ela é aditiva.

## Fluxo geral

1. Usuário abre o app → diálogo/drag-and-drop escolhe **uma pasta** (o job/cartão
   já descarregado no PC). Não é biblioteca persistente — cada sessão é uma pasta.
2. **Tela de grade**: miniaturas de tudo na pasta, com indicador de status.
3. Clicar numa miniatura (ou tecla Enter) abre a **tela de revisão em tela cheia**
   naquele item.
4. Na tela cheia: decide (aprovar / talvez / excluir / mover pra pasta / renomear
   / cortar), navega com setas/atalhos pro próximo item, sem precisar voltar pra
   grade.
5. Pode voltar pra grade a qualquer momento (Esc) pra ver o progresso ou pular
   pra outro ponto.

## Telas

### 1. Grade de visão geral

- Caminho da pasta no topo.
- Chips de filtro: **Todos / Pendentes / Aprovados / Descarte**.
- Linha de progresso: contagem por categoria + % restante.
- Grade de miniaturas, cada uma com uma bolinha de status no canto:
  verde = aprovado, vermelha = já foi pra lixeira, vazia = pendente.
  Vídeos têm um ícone de play sobreposto.
- Geração de miniatura acontece em segundo plano (fila), nunca bloqueia o
  scroll/interação.

### 2. Revisão em tela cheia

- Mídia ocupa quase toda a tela (foto ou vídeo com player nativo).
- Badge com nome do arquivo (canto superior esquerdo) e contador `142/380`
  (canto superior direito).
- Barra de ações fixa embaixo, sempre visível: **Excluir · Talvez · Aprovar ·
  Pasta · Renomear** (+ acesso à ferramenta de corte, fase 2).
- Toggle **"Rec709 simulado"** pra vídeo em LOG: aplica contraste/saturação só
  na visualização (CSS/filtro de player), não mexe no arquivo. Vem ligado por
  padrão em todo vídeo, com botão pra desligar e ver o LOG cru se quiser.
- Navegação: setas esquerda/direita (ou anterior/próximo), Espaço toca/pausa
  vídeo.

### 3. Corte / reenquadramento (Fase 2)

- Aberta pelo botão "Cortar" na revisão.
- Recorte é sempre **livre** (arrasta o retângulo, sem preset de proporção
  travado).
- Para vídeo: duas abas — **"Reenquadrar"** (só o crop) e **"Cortar duração"**
  (linha do tempo com alças de entrada/saída).
- Para foto: só a aba de crop (sem linha do tempo).
- Botão "Exportar" gera um **arquivo novo** ao lado do original
  (`nome_corte.ext`) — o original nunca é sobrescrito.

## Regras de arquivo

| Ação | Efeito |
|---|---|
| Excluir | Move o arquivo pra **Lixeira do Windows** (recuperável, nunca apaga de vez) |
| Aprovar | Move pro subdiretório `Aprovado/` dentro da pasta do job (criado sob demanda) |
| Talvez | Move pro subdiretório `Talvez/` dentro da pasta do job (criado sob demanda) |
| Pasta | Cria ou reusa uma subpasta customizada (nome digitado); pastas já criadas na sessão viram atalho de 1 clique |
| Renomear | Renomeia o arquivo no lugar, mantendo a extensão |
| Cortar (Fase 2) | Gera arquivo novo (`_corte`), não afeta o original nem seu status de revisão |

## Formatos suportados

- **Fotos**: JPG (direto) e **ARW/Sony RAW**.
- **Vídeo**: formatos que o player nativo do Chromium/Electron reproduz
  (H.264/H.265 em MP4/MOV — cobre XAVC S e a maioria das câmeras que gravam
  LOG hoje).
- Fora de escopo por enquanto: outros RAW (CR2/CR3, NEF) — a extração de
  preview é genérica o suficiente pra adicionar depois sem redesenho.

## Arquitetura técnica

- **Electron** (main + preload + renderer), seguindo o mesmo padrão de
  `gerenciador-arquivos` (main.js/preload.js/src).
- **Preview de RAW (ARW)**: extração do preview JPEG embutido no arquivo RAW
  via `exiftool` (binário vendorizado, sem depender de instalação do sistema)
  — evita decodificar o RAW inteiro, é o mesmo truque usado por Photo
  Mechanic/FastRawViewer, e é rápido o bastante pra não travar a grade.
- **Preview de vídeo**: `<video>` nativo do Chromium pra reprodução; thumbnail
  de miniatura extraída via `ffmpeg` (binário estático, `ffmpeg-static` ou
  equivalente) rodando em processo separado (não bloqueia a UI).
- **Cache de thumbnail**: pasta de cache do app (userData do Electron), chave
  = hash do caminho absoluto + data de modificação do arquivo. Reabrir uma
  pasta já revisada é instantâneo porque não regenera o que já existe.
- **Exclusão**: pacote `trash` (mesmo já usado no `gerenciador-arquivos`) pra
  mandar pra Lixeira do Windows em vez de apagar direto.
- **Corte/reenquadramento (Fase 2)**: `ffmpeg` pra crop+trim de vídeo (corte
  rápido com `-c copy` quando possível, caindo pra reencode só se o ponto de
  corte não cair num keyframe); crop de foto via processamento de imagem em
  Node (ex: `sharp`).
- **Sem git**: pasta do projeto não terá controle de versão inicial, seguindo
  o padrão dos apps irmãos (`limpa-apps`, `gerenciador-arquivos`) — sem
  repositório.

## Atalhos de teclado (padrão sugerido, ajustável)

| Tecla | Ação |
|---|---|
| ← / → | Item anterior / próximo |
| A | Aprovar |
| T | Talvez |
| Delete / Backspace | Excluir (lixeira) |
| R | Renomear (abre campo inline) |
| C | Abrir ferramenta de corte (Fase 2) |
| Espaço | Play/pause (vídeo) |
| Esc | Voltar pra grade |

## Fases de entrega

- **Fase 1 (MVP)**: grade com filtros/progresso, revisão em tela cheia,
  aprovar/talvez/excluir/mover-pra-pasta, renomear inline, preview
  ARW+LOG rápido com cache. Resolve a dor principal de decupagem rápida.
- **Fase 2**: ferramenta de corte/reenquadramento (crop livre + trim de
  vídeo), que depende de integração com `ffmpeg` e é natural de validar
  depois que a Fase 1 estiver em uso real.

## Fora de escopo (por enquanto)

- Biblioteca persistente multi-pasta / histórico de jobs.
- Outros formatos RAW além de ARW.
- Renomeação em lote com padrão + numeração (só renomeação individual).
- Presets de proporção no corte (só livre).
- Aplicação de LUT real de câmera no preview (o toggle é uma aproximação de
  contraste/saturação, não color grading correto).
