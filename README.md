# Decupagem

App Windows para revisar, organizar e descartar fotos e vídeos. Suporta RAW, formatos comuns e prévias de vídeo.

Na grade, os cartões mantêm a altura correta mesmo com muitas fotos. No visualizador, **Esquerda** e **Direita** giram fotos JPEG, TIFF, HEIC e RAW em passos de 90°: a orientação EXIF é gravada no próprio arquivo, e a primeira alteração cria ao lado uma cópia `.decupagem-original` intacta. PNG, WebP, GIF, BMP, AVIF e ICO não exibem esses botões porque esse método de giro não é confiável nesses formatos. O giro não recodifica os pixels da foto.

**Desaprovar** (Del) move a foto ou vídeo para a pasta `Desaprovadas` sem apagar. A pilha permanece entre sessões e pode ser revisada ou devolvida aos pendentes (U). No filtro Desaprovadas, **Excluir desaprovadas** pede confirmação e envia somente essa pilha à Lixeira do Windows. A prévia RAW respeita a orientação EXIF original sem mudar o arquivo de câmera.

Em computadores com vários monitores, a janela principal abre no monitor mais à esquerda. Os testes automatizados não mostram janela nem tomam foco da tela.

## Hub Pedro

O Hub identifica o app como `decupagem`, instala em `%LOCALAPPDATA%\Programs\Decupagem` e procura a última release do repositório configurado no `apps.json`. O ativo deve se chamar **`decupagem.zip`** e conter, na raiz, `decupagem.exe`, `versao.txt` e as dependências do Electron em `resources/app`.

Hoje o código e as releases estão no mesmo repositório público `pedeosimm-creator/decupagem`. O script abaixo usa esse endereço por padrão para manter os Hubs já instalados funcionando. A separação em código privado e releases públicas exige criar `decupagem-releases` e atualizar o catálogo distribuído pelo Hub.

## Publicar uma atualização

1. Atualize a versão em `package.json` e `package-lock.json` para `X.Y.Z`.
2. Teste o app e faça commit do código.
3. No Windows com Node.js e Git Bash instalados, execute:

```powershell
.\publicar.ps1 -Versao vX.Y.Z          # compila e valida o ZIP, sem publicar
.\publicar.ps1 -Versao vX.Y.Z -Enviar  # cria a release e envia decupagem.zip
```

Se o build já estiver pronto, passe `-PastaBuild .\dist\decupagem-win32-x64`. O script confere a versão, o executável, os arquivos da interface, os caminhos do ZIP e o nome do ativo. Repetir `-Enviar` após uma falha de upload reaproveita o rascunho; uma release já publicada não é sobrescrita. Por padrão, conserva as três releases mais recentes.

O app guarda configurações e prévias em `app.getPath('userData')`, fora da pasta substituída pelo Hub. Fotos e vídeos originais ficam nas pastas escolhidas pelo usuário.
